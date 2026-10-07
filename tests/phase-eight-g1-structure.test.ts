import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Static checks for the Phase 8A gaps log 1 build. These read SOURCE, so they can say a string is present and nothing about whether SQL runs: the doors are run
 * by scripts/verify-phase-eight-a-gaps-1.sql and its 170 red-proofs. What they hold: the migrations use only the allotted timestamps, every door the TypeScript calls
 * exists in them, the actions file exports only async functions, every read that can fail refuses instead of returning empty, and nothing sends or prices.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const MIGRATION_DIR = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const MIGRATIONS = readdirSync(MIGRATION_DIR).filter((f) => f.startsWith('202611200') || f.startsWith('2026112') && f >= '20261120000000_' && f < '20261121');
const SQL = MIGRATIONS.map((f) => readFileSync(MIGRATION_DIR + f, 'utf8')).join('\n');
const SQL_CODE = SQL.replace(/^\s*--.*$/gm, '');

describe('the migrations', () => {
  test('there are four, each in the allotted timestamp range, in order', () => {
    assert.equal(MIGRATIONS.length, 4);
    for (const m of MIGRATIONS) {
      const stamp = Number(m.slice(0, 14));
      assert.ok(stamp >= 20261120000000 && stamp <= 20261120990000, m);
    }
    assert.deepEqual([...MIGRATIONS].sort(), MIGRATIONS);
  });
  test('they only ADD: no drop of a table or column, no change to an existing function by name outside the new ones', () => {
    assert.ok(!/drop\s+table|drop\s+column|alter\s+table\s+\S+\s+drop\s+column/i.test(SQL_CODE));
    assert.ok(!/alter\s+table\s+projects\.(projects|completion_records|handovers|scope_versions)\b/i.test(SQL_CODE), 'the completed project and its scope stay historical truth');
    assert.ok(!/update\s+projects\.(projects|completion_records|handovers)\b/i.test(SQL_CODE));
  });
  test('nothing in them sends, posts, notifies or emits an event', () => {
    assert.ok(!/net\.http|http_post|pg_notify|core\.emit_event|insert into crm\.|insert into finance\./i.test(SQL_CODE));
  });
  test('every SECURITY DEFINER function pins an empty search_path', () => {
    const defs = SQL_CODE.split(/create or replace function /i).slice(1);
    assert.ok(defs.length > 40);
    for (const d of defs) {
      const header = d.slice(0, d.search(/\$\$/) > 0 ? d.search(/\$\$/) : 400);
      if (/security definer/i.test(header)) assert.match(header, /set search_path = ''/i, header.slice(0, 80));
    }
  });
  test('every agent-only door is service-role only and every person door has no service-role grant', () => {
    for (const fn of ['propose_knowledge_article_as_agent', 'cite_knowledge_for_ticket_as_agent', 'propose_ticket_scope_reference_as_agent', 'request_ticket_handoff_as_agent', 'record_discovery_brief_draft']) {
      assert.match(SQL_CODE, new RegExp(`grant execute on function projects\\.${fn}\\([^)]*\\) to service_role;`), fn);
      assert.ok(!new RegExp(`grant execute on function projects\\.${fn}\\([^)]*\\) to authenticated`).test(SQL_CODE), fn);
    }
    for (const fn of ['record_client_feedback', 'set_client_designation', 'approve_knowledge_article', 'confirm_ticket_scope_reference', 'settle_ticket_handoff', 'review_discovery_brief']) {
      assert.match(SQL_CODE, new RegExp(`revoke all on function projects\\.${fn}\\([^)]*\\) from [^;]*service_role;`), fn);
    }
  });
  test('the new tables carry no price, amount, quote, discount or score column', () => {
    const tables = [...SQL_CODE.matchAll(/create table if not exists projects\.([a-z_]+) \(([\s\S]*?)\n\);/g)];
    assert.ok(tables.length >= 11, `found ${tables.length} tables`);
    for (const [, name, body] of tables) {
      for (const line of body!.split('\n')) {
        const col = line.trim().match(/^([a-z_]+)\s+(uuid|text|int|bigint|boolean|date|jsonb|timestamptz|text\[\])\b/);
        if (col) assert.ok(!/(^|_)(price|amount|quote|discount|cost|fee|total|score|minor|currency)(_|$)/.test(col[1]!), `${name}.${col[1]}`);
      }
    }
  });
});

describe('the TypeScript', () => {
  const files = [
    'src/modules/projects/phase-eight-g1-actions.ts', 'src/modules/projects/phase-eight-g1-queries.ts', 'src/modules/projects/phase-eight-g1-schema.ts', 'src/modules/projects/phase-eight-access.ts',
    'src/modules/projects/phase-eight-sales-proposals.ts', 'app/api/jobs/run/phase-eight-sales-workflows.ts',
  ];
  const doorsCalled = (rel: string) => [...code(rel).matchAll(/(?:rpc: '|\.rpc\(\s*'|rpc\('|rpc\(\s*'|\.rpc\('([a-z_]+)'|rpc: ')([a-z_]+)'/g)].map((m) => m[2]!);

  test('every database function the TypeScript calls exists in the migrations (or in an earlier one it already used)', () => {
    const called = new Set<string>();
    for (const f of ['src/modules/projects/phase-eight-g1-actions.ts', 'src/modules/projects/phase-eight-g1-queries.ts', 'src/modules/projects/phase-eight-access.ts', 'app/api/jobs/run/phase-eight-sales-workflows.ts']) for (const d of doorsCalled(f)) called.add(d);
    const earlier = new Set(['customer_health_status']);
    assert.ok(called.size >= 25, `found ${called.size} calls`);
    for (const name of called) {
      if (earlier.has(name)) continue;
      assert.match(SQL_CODE, new RegExp(`create or replace function projects\\.${name}\\(`), name);
    }
  });
  test('the actions file is a server-actions module: it exports only async functions', () => {
    const src = read('src/modules/projects/phase-eight-g1-actions.ts');
    assert.match(src, /^'use server';/);
    const exports = [...src.matchAll(/^export\s+(.*)$/gm)].map((m) => m[1]!);
    assert.ok(exports.length === 2);
    for (const e of exports) assert.match(e, /^async function /);
  });
  test('no duplicate door keys in the action whitelists', () => {
    const src = code('src/modules/projects/phase-eight-g1-actions.ts');
    for (const block of src.split(/const (?:STAFF|PORTAL)_DOORS/).slice(1)) {
      const body = block.slice(0, block.indexOf('\n};'));
      const keys = [...body.matchAll(/^  ([a-z_]+): \{/gm)].map((m) => m[1]!);
      assert.ok(keys.length >= 2);
      assert.equal(new Set(keys).size, keys.length);
    }
  });
  test('every read that can fail refuses: no read result is used without an unreadable() guard, and the counts agree', () => {
    const src = code('src/modules/projects/phase-eight-g1-queries.ts');
    const reads = [...src.matchAll(/const \{ data, error \} = await /g)].length;
    const promiseAll = [...src.matchAll(/if \((\w+)\.error\) unreadable\(/g)].length;
    const single = [...src.matchAll(/if \(error\) unreadable\(/g)].length;
    assert.ok(reads >= 10);
    assert.equal(single, reads, 'every single read is followed by its refusal');
    assert.equal(promiseAll, 5, 'every member of the Promise.all is refused');
    assert.equal([...src.matchAll(/unreadable\(/g)].length, single + promiseAll);
    assert.ok(!/catch\s*\(/.test(src), 'no swallow');
  });
  test('the guard helper calls the guard door and treats anything but allowed as denied', () => {
    const src = code('src/modules/projects/phase-eight-access.ts');
    assert.match(src, /guard_phase_eight_project/);
    assert.match(src, /outcome === 'allowed'/);
    assert.match(src, /unreadable\('guardPhaseEightProject'/);
  });
  test('the discovery proposals name no price except in the instruction not to, and the staff action reaches no agent door', () => {
    const prompt = code('src/modules/projects/phase-eight-sales-proposals.ts');
    assert.match(prompt, /Do not quote, state or hint at a price/);
    const actions = code('src/modules/projects/phase-eight-g1-actions.ts');
    for (const forbidden of ['_as_agent', 'record_discovery_brief_draft', 'guard_phase_eight_project', 'send_outbound_message', 'open_renewal', '.insert(', '.delete(', '.update(']) assert.ok(!actions.includes(forbidden), forbidden);
  });
  test('the new pages are wired nowhere that already existed (the lead links them)', () => {
    for (const rel of ['app/(internal)/projects/customer-success/page.tsx', 'app/(internal)/clients/[clientId]/customer-360/page.tsx']) {
      assert.ok(!read(rel).includes('next-actions') || read(rel).includes('/projects/customer-success/next-actions'), rel);
    }
    for (const f of files) assert.ok(read(f).length > 200, f);
  });
});
