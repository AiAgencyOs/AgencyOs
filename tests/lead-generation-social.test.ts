import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { SOCIAL_PUBLISHERS } from '../src/modules/acquisition/adapters.ts';
import { publishContent, runSocialPublishing, type SocialPublisher } from '../src/modules/acquisition/social.ts';
import { CONTENT_FORMATS, CONTENT_OBJECTIVES, reviewWords, SOCIAL_PLATFORMS, STATUS_WORDS } from '../src/modules/acquisition/social-vocabulary.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20261019100000_social_content_is_approved_as_exactly_what_is_published.sql');
const social = read('src/modules/acquisition/social.ts');

const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function ${name}(`);
  assert.ok(start > 0, `${name} is missing`);
  return sql.slice(start, sql.indexOf('\n$$;', start));
};
const quoted = (text: string) => [...text.matchAll(/'([A-Za-z_0-9]+)'/g)].map((m) => m[1]);

/** A fake admin client that records every rpc and answers from a script. */
function fakeAdmin(script: { begin?: unknown; record?: unknown; verify?: unknown; version?: Record<string, unknown> | null; due?: unknown[] }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const admin = {
    schema(name: string) {
      return {
        rpc: async (fnName: string, args: Record<string, unknown>) => {
          calls.push({ fn: `${name}.${fnName}`, args });
          if (fnName === 'begin_content_publish') return { data: script.begin ?? [{ outcome: 'blocked', reason: 'x', execution_id: null }], error: null };
          if (fnName === 'record_publish') return { data: script.record ?? [{ outcome: 'recorded' }], error: null };
          if (fnName === 'verify_governed_execution') return { data: script.verify ?? [{ outcome: 'verified' }], error: null };
          if (fnName === 'due_content') return { data: script.due ?? [], error: null };
          return { data: null, error: null };
        },
        from(table: string) {
          const chain = {
            select: () => chain, eq: () => chain, in: () => chain, order: () => chain,
            maybeSingle: async () => ({ data: table === 'content_versions' ? (script.version === undefined ? { body: 'Exact approved words.', cta: 'Book a call', hashtags: ['#web'], asset_ids: [], content_hash: 'a'.repeat(64), item_id: 'item' } : script.version) : { platform: 'linkedin' }, error: null }),
            then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
          };
          return chain;
        },
      };
    },
  } as never;
  return { admin, calls };
}

describe('lead generation, slice 7 - Social content is approved as exactly what is published', () => {
  describe('versions are immutable and their hash cannot be forged', () => {
    test('the hash is derived by a BEFORE INSERT trigger from the content, platform, objective, format and assets', () => {
      assert.match(sql, /create trigger content_version_stamp before insert on crm\.content_versions/);
      assert.match(fn('crm.content_version_stamp'), /new\.content_hash := crm\.content_version_hash\(/);
      const hash = fn('crm.content_version_hash');
      for (const part of ["'platform', i.platform", "'objective', i.objective", "'format', i.format", "'body', p_body", "'cta'", "'hashtags'", "'assets'"]) assert.ok(hash.includes(part), part);
      assert.match(hash, /encode\(sha256\(convert_to\(/);
    });

    test('words, call to action, hashtags, assets, references and hash are frozen; only the workflow state moves, through the doors', () => {
      const guard = fn('crm.content_version_guard');
      for (const col of ['body', 'cta', 'hashtags', 'asset_ids', 'reference_ids', 'content_hash', 'item_id', 'version']) assert.match(guard, new RegExp(`new\\.${col}`), col);
      assert.match(guard, /current_setting\('crm\.content_write', true\)/);
      assert.match(guard, /tg_op = 'DELETE'/);
    });

    test('a version can only be reached in the order the specification gives, and PUBLISHED is a dead end', () => {
      const guard = fn('crm.content_version_guard');
      assert.match(guard, /old\.state = 'DRAFT'\s+and new\.state in \('AI_REVIEWED', 'AI_REVIEW_FAILED', 'SUPERSEDED', 'CANCELLED'\)/);
      assert.match(guard, /old\.state = 'AI_REVIEWED'\s+and new\.state in \('ADMIN_REVIEW', 'SUPERSEDED', 'CANCELLED'\)/);
      assert.match(guard, /old\.state = 'ADMIN_REVIEW'\s+and new\.state in \('SCHEDULED', 'REJECTED', 'SUPERSEDED', 'CANCELLED'\)/);
      assert.match(guard, /old\.state = 'SCHEDULED'\s+and new\.state in \('PUBLISHING', 'SUPERSEDED', 'CANCELLED'\)/);
      assert.doesNotMatch(guard, /old\.state = 'PUBLISHED'/);
      assert.doesNotMatch(guard, /old\.state = 'AI_REVIEW_FAILED'\s+and new\.state in \([^)]*'ADMIN_REVIEW'/, 'a failed review can never reach an admin');
    });

    test('APPROVED is derived from the approval engine, not stored, so it cannot drift from the decision it reports', () => {
      const states = quoted(sql.match(/state\s+text not null default 'DRAFT' check \(state in \(([^)]*)\)\)/)?.[1] ?? '');
      assert.ok(!states.includes('APPROVED'), 'APPROVED must not be a stored state');
      assert.match(fn('crm.content_status'), /crm\.approval_check\(v\.approval_request_id, 'social_content'/);
      assert.match(fn('crm.content_status'), /'APPROVED' else 'APPROVAL_LAPSED'/);
    });

    test('every state and derived label has words for a person', () => {
      for (const key of ['DRAFT', 'AI_REVIEW_PASSED', 'AI_REVIEW_FAILED', 'ADMIN_REVIEW', 'APPROVED', 'APPROVAL_LAPSED', 'REJECTED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'SUPERSEDED', 'CANCELLED']) assert.ok(STATUS_WORDS[key], key);
      assert.match(STATUS_WORDS.AI_REVIEW_PASSED?.meaning ?? '', /not approval/i);
    });
  });

  describe('the review can fail a draft and can never approve one', () => {
    test('it only ever moves a version to AI_REVIEWED or AI_REVIEW_FAILED', () => {
      const body = fn('crm.review_content_version');
      assert.match(body, /case when v_passed then 'AI_REVIEWED' else 'AI_REVIEW_FAILED' end/);
      assert.doesNotMatch(body, /state = 'ADMIN_REVIEW'|state = 'SCHEDULED'|state = 'PUBLISHING'|set state = 'PUBLISHED'|approvals\./, 'the review never sets a later state and never touches the approval engine');
    });

    test('every blocking rule has words, and the rules are the specification\'s', () => {
      const body = fn('crm.review_content_version');
      for (const code of ['too_long_for_platform', 'missing_cta', 'missing_asset', 'carousel_needs_two_or_more_slides', 'unverified_statistic', 'duplicate_of_recent_post', 'does_not_mention_the_target_service', 'insecure_link', 'no_hashtags']) {
        assert.ok(body.includes(`'${code}'`), `${code} not produced`);
        assert.notEqual(reviewWords(code), code, `${code} has no words`);
      }
      for (const prefix of ['manufactured_urgency:', 'unsupported_claim:', 'copies_reference:']) {
        assert.ok(body.includes(`'${prefix}'`), prefix);
        assert.notEqual(reviewWords(`${prefix}x`), `${prefix}x`, prefix);
      }
      assert.match(body, /v_words\[k:k \+ 9\]/, 'ten-word run');
    });

    test('the SQL and TypeScript vocabularies are the same lists', () => {
      assert.deepEqual(quoted(sql.match(/objective\s+text not null check \(objective in \(([^)]*)\)\)/)?.[1] ?? ''), [...CONTENT_OBJECTIVES]);
      assert.deepEqual(quoted(sql.match(/format\s+text not null check \(format in \(([^)]*)\)\)/)?.[1] ?? ''), [...CONTENT_FORMATS]);
      assert.deepEqual(quoted(sql.match(/create table if not exists crm\.content_items \([\s\S]*?platform\s+text not null check \(platform in \(([^)]*)\)\)/)?.[1] ?? ''), [...SOCIAL_PLATFORMS]);
    });
  });

  describe('publishing goes through the governed door and nowhere else', () => {
    test('a version reaches PUBLISHING only inside begin_content_publish, after the connector, limits, stops and approval are re-read', () => {
      const body = fn('crm.begin_content_publish');
      const decide = body.indexOf('crm.acquisition_decide(');
      const governed = body.indexOf('crm.begin_governed_execution(');
      const setPublishing = body.indexOf("state = 'PUBLISHING'");
      assert.ok(decide > 0 && governed > decide && setPublishing > governed, 'decide, then governed execution, then PUBLISHING');
      assert.match(body, /d\.decision = 'BLOCK' then return query select 'blocked'/);
      assert.equal((sql.match(/set state = 'PUBLISHING'/g) ?? []).length, 1, 'exactly one place sets PUBLISHING');
      assert.ok(body.includes("set state = 'PUBLISHING'"), 'and it is inside begin_content_publish');
    });

    test('scheduling requires an approval that covers exactly this content, and is admin-only', () => {
      const body = fn('crm.schedule_content');
      assert.match(body, /crm\._social_caller_ok\(p_organization_id, true\)/);
      assert.match(body, /crm\.approval_check\(v\.approval_request_id, 'social_content', v\.id, v\.content_hash\)/);
      assert.match(body, /not c\.covered then return query select 'not_approved'/);
    });

    test('submission binds the approval to the version id and its hash, and needs a passed review', () => {
      const body = fn('crm.submit_for_admin_review');
      assert.match(body, /v\.state <> 'AI_REVIEWED' then return query select 'not_reviewed'/);
      assert.match(body, /crm\.bind_approval\(p_organization_id, 'social_content', v\.id, v\.version, v\.content_hash/);
    });

    test('a new version supersedes every earlier unposted one and withdraws any approval waiting on it; nothing changes mid-publication', () => {
      const body = fn('crm.add_content_version');
      assert.match(body, /v\.state = 'PUBLISHING'\) then\s+return query select 'publishing_in_progress'/);
      assert.match(body, /'DRAFT', 'AI_REVIEWED', 'AI_REVIEW_FAILED', 'ADMIN_REVIEW', 'SCHEDULED'/);
      assert.match(fn('crm._withdraw_version'), /approvals\.cancel_request\(v\.approval_request_id/);
    });

    test('a failure returns to SCHEDULED for the governed retry; an unknown outcome stays PUBLISHING; a post is recorded once', () => {
      const body = fn('crm.record_publish');
      assert.match(body, /elsif p_status = 'failed' then[\s\S]*?state = 'SCHEDULED'/);
      assert.match(body, /unknown: stays PUBLISHING/);
      assert.match(sql, /unique \(version_id\)/);
      assert.match(sql, /unique \(organization_id, platform, external_ref\)/);
      assert.match(body, /v\.state <> 'PUBLISHING' then return query select 'wrong_state'/);
    });

    test('the engine\'s doors are service-role only', () => {
      for (const sig of ['crm.begin_content_publish(uuid, uuid, uuid)', 'crm.record_publish(uuid, uuid, uuid, text, text, text, jsonb)', 'crm.record_social_metrics(uuid, uuid, bigint, bigint, bigint, bigint, bigint)', 'crm.sync_content_approvals(integer)', 'crm.due_content(integer)']) {
        const esc = sig.replace(/[().]/g, '\\$&');
        assert.match(sql, new RegExp(`revoke all on function ${esc} from public, anon(, authenticated)?`), sig);
        assert.match(sql, new RegExp(`grant execute on function ${esc} to service_role`), sig);
      }
    });
  });

  describe('the publisher worker', () => {
    test('no publisher exists today, and the worker never calls a provider by any other path', () => {
      assert.deepEqual(Object.keys(SOCIAL_PUBLISHERS), []);
      assert.doesNotMatch(social, /\bfetch\(/);
    });

    const publisher = (result: unknown, verify?: boolean): { p: SocialPublisher; seen: { calls: number; body?: string } } => {
      const seen: { calls: number; body?: string } = { calls: 0 };
      return {
        seen,
        p: {
          publish: async (input) => { seen.calls += 1; seen.body = input.body; if (result instanceof Error) throw result; return result as never; },
          ...(verify === undefined ? {} : { verify: async () => verify }),
        },
      };
    };

    test('it does NOT call the provider unless the governed door says proceed', async () => {
      for (const outcome of ['blocked', 'not_covered', 'already_executed', 'in_progress', 'needs_reconciliation', 'exhausted', 'not_scheduled', 'already_published', 'not_yet_due']) {
        const { admin, calls } = fakeAdmin({ begin: [{ outcome, reason: 'r', execution_id: 'e' }] });
        const { p, seen } = publisher({ status: 'published', externalRef: 'x' });
        const r = await publishContent(admin, { organizationId: 'o', versionId: 'v', publisher: p });
        assert.equal(r.outcome, 'not_proceeding', outcome);
        assert.equal(seen.calls, 0, `${outcome} must not reach the provider`);
        assert.equal(calls.filter((c) => c.fn.endsWith('record_publish')).length, 0, outcome);
      }
    });

    test('it posts the words READ FROM THE VERSION ROW, and records executed with the provider\'s reference', async () => {
      const { admin, calls } = fakeAdmin({ begin: [{ outcome: 'proceed', reason: 'first_execution', execution_id: 'exec-1' }] });
      const { p, seen } = publisher({ status: 'published', externalRef: 'urn:li:share:1', url: 'https://x.example/1' }, true);
      const r = await publishContent(admin, { organizationId: 'o', versionId: 'v', publisher: p });
      assert.equal(seen.body, 'Exact approved words.');
      assert.deepEqual(r, { outcome: 'published', verified: true, externalRef: 'urn:li:share:1' });
      const rec = calls.find((c) => c.fn.endsWith('record_publish'));
      assert.equal(rec?.args.p_status, 'executed');
      assert.equal(rec?.args.p_external_ref, 'urn:li:share:1');
      assert.equal(calls.filter((c) => c.fn.endsWith('verify_governed_execution')).length, 1);
    });

    test('executed is not verified: without a confirming lookup the post stays EXECUTED', async () => {
      const { admin, calls } = fakeAdmin({ begin: [{ outcome: 'proceed', reason: 'x', execution_id: 'e' }] });
      const none = publisher({ status: 'published', externalRef: 'r' });
      assert.equal((await publishContent(admin, { organizationId: 'o', versionId: 'v', publisher: none.p }) as { verified: boolean }).verified, false);
      assert.equal(calls.filter((c) => c.fn.endsWith('verify_governed_execution')).length, 0);
      const { admin: a2, calls: c2 } = fakeAdmin({ begin: [{ outcome: 'proceed', reason: 'x', execution_id: 'e' }] });
      const denied = publisher({ status: 'published', externalRef: 'r' }, false);
      assert.equal((await publishContent(a2, { organizationId: 'o', versionId: 'v', publisher: denied.p }) as { verified: boolean }).verified, false);
      assert.equal(c2.filter((c) => c.fn.endsWith('verify_governed_execution')).length, 0, 'a lookup that did not confirm never records verified');
    });

    test('a provider refusal is FAILED (retry within limits); an adapter exception is UNKNOWN, never failed - it may have gone out', async () => {
      const { admin, calls } = fakeAdmin({ begin: [{ outcome: 'proceed', reason: 'x', execution_id: 'e' }] });
      const refused = publisher({ status: 'rejected', reason: 'duplicate content' });
      assert.deepEqual(await publishContent(admin, { organizationId: 'o', versionId: 'v', publisher: refused.p }), { outcome: 'failed', reason: 'duplicate content' });
      assert.equal(calls.find((c) => c.fn.endsWith('record_publish'))?.args.p_status, 'failed');
      const { admin: a2, calls: c2 } = fakeAdmin({ begin: [{ outcome: 'proceed', reason: 'x', execution_id: 'e' }] });
      const threw = publisher(new Error('socket hang up'));
      const r = await publishContent(a2, { organizationId: 'o', versionId: 'v', publisher: threw.p });
      assert.equal(r.outcome, 'unknown');
      assert.equal(c2.find((c) => c.fn.endsWith('record_publish'))?.args.p_status, 'unknown', 'an exception is never recorded as a failure');
      const { admin: a3, calls: c3 } = fakeAdmin({ begin: [{ outcome: 'proceed', reason: 'x', execution_id: 'e' }] });
      const timeout = publisher({ status: 'unknown', reason: 'no response' });
      await publishContent(a3, { organizationId: 'o', versionId: 'v', publisher: timeout.p });
      assert.equal(c3.find((c) => c.fn.endsWith('record_publish'))?.args.p_status, 'unknown');
    });

    test('if the version cannot be read after the door said proceed, the outcome is recorded as UNKNOWN and nothing is posted', async () => {
      const { admin, calls } = fakeAdmin({ begin: [{ outcome: 'proceed', reason: 'x', execution_id: 'e' }], version: null });
      const { p, seen } = publisher({ status: 'published', externalRef: 'x' });
      const r = await publishContent(admin, { organizationId: 'o', versionId: 'v', publisher: p });
      assert.equal(r.outcome, 'unknown');
      assert.equal(seen.calls, 0);
      assert.equal(calls.find((c) => c.fn.endsWith('record_publish'))?.args.p_status, 'unknown');
    });

    test('a due post with no publisher is flagged for a person (once per post), never skipped silently and never faked as published', async () => {
      const { admin, calls } = fakeAdmin({ due: [{ organization_id: 'o1', version_id: 'ver-1', platform: 'linkedin', scheduled_for: null }] });
      const sweep = await runSocialPublishing(admin, {});
      assert.equal(sweep.assisted, 1);
      assert.equal(sweep.published, 0);
      const alert = calls.find((c) => c.fn === 'core.raise_alert');
      assert.equal(alert?.args.p_fingerprint, 'social-assisted:ver-1');
      assert.match(String(alert?.args.p_summary), /posted by hand/);
      assert.equal(calls.filter((c) => c.fn.endsWith('begin_content_publish')).length, 0, 'it never reached the governed door without a publisher');
      assert.equal(calls.filter((c) => c.fn.endsWith('sync_content_approvals')).length, 1, 'rejected approvals are moved out of the queue each sweep');
    });

    test('an unresolved outcome raises a CRITICAL alert and tells a person to check the platform first', async () => {
      const { admin, calls } = fakeAdmin({ due: [{ organization_id: 'o1', version_id: 'ver-2', platform: 'linkedin', scheduled_for: null }], begin: [{ outcome: 'needs_reconciliation', reason: 'unknown', execution_id: 'e' }] });
      const { p } = publisher({ status: 'published', externalRef: 'x' });
      const sweep = await runSocialPublishing(admin, { linkedin: p });
      assert.equal(sweep.skipped, 1);
      const alert = calls.find((c) => c.fn === 'core.raise_alert');
      assert.equal(alert?.args.p_severity, 'critical');
      assert.match(String(alert?.args.p_summary), /will not post it again/);
    });

    test('a failure inside the sweep is logged and swallowed: it must not take the cron tick down', async () => {
      const broken = { schema: () => ({ rpc: async () => ({ data: null, error: { message: 'boom' } }) }) } as never;
      const sweep = await runSocialPublishing(broken, {});
      assert.deepEqual(sweep, { due: 0, published: 0, failed: 0, unknown: 0, assisted: 0, skipped: 0 });
    });
  });

  describe('references, assets, strategies', () => {
    test('a reference inspires and is never copied; assets and strategies are append-only / versioned', () => {
      for (const t of ['social_audits', 'content_references', 'content_assets', 'social_publications', 'social_metrics']) assert.match(sql, new RegExp(`create trigger ${t}_immutable before update or delete on crm\\.${t}`), t);
      assert.match(fn('crm.social_strategy_guard'), /a strategy''s content is frozen; make the next version/);
      assert.match(sql, /create unique index if not exists social_strategies_one_active on crm\.social_strategies \(organization_id, platform, horizon_months\) where status = 'active'/);
    });

    test('an audit that claims an adapter read the account needs a VERIFIED connection', () => {
      assert.match(fn('crm.record_social_audit'), /p_source = 'adapter' and not exists/);
      assert.match(fn('crm.record_social_audit'), /i\.verification in \('SANDBOX_VERIFIED', 'LIVE_VERIFIED'\)/);
      assert.match(fn('crm.record_social_audit'), /'integration_not_verified'/);
    });

    test('activating a strategy is the admin\'s decision', () => {
      assert.match(fn('crm.activate_social_strategy'), /core\.is_admin\(\)/);
    });
  });

  describe('tenancy', () => {
    test('every new table revokes default privileges, is frozen to its organisation, guards its parents and forces RLS', () => {
      for (const t of ['social_audits', 'social_strategies', 'content_references', 'content_assets', 'content_items', 'content_versions', 'social_publications', 'social_metrics']) {
        assert.match(sql, new RegExp(`revoke all on table crm\\.${t} from public, anon, authenticated`), t);
        assert.match(sql, new RegExp(`create trigger freeze_org_${t} before update of organization_id on crm\\.${t}`), t);
        assert.match(sql, new RegExp(`alter table crm\\.${t} force row level security`), t);
      }
      for (const g of ['content_versions_item', 'content_versions_approval', 'content_items_strategy', 'social_publications_version', 'social_publications_execution', 'social_metrics_publication']) assert.match(sql, new RegExp(`create trigger org_match_${g}`), g);
    });
    test('a version may only use this organisation\'s assets and references', () => {
      assert.match(fn('crm.content_version_stamp'), /a version may only use this organisation''s assets/);
      assert.match(fn('crm.content_version_stamp'), /a version may only cite this organisation''s references/);
    });
  });
});
