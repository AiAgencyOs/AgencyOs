// The Phase 1 Orchestrator / Quotation / Scheduler gap migrations follow the house rules. This is text, so it can say a rule is WRITTEN; whether it WORKS is the
// job of scripts/verify-p1o-*.sql, which run the functions on a scratch Postgres and red-prove each control by mutating its live definition. Each rule here is
// checked in both directions where it can be: the files that must have it, and a counter-example proving the matcher can fail.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const MIGRATIONS = readdirSync(join(root, 'supabase/migrations'))
  .filter((f) => /^202611270[0-9]{5}0*_p1o_.*\.sql$/.test(f) || /^20261127[0-9]{6}_p1o_.*\.sql$/.test(f))
  .sort();
const SQL = new Map(MIGRATIONS.map((f) => [f, read(`supabase/migrations/${f}`)] as const));
const VERIFIERS = ['verify-p1o-handoffs.sql', 'verify-p1o-scheduling.sql', 'verify-p1o-quotation.sql', 'verify-p1o-credit-notes.sql'];

describe('the migrations exist, in the range this change owns', () => {
  test('four migrations, all inside 20261127000000 to 20261127990000', () => {
    assert.equal(MIGRATIONS.length, 4, MIGRATIONS.join(', '));
    for (const f of MIGRATIONS) {
      const stamp = Number(f.slice(0, 14));
      assert.ok(stamp >= 20261127000000 && stamp <= 20261127990000, f);
    }
  });
});

describe('every new table is closed to direct writes and tenancy-guarded', () => {
  const tables: Array<[string, string]> = [];
  for (const [file, sql] of SQL) {
    for (const m of sql.matchAll(/create table if not exists ([a-z_]+\.p1o_[a-z_]+)\s*\(/g)) tables.push([file, m[1] as string]);
  }
  test('the matcher finds the tables (a counter-example would find none)', () => {
    assert.ok(tables.length >= 9, tables.map((t) => t[1]).join(', '));
    assert.equal([...'create table nothing_here'.matchAll(/create table if not exists ([a-z_]+\.p1o_[a-z_]+)\s*\(/g)].length, 0);
  });
  // A table is covered either by a statement of its own or by a loop whose array names it (migration 3 closes five tables in one loop).
  const covered = (sql: string, table: string, statement: RegExp, loopPhrase: string): boolean => {
    const bare = table.split('.')[1] as string;
    if (statement.test(sql)) return true;
    const inALoopList = [...sql.matchAll(/array\[([^\]]*)\]/g)].some((m) => (m[1] as string).includes(`'${bare}'`));
    return inALoopList && sql.includes(loopPhrase);
  };
  for (const [file, table] of tables) {
    const sql = SQL.get(file) as string;
    const esc = table.replace('.', '\\.');
    test(`${table}: row-level security on, an internal select policy, no write policy`, () => {
      assert.ok(covered(sql, table, new RegExp(`alter table ${esc} enable row level security`), 'enable row level security'), 'row-level security is not enabled');
      assert.ok(covered(sql, table, new RegExp(`create policy [a-z_0-9]+ on ${esc} for select`), 'for select to authenticated'), 'no select policy');
      assert.doesNotMatch(sql, new RegExp(`create policy [a-z_0-9]+ on ${esc} for (insert|update|delete|all)`));
    });
    test(`${table}: delete and truncate are refused`, () => {
      assert.ok(covered(sql, table, new RegExp(`create trigger [a-z_0-9]+ before delete on ${esc} for each row execute function core\\.reject_end_user_delete`), 'reject_end_user_delete'), 'delete is not refused');
      assert.ok(covered(sql, table, new RegExp(`create trigger [a-z_0-9]+ before truncate on ${esc} for each statement execute function crm\\.reject_truncate`), 'crm.reject_truncate'), 'truncate is not refused');
    });
  }
  test('the covering rule can fail: a table named nowhere is not covered', () => {
    assert.equal(covered('create table x', 'sales.p1o_ghost', /never/, 'enable row level security'), false);
  });
  test('an organisation-scoped table freezes its organisation and matches its parents', () => {
    for (const [file, sql] of SQL) {
      const scoped = [...sql.matchAll(/create table if not exists ([a-z_]+\.p1o_[a-z_]+)\s*\(([\s\S]*?)\n\);/g)].filter((m) => /organization_id\s+uuid not null references core\.organizations/.test(m[2] as string));
      if (scoped.length === 0) continue;
      assert.match(sql, /freeze_organization_id/, `${file} has org-scoped tables but no freeze trigger`);
      assert.match(sql, /enforce_parent_org/, `${file} has org-scoped tables but no parent-org trigger`);
    }
  });
});

describe('every door is closed to the public and sets an empty search path', () => {
  const fns: Array<[string, string, string]> = [];
  for (const [file, sql] of SQL) {
    for (const m of sql.matchAll(/create or replace function ([a-z_]+\.p1o_[a-z_0-9]+)\(/g)) fns.push([file, m[1] as string, sql]);
  }
  test('there are doors to check', () => assert.ok(fns.length >= 40, String(fns.length)));
  for (const [file, name] of fns) {
    const sql = SQL.get(file) as string;
    const isTrigger = new RegExp(`create or replace function ${name.replace('.', '\\.')}\\(\\)\\s+returns trigger`).test(sql);
    const isPureValidator = /_valid_/.test(name);
    test(`${name}: ${isTrigger || isPureValidator ? 'pins its search_path (a trigger or pure validator is not a door)' : 'revoked from public, and pins its search_path'}`, () => {
      const revoked = isTrigger || isPureValidator || [...sql.matchAll(/revoke all on function([\s\S]*?)from public/g)].some((m) => (m[1] as string).includes(name));
      assert.ok(revoked, `${name} is not revoked from public in ${file}`);
      const header = sql.match(new RegExp(`create or replace function ${name.replace('.', '\\.')}\\([\\s\\S]*?\\bas \\$(\\w*)\\$`));
      assert.ok(header, `${name} header not found`);
      assert.match(header?.[0] ?? '', /set search_path = ''/, `${name} does not pin its search_path`);
    });
  }
  test('a function that is not revoked would be caught by the same matcher', () => {
    const fake = 'create or replace function ai.p1o_fake() returns int as $$ select 1 $$; revoke all on function ai.p1o_other() from public;';
    assert.equal([...fake.matchAll(/revoke all on function([\s\S]*?)from public/g)].some((m) => (m[1] as string).includes('ai.p1o_fake')), false);
  });
});

describe('human gates and the non-superuser rule', () => {
  const all = [...SQL.values()].join('\n');
  test('nothing sets session_replication_role', () => assert.doesNotMatch(all, /session_replication_role/));
  test('the runner doors refuse a signed-in caller and are granted to service_role only', () => {
    assert.match(all, /grant execute on function ai\.p1o_invalidate_stale_handoffs\(uuid\) to service_role/);
    assert.match(all, /grant execute on function crm\.p1o_expire_stale_proposals\(uuid\) to service_role/);
    assert.match(all, /ai\.p1o_invalidate_stale_handoffs is a runner door/);
    assert.match(all, /crm\.p1o_expire_stale_proposals is a runner door/);
  });
  test("acceptance and credit-note issuing refuse the service role: they are a person's act", () => {
    assert.match(all, /needs_a_person/);
    const acceptance = all.match(/create or replace function sales\.p1o_record_acceptance[\s\S]*?end \$\$;/);
    assert.ok(acceptance);
    assert.match(acceptance?.[0] ?? '', /if \(select auth\.uid\(\)\) is null then return query select 'needs_a_person'/);
    const issue = all.match(/create or replace function finance\.p1o_issue_credit_note[\s\S]*?end \$\$;/);
    assert.ok(issue);
    assert.match(issue?.[0] ?? '', /p1o_credit_note_actor_refusal/);
    assert.match(all, /if \(select auth\.uid\(\)\) is null then return 'needs_a_person'; end if;/);
  });
  test('the classified response door refuses the class "accepted"', () => assert.match(all, /if p_class = 'accepted' then return query select 'use_the_acceptance_door'/));
  test('an issued credit note and a stamped policy are immutable by trigger, not by convention', () => {
    assert.match(all, /an issued credit note is a document and does not change/);
    assert.match(all, /the policy a quotation was judged under is a record of what was in force/);
    assert.match(all, /what the client accepted, and the evidence of it, does not change/);
  });
  test('every event emitted is declared in the same files', () => {
    const declared = new Set([...all.matchAll(/\(\s*'([a-z_]+\.[a-z_]+)'\s*,\s*'/g)].map((m) => m[1]));
    const emitted = [...all.matchAll(/emit_event\(\s*[a-z_.]+,\s*'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1] as string);
    assert.ok(emitted.length >= 8, emitted.join(', '));
    for (const e of emitted) assert.ok(declared.has(e), `${e} is emitted but not declared`);
  });
});

describe('the verifiers prove controls by removing them from the live definition', () => {
  for (const v of VERIFIERS) {
    const sql = read(`scripts/${v}`);
    test(`${v}: rolls back, has a mutation helper that raises on a no-op, and at least three red-proofs`, () => {
      assert.match(sql, /\nrollback;\n/);
      assert.match(sql, /RED-PROOF MUTATION CHANGED NOTHING/);
      assert.ok([...sql.matchAll(/'RED-PROOF: /g)].length >= 3, v);
      assert.doesNotMatch(sql, /session_replication_role/);
    });
    test(`${v}: every red-proof mutates a definition it first reads back`, () => {
      const mutations = [...sql.matchAll(/pg_temp\.mutate\('([^']+)'/g)].map((m) => m[1] as string);
      assert.ok(mutations.length >= 3);
      for (const fn of mutations) assert.match(fn, /^[a-z]+\.[a-z_0-9]+\(/);
    });
  }
  test('the package gate runs them (wiring line) -- not edited here, named in the log', () => {
    const log = read('docs/phase-1-orchestrator-quotation-gaps-log.md');
    for (const v of VERIFIERS) assert.ok(log.includes(v), `${v} missing from the log's wiring lines`);
  });
});

describe('server code: reads are never silent, and server-action files export only async functions', () => {
  const services = [
    'src/modules/orchestrator/p1o-coordination.ts',
    'src/modules/crm/p1o-scheduling-service.ts',
    'src/modules/sales/p1o-quotation-service.ts',
    'src/modules/finance/p1o-credit-notes.ts',
  ];
  for (const f of services) {
    test(`${f}: every read that can fail says so`, () => {
      const lines = read(f).split('\n');
      let reads = 0;
      lines.forEach((line, i) => {
        if (/const \{ data, error \} = await (rpc|supabase)/.test(line) || /const \{ data(: [a-z]+)?, error(: [a-zA-Z]+)? \} = await supabase/.test(line)) {
          reads += 1;
          const near = lines.slice(i, i + 16).join('\n');
          assert.match(near, /if \((error|[a-zA-Z]+Error)\)/, `${f}:${i + 1} reads and does not check the error`);
        }
      });
      assert.ok(reads >= 2, `${f}: matcher saw ${reads} reads`);
    });
  }
  test('the reading functions use unreadable() and the writing doors log and return a Result', () => {
    for (const f of services) {
      const src = read(f);
      const checks = [...src.matchAll(/if \((error|[a-zA-Z]+Error)\) unreadable\(/g)].length;
      const doors = [...src.matchAll(/if \(error\) \{\n\s+console\.error/g)].length;
      assert.ok(checks + doors >= 3, `${f}: ${checks} unreadable + ${doors} logged`);
    }
  });
  const actionFiles = [
    'app/(internal)/operations/task-board/actions.ts',
    'app/(internal)/meetings/attention/actions.ts',
    'app/(internal)/meetings/policy/actions.ts',
    'app/(internal)/quotations/negotiation/[opportunityId]/actions.ts',
    'app/(internal)/invoices/credit-notes/actions.ts',
    'app/(internal)/quotations/policy/actions.ts',
  ];
  for (const f of actionFiles) {
    test(`${f}: 'use server' and only async function exports`, () => {
      const src = read(f);
      assert.match(src, /^'use server';/);
      const exports = [...src.matchAll(/^export (?!async function)(.*)$/gm)];
      assert.deepEqual(exports.map((m) => m[0]), []);
      assert.ok([...src.matchAll(/^export async function/gm)].length >= 1);
    });
  }
  test('no duplicate keys in the refusal-sentence tables', () => {
    for (const f of services) {
      const src = read(f);
      const table = src.match(/const (SAY|REFUSAL)[^=]*= \{([\s\S]*?)\n\};/);
      if (!table) continue;
      const keys = [...(table[2] as string).matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1]);
      assert.equal(new Set(keys).size, keys.length, `${f} repeats a key`);
    }
  });
});
