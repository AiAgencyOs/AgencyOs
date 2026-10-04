import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { LANDING_DEPLOYER } from '../src/modules/acquisition/adapters.ts';
import { LANDING_TAG, recordLandingArrivalAfterIngest } from '../src/modules/acquisition/landing-arrival.ts';
import { judgeFetchedPage, renderLandingHtml, sha256Hex, versionPrefix, whatsappHref, type LandingContent } from '../src/modules/acquisition/landing-render.ts';
import { deployLandingVersion, runLandingOperations, verifyLandingVersion, type LandingDeployer } from '../src/modules/acquisition/landing.ts';
import { landingProblemWords, LANDING_STATE_WORDS, VERIFICATION_CHECK_LABEL } from '../src/modules/acquisition/landing-vocabulary.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20261021100000_a_landing_page_is_deployed_as_exactly_what_was_approved.sql');
const verifier = read('scripts/verify-acquisition-landing.sql');

const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function ${name}(`);
  assert.ok(start > 0, `${name} is missing`);
  return sql.slice(start, sql.indexOf('\n$$;', start));
};

const VERSION_ID = '0a1b2c3d-1111-4222-8333-444455556666';
const content: LandingContent = {
  headline: 'Websites that bring in enquiries', subheadline: 'Built for <growing> retailers & "shops"',
  benefits: [{ title: 'Fast', text: 'Pages that load quickly on a phone.' }, { title: 'Easy', text: 'Change your own content easily.' }, { title: 'Found', text: 'Clean structure search engines read.' }],
  proof: [{ portfolio_item_id: 'item-1', caption: 'A storefront we rebuilt' }], faq: [{ q: 'How long?', a: 'We estimate after a chat.' }],
  cta_text: 'Chat on WhatsApp', privacy_url: 'https://example.com/privacy', contact_email: 'hello@example.com',
};
const render = (over: Partial<Parameters<typeof renderLandingHtml>[0]> = {}) => renderLandingHtml({ versionId: VERSION_ID, contentHash: 'a'.repeat(64), whatsappNumber: '+14155550100', content, proofLinks: { 'item-1': { title: 'Storefront', url: 'https://example.com/work' } }, ...over });

type Script = { begin?: unknown; record?: unknown; verify?: unknown; version?: Record<string, unknown> | null; waiting?: unknown[]; unverified?: unknown[]; approvalState?: string };
function fakeAdmin(script: Script) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const admin = {
    schema(name: string) {
      return {
        rpc: async (fnName: string, args: Record<string, unknown>) => {
          calls.push({ fn: `${name}.${fnName}`, args });
          if (fnName === 'begin_landing_deploy') return { data: script.begin ?? [{ outcome: 'blocked', reason: 'x', execution_id: null }], error: null };
          if (fnName === 'record_landing_deploy') return { data: script.record ?? [{ outcome: 'recorded' }], error: null };
          if (fnName === 'record_landing_verification') return { data: script.verify ?? [{ outcome: 'verified' }], error: null };
          if (fnName === 'sync_landing_approvals') return { data: 0, error: null };
          return { data: null, error: null };
        },
        from(table: string) {
          const chain: Record<string, unknown> = {};
          let states: string[] = [];
          for (const m of ['select', 'eq', 'not', 'order', 'limit']) chain[m] = () => chain;
          chain.in = (_c: string, v: string[]) => { states = v; return chain; };
          chain.maybeSingle = async () => {
            if (table === 'landing_page_versions') return { data: script.version === undefined ? { id: VERSION_ID, content, whatsapp_number: '+14155550100', public_url: 'https://lp.example.com/x', content_hash: 'a'.repeat(64), page_id: 'page' } : script.version, error: null };
            if (table === 'landing_pages') return { data: { slug: 'x' }, error: null };
            if (table === 'approval_requests') return { data: { state: script.approvalState ?? 'approved' }, error: null };
            return { data: null, error: null };
          };
          chain.then = (resolve: (v: unknown) => void) => resolve({
            data: table === 'landing_page_versions' ? (states.includes('DEPLOYED') ? script.unverified ?? [] : script.waiting ?? []) : [], error: null,
          });
          return chain;
        },
      };
    },
  } as never;
  return { admin, calls };
}

describe('lead generation, slice 9 - a landing page is deployed as exactly what was approved', () => {
  describe('the database', () => {
    test('the hash is derived by a trigger from slug, content, number, address and tracking', () => {
      assert.match(sql, /create trigger landing_version_stamp before insert on crm\.landing_page_versions/);
      const stamp = fn('crm.landing_version_stamp');
      for (const part of ["'slug', p.slug", "'content', new.content", "'whatsapp', new.whatsapp_number", "'url', new.public_url", "'tracking', new.tracking"]) assert.ok(stamp.includes(part), part);
    });

    test('content, number, address and hash are frozen; the state moves only through the doors and never from DRAFT to VERIFIED', () => {
      const guard = fn('crm.landing_version_guard');
      for (const col of ['content', 'whatsapp_number', 'public_url', 'tracking', 'content_hash']) assert.match(guard, new RegExp(`new\\.${col}`), col);
      assert.match(guard, /current_setting\('crm\.landing_write', true\)/);
      assert.match(guard, /old\.state = 'ADMIN_REVIEW'\s+and new\.state in \('DEPLOYING'/);
      assert.match(guard, /old\.state = 'DEPLOYING'\s+and new\.state in \('DEPLOYED', 'ADMIN_REVIEW'\)/);
      assert.doesNotMatch(guard, /old\.state = 'DEPLOYING'\s+and new\.state in \([^)]*'VERIFIED'/, 'DEPLOYING can never jump to VERIFIED');
      assert.match(guard, /old\.state = 'DEPLOYED'\s+and new\.state in \('VERIFIED', 'VERIFY_FAILED'/);
    });

    test('every table is tenant-bound with forced RLS and internal-only reads; the history tables are append-only', () => {
      for (const t of ['landing_pages', 'landing_page_versions', 'landing_deployments', 'landing_verifications']) {
        assert.match(sql, new RegExp(`alter table crm\\.${t} force row level security`), t);
        assert.match(sql, new RegExp(`revoke all on table crm\\.${t} from public, anon, authenticated`), t);
        assert.match(sql, new RegExp(`create trigger freeze_org_${t} before update of organization_id on crm\\.${t}`), t);
        assert.match(sql, new RegExp(`create policy ${t}_select on crm\\.${t} for select to authenticated using \\(organization_id = \\(select core\\.current_organization_id\\(\\)\\) and \\(select core\\.is_internal\\(\\)\\)\\)`), t);
      }
      for (const t of ['landing_deployments', 'landing_verifications']) assert.match(sql, new RegExp(`create trigger ${t}_immutable before update or delete on crm\\.${t}`), t);
      for (const c of ['page_id', 'current_version_id', 'live_version_id', 'version_id', 'execution_id', 'deployment_id', 'approval_request_id', 'supersedes_version_id']) assert.match(sql, new RegExp(`core\\.enforce_parent_org\\('${c}'`), c);
    });

    test('machine doors are the engine\'s alone; person doors need an admin', () => {
      for (const f of ['begin_landing_deploy(uuid, uuid, uuid)', 'record_landing_deploy(uuid, uuid, uuid, text, text, text, jsonb)', 'record_landing_verification(uuid, uuid, jsonb)', 'sync_landing_approvals(integer)', 'record_landing_arrival(uuid, uuid, text, timestamptz)']) {
        const esc = f.replace(/[()]/g, '\\$&');
        assert.match(sql, new RegExp(`revoke all on function crm\\.${esc} from public, anon, authenticated`), f);
        assert.match(sql, new RegExp(`grant execute on function crm\\.${esc} to service_role`), f);
      }
      for (const f of ['create_landing_page', 'add_landing_version', 'check_landing_version', 'submit_landing_version', 'retire_landing_page']) assert.match(fn(`crm.${f}`), /crm\._social_caller_ok\(p_organization_id, true\)/, f);
    });

    test('deploying goes through the governed door and only to the approved address, with the hash of what was sent', () => {
      const begin = fn('crm.begin_landing_deploy');
      assert.match(begin, /crm\.acquisition_decide\(p_organization_id, 'landing_page_deploy'/);
      assert.match(begin, /crm\.begin_governed_execution\(p_organization_id, v\.approval_request_id, 'acquisition_action', v\.id, v\.content_hash, 'landing_page_deploy'/);
      const rec = fn('crm.record_landing_deploy');
      assert.match(rec, /p_deployed_url <> v\.public_url/);
      assert.match(rec, /needs_evidence/);
    });

    test('verification needs all four checks and records every check; DEPLOYED never becomes VERIFIED on its own', () => {
      const body = fn('crm.record_landing_verification');
      for (const k of ['reachable', 'carries_approved_version', 'links_to_approved_whatsapp', 'captures_tracking']) assert.ok(body.includes(`'${k}'`), k);
      assert.match(body, /insert into crm\.landing_verifications/);
      assert.doesNotMatch(fn('crm.record_landing_deploy'), /_landing_set_state\([^)]*'VERIFIED'\)/);
    });

    test('proof must be an active portfolio item of THIS organisation, read at check time', () => {
      const body = fn('crm.check_landing_version');
      assert.match(body, /crm\.portfolio_items i where i\.organization_id = p_organization_id and i\.is_active/);
      assert.match(fn('crm.landing_content_problems'), /testimonials_are_not_supported/);
    });

    test('a Google ad is refused unless its landing page is VERIFIED, at check time and at execution time', () => {
      const edit = /crm\.landing_page_versions lv[\s\S]*lv\.state = 'VERIFIED'/;
      assert.match(fn('crm.check_ad_version'), edit);
      assert.match(fn('crm.begin_ad_apply'), edit);
      assert.match(fn('crm.begin_ad_apply'), /'landing_page_not_verified'/);
    });

    test('the arrival door parses the tag itself, scopes to the organisation, and only ever adds a touchpoint', () => {
      const body = fn('crm.record_landing_arrival');
      assert.match(body, /regexp_match\(coalesce\(p_message, ''\), 'LP-\(\[0-9a-f\]\{8\}\)-\(\[A-Za-z0-9_\]\{1,40\}\)'\)/);
      assert.match(body, /v\.organization_id = p_organization_id and left\(v\.id::text, 8\) = m\[1\]/);
      assert.match(body, /crm\.record_touchpoint\(/);
      assert.doesNotMatch(body, /update crm\.leads|insert into crm\.leads/);
    });
  });

  describe('the page is rendered the same way every time, and says only what was approved', () => {
    test('rendering is deterministic', () => {
      assert.equal(render(), render());
      assert.equal(sha256Hex(render()), sha256Hex(render()));
    });

    test('every piece of content is escaped', () => {
      const html = render();
      assert.ok(html.includes('Built for &lt;growing&gt; retailers &amp; &quot;shops&quot;'));
      assert.doesNotMatch(html, /<growing>/);
      const hostile = render({ content: { ...content, headline: '<script>alert(1)</script>' } });
      assert.doesNotMatch(hostile, /<script>alert/);
    });

    test('the only outbound destination is wa.me with the approved number; there is no form', () => {
      const html = render();
      assert.deepEqual([...html.matchAll(/https:\/\/wa\.me\/(\d+)/g)].map((m) => m[1]), ['14155550100']);
      assert.doesNotMatch(html, /<form/i);
      assert.doesNotMatch(html, /fetch\(|XMLHttpRequest|sendBeacon/);
    });

    test('the button prefills a tag the database can read, and the page carries the approved hash', () => {
      const href = decodeURIComponent(whatsappHref({ versionId: VERSION_ID, whatsappNumber: '+14155550100', content }));
      assert.match(href, LANDING_TAG);
      assert.ok(href.includes(`LP-${versionPrefix(VERSION_ID)}-direct`));
      assert.ok(render().includes(`<meta name="aos-version" content="${'a'.repeat(64)}">`));
    });

    /** Run the page's own inline script against a stub browser, so the attribution tag is tested as the visitor would get it. */
    const clickHref = (search: string): string => {
      const html = render();
      const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
      const anchor = { href: /id="aos-cta"[^>]*href="([^"]*)"/.exec(html)?.[1]?.replaceAll('&amp;', '&') ?? '' };
      new Function('document', 'location', 'URLSearchParams', script)({ getElementById: (id: string) => (id === 'aos-cta' ? anchor : null) }, { search }, URLSearchParams);
      return decodeURIComponent(anchor.href);
    };

    test('in the browser the button carries the ad campaign id the visitor arrived with', () => {
      const href = clickHref('?utm_campaign=777001&gclid=abc');
      assert.ok(href.includes(`LP-${versionPrefix(VERSION_ID)}-777001`));
      assert.equal(href.match(/LP-/g)?.length, 1, 'exactly one tag');
      assert.ok(!href.includes('-direct'), 'the placeholder is replaced, not kept');
      assert.ok(clickHref('?campaignid=555').includes(`LP-${versionPrefix(VERSION_ID)}-555`));
      assert.ok(clickHref('').includes(`LP-${versionPrefix(VERSION_ID)}-direct`), 'a direct visit says so');
    });

    test('the campaign id is cleaned in the browser, so a hostile query string cannot inject into the message', () => {
      const href = clickHref('?utm_campaign=' + encodeURIComponent('12 345<script>&x=1'));
      assert.ok(href.includes(`LP-${versionPrefix(VERSION_ID)}-12345scriptx1`), href);
      assert.match(href, LANDING_TAG);
      assert.ok(clickHref('?utm_campaign=' + 'a'.repeat(100)).includes(`-${'a'.repeat(40)}`));
      assert.ok(!clickHref('?utm_campaign=' + 'a'.repeat(100)).includes('a'.repeat(41)));
    });

    test('a proof item links to the agency\'s own portfolio item and nothing else', () => {
      assert.ok(render().includes('href="https://example.com/work"'));
      assert.doesNotMatch(render({ proofLinks: {} }), /example\.com\/work/);
    });
  });

  describe('what is found at the public address is judged against what was approved', () => {
    const good = () => ({ status: 200, body: render(), contentHash: 'a'.repeat(64), whatsappNumber: '+14155550100', versionId: VERSION_ID });
    test('the page that was sent passes every check', () => {
      assert.deepEqual(judgeFetchedPage(good()), { reachable: true, carries_approved_version: true, links_to_approved_whatsapp: true, captures_tracking: true });
    });
    test('an unreachable page, another version, another number, or a missing tracking script each fail their own check', () => {
      assert.equal(judgeFetchedPage({ ...good(), status: 503 }).reachable, false);
      assert.equal(judgeFetchedPage({ ...good(), contentHash: 'b'.repeat(64) }).carries_approved_version, false);
      assert.equal(judgeFetchedPage({ ...good(), whatsappNumber: '+14155559999' }).links_to_approved_whatsapp, false);
      assert.equal(judgeFetchedPage({ ...good(), body: render().replace('data-aos-capture=', 'data-x=') }).captures_tracking, false);
    });
    test('a second wa.me link to another number fails even when the approved one is present', () => {
      const body = render().replace('</main>', '<a href="https://wa.me/19995550000">x</a></main>');
      assert.equal(judgeFetchedPage({ ...good(), body }).links_to_approved_whatsapp, false);
    });
    test('a body with no marker at all does not carry the version', () => {
      assert.equal(judgeFetchedPage({ ...good(), body: '<html></html>' }).carries_approved_version, false);
    });
  });

  describe('the worker goes only through the governed door', () => {
    const deployer = (over: Partial<LandingDeployer> = {}): { d: LandingDeployer; seen: unknown[] } => {
      const seen: unknown[] = [];
      return { seen, d: { deploy: async (i) => { seen.push(i); return { status: 'deployed', deployedUrl: i.publicUrl }; }, ...over } };
    };
    const fetcherFor = (html: string, status = 200) => async () => ({ status, text: async () => html });

    test('no deployer exists yet, and nothing pretends one does', () => {
      assert.equal(LANDING_DEPLOYER, undefined);
    });

    test('a deploy the door refuses never reaches the host', async () => {
      const { admin, calls } = fakeAdmin({ begin: [{ outcome: 'not_covered', reason: 'state_pending', execution_id: null }] });
      const { d, seen } = deployer();
      const r = await deployLandingVersion(admin, { organizationId: 'org', versionId: VERSION_ID, deployer: d });
      assert.deepEqual(r, { outcome: 'not_proceeding', reason: 'not_covered', why: 'state_pending' });
      assert.equal(seen.length, 0);
      assert.deepEqual(calls.map((c) => c.fn), ['crm.begin_landing_deploy']);
    });

    test('an approved deploy sends the rendered page, records the hash of what was sent, then verifies the public address', async () => {
      const { admin, calls } = fakeAdmin({ begin: [{ outcome: 'proceed', reason: 'first_execution', execution_id: 'ex' }] });
      const { d, seen } = deployer();
      const html = renderLandingHtml({ versionId: VERSION_ID, contentHash: 'a'.repeat(64), whatsappNumber: '+14155550100', content, proofLinks: {} });
      const r = await deployLandingVersion(admin, { organizationId: 'org', versionId: VERSION_ID, deployer: d, fetcher: fetcherFor(html) });
      assert.deepEqual(r, { outcome: 'deployed', verified: true });
      const sent = seen[0] as { html: string; htmlHash: string; publicUrl: string };
      assert.equal(sent.htmlHash, sha256Hex(sent.html));
      const rec = calls.find((c) => c.fn === 'crm.record_landing_deploy');
      assert.equal(rec?.args.p_status, 'executed');
      assert.equal(rec?.args.p_html_hash, sent.htmlHash);
      assert.equal(rec?.args.p_deployed_url, 'https://lp.example.com/x');
      const ver = calls.find((c) => c.fn === 'crm.record_landing_verification');
      assert.deepEqual(ver?.args.p_checks, { reachable: true, carries_approved_version: true, links_to_approved_whatsapp: true, captures_tracking: true });
      assert.ok(calls.findIndex((c) => c.fn === 'crm.record_landing_deploy') < calls.findIndex((c) => c.fn === 'crm.record_landing_verification'));
    });

    test('a page that deployed but does not carry the approved version is DEPLOYED, not verified', async () => {
      const { admin, calls } = fakeAdmin({ begin: [{ outcome: 'proceed', execution_id: 'ex' }], verify: [{ outcome: 'failed' }] });
      const r = await deployLandingVersion(admin, { organizationId: 'org', versionId: VERSION_ID, deployer: deployer().d, fetcher: fetcherFor('<html>old page</html>') });
      assert.deepEqual(r, { outcome: 'deployed', verified: false });
      assert.equal((calls.find((c) => c.fn === 'crm.record_landing_verification')?.args.p_checks as { carries_approved_version: boolean }).carries_approved_version, false);
    });

    test('a host that throws is UNKNOWN (never redeployed blindly); one that refuses is a failure', async () => {
      const thrown = fakeAdmin({ begin: [{ outcome: 'proceed', execution_id: 'ex' }] });
      const r1 = await deployLandingVersion(thrown.admin, { organizationId: 'org', versionId: VERSION_ID, deployer: { deploy: async () => { throw new Error('ECONNRESET'); } } });
      assert.equal(r1.outcome, 'unknown');
      assert.equal(thrown.calls.find((c) => c.fn === 'crm.record_landing_deploy')?.args.p_status, 'unknown');
      const refused = fakeAdmin({ begin: [{ outcome: 'proceed', execution_id: 'ex' }] });
      const r2 = await deployLandingVersion(refused.admin, { organizationId: 'org', versionId: VERSION_ID, deployer: { deploy: async () => ({ status: 'rejected', reason: 'quota' }) } });
      assert.deepEqual(r2, { outcome: 'failed', reason: 'quota' });
    });

    test('a fetch that fails is a recorded, failed verification - never an exception', async () => {
      const { admin, calls } = fakeAdmin({ verify: [{ outcome: 'failed' }] });
      const r = await verifyLandingVersion(admin, { organizationId: 'org', versionId: VERSION_ID, fetcher: async () => { throw new Error('dns'); } });
      assert.equal(r, 'failed');
      assert.equal((calls[0]?.args.p_checks as { reachable: boolean }).reachable, false);
    });

    test('the sweep with no deployer raises an alert for an approved page - it does not fake a deploy', async () => {
      const { admin, calls } = fakeAdmin({ waiting: [{ id: 'v', organization_id: 'org', page_id: 'p', approval_request_id: 'req' }] });
      const sweep = await runLandingOperations(admin, undefined);
      assert.equal(sweep.assisted, 1);
      assert.equal(calls.some((c) => c.fn === 'crm.begin_landing_deploy'), false);
      assert.equal(calls.filter((c) => c.fn === 'core.raise_alert').length, 1);
    });

    test('the sweep re-checks pages that were deployed but are not verified', async () => {
      const { admin, calls } = fakeAdmin({ unverified: [{ id: VERSION_ID, organization_id: 'org' }] });
      const sweep = await runLandingOperations(admin, undefined, fetcherFor('<html></html>'));
      assert.equal(sweep.reverified, 1);
      assert.equal(calls.some((c) => c.fn === 'crm.record_landing_verification'), true);
    });

    test('an approval that is not approved is not deployed', async () => {
      const { admin, calls } = fakeAdmin({ waiting: [{ id: 'v', organization_id: 'org', page_id: 'p', approval_request_id: 'req' }], approvalState: 'pending' });
      await runLandingOperations(admin, deployer().d);
      assert.equal(calls.some((c) => c.fn === 'crm.begin_landing_deploy'), false);
    });
  });

  describe('arrival from a landing page rides on the message without ever losing it', () => {
    const adminWith = (outcome: string | Error) => {
      const calls: Record<string, unknown>[] = [];
      return { calls, admin: { schema: () => ({ rpc: async (_f: string, args: Record<string, unknown>) => { calls.push(args); if (outcome instanceof Error) throw outcome; return { data: [{ outcome }], error: null }; } }) } as never };
    };
    test('a message with no tag costs no database call', async () => {
      const { admin, calls } = adminWith('recorded');
      assert.equal(await recordLandingArrivalAfterIngest(admin, { organizationId: 'o', leadId: 'l', body: 'Hello there', occurredAt: '2026-01-01T00:00:00Z' }), null);
      assert.equal(calls.length, 0);
    });
    test('a tagged message is passed to the door WHOLE, so the database does its own parsing', async () => {
      const { admin, calls } = adminWith('recorded');
      const body = 'Hi, I want a site LP-0a1b2c3d-777001';
      assert.equal(await recordLandingArrivalAfterIngest(admin, { organizationId: 'o', leadId: 'l', body, occurredAt: '2026-01-01T00:00:00Z' }), 'recorded');
      assert.equal(calls[0]?.p_message, body);
    });
    test('a failure is swallowed (and reported as nothing), never thrown into the ingest', async () => {
      const { admin } = adminWith(new Error('boom'));
      const original = console.error;
      console.error = () => undefined;
      try {
        assert.equal(await recordLandingArrivalAfterIngest(admin, { organizationId: 'o', leadId: 'l', body: 'LP-0a1b2c3d-1', occurredAt: '2026-01-01T00:00:00Z' }), null);
      } finally {
        console.error = original;
      }
    });
    test('ingest calls it after the message is recorded, only when ingested', () => {
      const ingest = read('src/modules/crm/ingest.ts');
      assert.match(ingest, /if \(row\.status === 'ingested'\) \{\s*await recordLandingArrivalAfterIngest\(/);
      assert.ok(ingest.indexOf('consumeHandoffAfterIngest(admin') < ingest.indexOf('recordLandingArrivalAfterIngest(admin'));
    });
  });

  describe('the vocabulary covers what the database can say', () => {
    test('every state, check and problem code has words', () => {
      const states = [...(sql.match(/state\s+text not null default 'DRAFT' check \(state in \(([^)]*)\)\)/)?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1] as string);
      assert.ok(states.length >= 12);
      for (const s of states) assert.ok(LANDING_STATE_WORDS[s], s);
      for (const k of ['reachable', 'carries_approved_version', 'links_to_approved_whatsapp', 'captures_tracking']) assert.ok(VERIFICATION_CHECK_LABEL[k], k);
      const codes = [...[fn('crm.landing_content_problems'), fn('crm.check_landing_version')].join('\n').matchAll(/to_jsonb\('([a-z_0-9]+)'(?:::text)?\)/g)].map((m) => m[1] as string);
      assert.ok(codes.length >= 13, `found ${codes.length}`);
      for (const c of codes) assert.notEqual(landingProblemWords(c), c, `${c} has no words`);
    });
  });

  describe('the verifier proves it on a real database', () => {
    test('it drives the approval engine, the governed door and the ad launch gate, and is wired into the verify chain', () => {
      for (const part of ['approvals.decide_approval', 'crm.begin_landing_deploy', 'crm.record_landing_verification', 'crm.begin_ad_apply', 'crm.record_landing_arrival', 'crm.ad_outcomes', 'ALL CHECKS PASSED']) assert.ok(verifier.includes(part), part);
      assert.match(read('package.json'), /verify-acquisition-landing\.sql/);
    });
  });
});
