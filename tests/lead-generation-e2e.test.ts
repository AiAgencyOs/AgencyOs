import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('lead generation, slice 12 - the whole is verified, not only its parts', () => {
  test('every acquisition verifier is in the verify chain CI runs, and none runs twice', () => {
    const chain = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts['db:verify:acquisition'] ?? '';
    const onDisk = readdirSync(new URL('../scripts/', import.meta.url)).filter((f) => /^verify-acquisition-.*\.sql$/.test(f)).sort();
    const inChain = [...chain.matchAll(/-f scripts\/(verify-acquisition-[a-z0-9-]+\.sql)/g)].map((m) => m[1] as string);
    assert.deepEqual([...inChain].sort(), onDisk, 'a verifier on disk that the chain does not run proves nothing in CI');
    assert.equal(new Set(inChain).size, inChain.length);
    assert.ok(onDisk.length >= 13, `found ${onDisk.length}`);
    assert.match(read('.github/workflows/verify.yml'), /db:verify:acquisition/);
  });

  test('every acquisition verifier rolls back and ends on its own success line', () => {
    for (const f of readdirSync(new URL('../scripts/', import.meta.url)).filter((x) => /^verify-acquisition-.*\.sql$/.test(x))) {
      const sql = read(`scripts/${f}`);
      assert.match(sql, /\\set ON_ERROR_STOP on|ON_ERROR_STOP/, `${f} must stop on the first error`);
      assert.match(sql, /rollback;\s*$/, `${f} must roll back`);
      assert.match(sql, /ALL CHECKS PASSED|passed/i, `${f} must say it passed`);
    }
  });

  test('the end-to-end verifier drives the real ingest, the tracked handoff, and the stop across every governed action', () => {
    const sql = read('scripts/verify-acquisition-e2e.sql');
    for (const part of ['crm.ingest_whatsapp_message', 'crm.bind_handoff_from_message', 'crm.consume_channel_handoff', 'crm.record_landing_arrival', 'crm.acquisition_funnel(90)', 'crm.ad_outcomes',
      "'landing_page_deploy'", "'b2b_proposal_submit'", "'ad_budget_increase'", "'social_publish'", 'core.set_kill_switch', 'crm.enforce_ad_stops']) assert.ok(sql.includes(part), part);
    assert.match(sql, /the funnel and the campaign report the same number/);
  });

  test('every governed action the policy table knows is asked about in the global-stop check', () => {
    const migration = read('supabase/migrations/20261015100000_lead_generation_is_configured_not_coded.sql');
    const actions = [...(read('supabase/migrations/20261016100000_connectors_policy_and_exact_version_approval.sql').match(/action_type\s+text not null check \(action_type in \(([^)]*)\)\)/)?.[1] ?? '').matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1] as string);
    assert.ok(migration.length > 0 && actions.length >= 12, `found ${actions.length} actions`);
    const sql = read('scripts/verify-acquisition-e2e.sql');
    const commercial = new Set(['discount', 'special_offer', 'payment_terms', 'high_volume_messaging']); // no channel to pause: the stop is about external side effects
    for (const a of actions.filter((x) => !commercial.has(x))) assert.ok(sql.includes(`'${a}'`), `${a} is not covered by the end-to-end stop check`);
  });

  test('the human-dependency report says no provider was contacted and no credential entered', () => {
    const doc = read('docs/lead-generation/HUMAN_DEPENDENCIES.md');
    assert.match(doc, /no provider has been contacted/i);
    assert.match(doc, /never pasted into a chat/);
    assert.match(doc, /`NOT_IMPLEMENTED`[^\n]*every provider today/);
  });
});
