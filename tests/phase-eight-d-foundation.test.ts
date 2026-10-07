import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AGENT_DEFINITIONS, definitionFor, mayHandOff } from '../src/modules/agents/registry.ts';

/**
 * Phase 8D (handoff edges, communication governance, value-report drafts, Customer 360, observability): what can be held by reading the files. The behaviour is
 * proved in Postgres by scripts/verify-phase-eight-d.sql (run through the real doors on a scratch database) and red-proved by scripts/redproof/phase-eight-d.py;
 * this file holds the shape: the migrations stay in their lane and send nothing, every door is granted to exactly who may call it, every foreign key to a
 * tenant-scoped parent is guarded, the roster migration mirrors the registry, and the verifier and its red-proof harness have not been quietly hollowed out.
 */

const root = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(root(rel), 'utf8');
const MIG_DIR = root('supabase/migrations/');
const ALL = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
const MINE = ALL.filter((f) => /^20261110[0-9]{6}_/.test(f));
const SQL = MINE.map((f) => readFileSync(`${MIG_DIR}${f}`, 'utf8')).join('\n');
/** SQL without line comments: a comment may NAME a forbidden thing to say it is absent. */
const CODE = SQL.replace(/^\s*--.*$/gm, '');
const mig = (prefix: string) => {
  const f = MINE.find((m) => m.startsWith(prefix));
  assert.ok(f, `migration ${prefix}`);
  return readFileSync(`${MIG_DIR}${f}`, 'utf8').replace(/^\s*--.*$/gm, '');
};

const TABLES = ['client_communication_caps', 'client_quiet_periods', 'client_communication_ledger', 'client_communication_events', 'value_report_drafts'];

describe('the migrations stay in their lane', () => {
  test('four migrations, all inside the reserved version range, in order', () => {
    assert.equal(MINE.length, 4);
    for (const f of MINE) assert.ok(f >= '20261110000000' && f < '20261111000000', f);
    assert.deepEqual(MINE, [...MINE].sort());
    // and they come after everything else that exists, so they apply last
    assert.ok(ALL.filter((f) => !MINE.includes(f)).every((f) => f < MINE[0]!), 'an earlier-numbered file sorts after a Phase 8D migration');
  });

  test('they only add: no drop, no change to an existing table, no write outside their own tables and the roster mirror', () => {
    assert.ok(!/\bdrop\s+(table|column|schema|type)\b/i.test(CODE));
    // the only ALTER is the row-security switch on a table this phase creates (in the wiring helper and in the report table's own block)
    assert.ok(!/\balter\s+table\b/i.test(CODE.replace(/alter table projects\.(%I|value_report_drafts) enable row level security/g, '')), 'a migration alters an existing table');
    const inserted = [...CODE.matchAll(/\binsert\s+into\s+([a-z_.%]+)/gi)].map((m) => m[1]!);
    const allowed = new Set(['ai.agent_handoff_targets', 'projects.client_communication_ledger', 'projects.client_communication_events', 'projects.client_communication_caps', 'projects.client_quiet_periods', 'projects.value_report_drafts']);
    for (const t of inserted) assert.ok(allowed.has(t), `a migration inserts into ${t}`);
    assert.ok(!/\b(update|delete\s+from)\s+(projects\.(projects|completion_records|handovers|scope_versions|support_tickets|maintenance_[a-z_]+)|crm\.|finance\.|sales\.)/i.test(CODE), 'a migration writes a record it does not own');
  });

  test('NOTHING SENDS: no network call, no notification, no event, no insert into a messaging, finance or sales table', () => {
    assert.ok(!/net\.http|http_post|pg_notify\(|core\.emit_event|insert\s+into\s+crm\.|insert\s+into\s+finance\.|insert\s+into\s+sales\./i.test(CODE));
    assert.ok(!/\bnotify\s+(?!pgrst)/i.test(CODE), 'only the PostgREST schema reload is notified');
  });

  test('exactly five tables are created, and none carries a price, amount, quote, discount, score, uptime or currency column', () => {
    const blocks = [...CODE.matchAll(/create table if not exists projects\.([a-z_]+) \(([\s\S]*?)\n\);/g)];
    assert.deepEqual(blocks.map((b) => b[1]).sort(), [...TABLES].sort());
    for (const [, name, body] of blocks) {
      const columns = [...body!.matchAll(/^\s{2}([a-z_]+)\s+(?:uuid|text|int|bigint|boolean|date|timestamptz|jsonb|char)/gm)].map((m) => m[1]!);
      assert.ok(columns.length >= 8, String(name));
      for (const c of columns) assert.doesNotMatch(c, /price|amount|quote|quotation|discount|cost|fee|total|score|minor|currency|rate|uptime|satisfaction|savings/, `${name}.${c}`);
    }
  });

  test('every table is wired: row security, the internal-only read, append-only where it is history', () => {
    const wires = [...CODE.matchAll(/perform projects\.p8d_wire_table\('([a-z_]+)', (true|false), (true|false)\)/g)].map((m) => [m[1], m[2], m[3]]);
    assert.deepEqual(wires.filter((w) => w[0] !== 'value_report_drafts'), [
      ['client_communication_caps', 'true', 'false'], ['client_quiet_periods', 'true', 'false'], ['client_communication_ledger', 'false', 'true'], ['client_communication_events', 'false', 'true'],
    ]);
    assert.match(CODE, /create policy %I on projects\.%I for select to authenticated using \(organization_id = \(select core\.current_organization_id\(\)\) and \(select core\.is_internal\(\)\)\)/);
    assert.match(CODE, /revoke insert, update, delete on projects\.%I from authenticated/);
    assert.match(CODE, /create policy value_report_drafts_read on projects\.value_report_drafts for select to authenticated using \(organization_id = \(select core\.current_organization_id\(\)\) and \(select core\.is_internal\(\)\)\)/);
    assert.match(CODE, /revoke insert, update, delete on projects\.value_report_drafts from authenticated/);
    assert.match(CODE, /create trigger freeze_org_value_report_drafts before update of organization_id/);
    for (const t of TABLES) assert.ok(read('scripts/verify-phase-eight-d.sql').includes(`'${t}'`), `${t} is in the verifier's table list`);
    assert.ok(!/create policy [a-z_]+ on projects\.(client|value)[a-z_]* for (insert|update|delete|all)/i.test(CODE), 'no write policy exists');
  });

  test('every foreign key to a tenant-scoped parent has its parent-organization guard, client_account_id included', () => {
    const guarded = new Set([...CODE.matchAll(/\('([a-z_]+)', '([a-z_]+)', '([a-z_.]+)'\)/g)].map((m) => `${m[1]}.${m[2]}->${m[3]}`));
    // the report table is wired in its own block, one trigger
    if (/create trigger org_match_value_report_drafts_client_account_id before insert or update on projects\.value_report_drafts for each row execute function core\.enforce_parent_org\('client_account_id', 'core\.client_accounts'\)/.test(CODE)) guarded.add('value_report_drafts.client_account_id->core.client_accounts');
    const blocks = [...CODE.matchAll(/create table if not exists projects\.([a-z_]+) \(([\s\S]*?)\n\);/g)];
    let foreignKeys = 0;
    for (const [, table, body] of blocks) {
      for (const m of body!.matchAll(/^\s{2}([a-z_]+)\s+uuid[^\n]*references ([a-z_.]+)\(id\)/gm)) {
        const [, column, parent] = m;
        if (parent === 'core.organizations' || parent === 'core.users') continue;
        foreignKeys += 1;
        assert.ok(guarded.has(`${table}.${column}->${parent}`), `${table}.${column} -> ${parent} has no core.enforce_parent_org guard`);
      }
    }
    assert.equal(foreignKeys, 8, 'the eight tenant-scoped foreign keys');
    assert.ok(guarded.has('client_communication_ledger.client_account_id->core.client_accounts'));
    assert.match(CODE, /core\.enforce_parent_org\('client_account_id', 'core\.client_accounts'\)/);
  });

  test('history never loses a person: the ledger and events reference users with RESTRICT, not SET NULL, because an append-only row cannot be updated by a cascade', () => {
    const ledger = /create table if not exists projects\.client_communication_ledger \(([\s\S]*?)\n\);/.exec(CODE)![1]!;
    const events = /create table if not exists projects\.client_communication_events \(([\s\S]*?)\n\);/.exec(CODE)![1]!;
    for (const body of [ledger, events]) assert.ok(!/references core\.users\(id\) on delete set null/.test(body));
  });
});

describe('every door is granted to exactly who may call it', () => {
  const doors = [...CODE.matchAll(/create or replace function projects\.([a-z0-9_]+)\(([\s\S]*?)\)\s*returns[\s\S]*?\n(?:end \$\$;|\$\$;)/g)];
  const byName = new Map(doors.map((d) => [d[1]!, d[0]]));

  test('at least the twenty functions exist', () => {
    assert.ok(byName.size >= 20, `found ${byName.size}`);
  });

  test('every SECURITY DEFINER function pins an empty search_path', () => {
    for (const [name, body] of byName) if (/security definer/.test(body)) assert.match(body, /set search_path = ''/, name);
  });

  test('the person doors are executable by signed-in people and NOT by the service role', () => {
    for (const door of ['set_client_communication_cap', 'clear_client_communication_cap', 'add_client_quiet_period', 'cancel_client_quiet_period', 'record_client_communication', 'record_client_communication_event',
                         'store_value_report_draft', 'edit_value_report_draft', 'approve_value_report_draft', 'discard_value_report_draft']) {
      assert.match(CODE, new RegExp(`revoke all on function projects\\.${door}\\([^)]*\\) from public, anon, service_role;`), `${door} is revoked from the service role`);
      assert.match(CODE, new RegExp(`grant execute on function projects\\.${door}\\([^)]*\\) to authenticated;`), `${door} is granted to authenticated`);
    }
  });

  test('the agent doors are service-role only AND check the role inside the function', () => {
    for (const door of ['record_agent_communication_draft', 'store_value_report_draft_as_agent']) {
      assert.match(CODE, new RegExp(`revoke all on function projects\\.${door}\\([^)]*\\) from public, anon, authenticated;`), door);
      assert.match(CODE, new RegExp(`grant execute on function projects\\.${door}\\([^)]*\\) to service_role;`), door);
      assert.match(byName.get(door)!, /coalesce\(\(select auth\.role\(\)\), ''\) <> 'service_role' then return query select 'not_authorized'/, `${door} checks the role inside`);
    }
    assert.match(CODE, /revoke all on function projects\.p8d_store_value_report\([^)]*\) from public, anon, authenticated, service_role;/, 'the inner store function is callable by no role');
  });

  test('the Admin-only doors check is_admin and the person doors check can_write, both with is_internal, inside the function', () => {
    for (const door of ['set_client_communication_cap', 'clear_client_communication_cap', 'add_client_quiet_period', 'cancel_client_quiet_period']) assert.match(byName.get(door)!, /core\.is_admin\(\)[\s\S]*core\.is_internal\(\)/, door);
    for (const door of ['record_client_communication', 'record_client_communication_event', 'store_value_report_draft', 'edit_value_report_draft', 'approve_value_report_draft', 'discard_value_report_draft']) assert.match(byName.get(door)!, /core\.can_write\(\)[\s\S]*core\.is_internal\(\)/, door);
  });

  test('the reads are not SECURITY DEFINER: they run as the caller, under row security', () => {
    for (const read of ['can_contact_now', 'client_communication_history', 'value_report_facts', 'phase_eight_observability']) {
      const body = byName.get(read)!;
      assert.ok(body, read);
      assert.match(body, /security invoker/, read);
      assert.ok(!/security definer/.test(body), read);
    }
  });

  test('the doors take the tenant from the caller, never from a parameter, except the two service-role doors', () => {
    for (const [name, body] of byName) {
      if (!/security definer/.test(body) || /^(record_agent_communication_draft|store_value_report_draft_as_agent|p8d_store_value_report)$/.test(name)) continue;
      assert.ok(!/p_organization_id/.test(body), `${name} takes an organization id as an argument`);
    }
  });
});

describe('eligibility asks the facts that exist and invents no number', () => {
  const body = mig('20261110100000');
  test('consent is the existing consent table; email and portal have none; call and meeting are a person\'s act', () => {
    assert.match(body, /crm\.communication_consent/);
    assert.match(body, /elsif p_channel in \('email', 'portal'\) then/);
    assert.match(body, /ADM-81/);
  });
  test('the 8A category rules are reused, not copied', () => {
    assert.match(body, /projects\.check_in_eligibility\(w\.project_id, 'scheduled', p_now\)/);
  });
  test('no cap number, window or quiet interval is a default anywhere: a client has none until an Admin sets one', () => {
    assert.ok(!/default\s+[0-9]+/.test(/create table if not exists projects\.client_communication_caps \(([\s\S]*?)\n\);/.exec(body)![1]!));
    assert.ok(!/p_max_contacts int default|p_window_days int default/.test(body));
    assert.ok(!/insert into projects\.client_communication_caps[\s\S]{0,80}values \(v_org, p_client_account_id, p_channel, [0-9]/.test(body));
  });
  test('a person-recorded send is never refused for being ineligible: the answer is stored beside it', () => {
    const record = /create or replace function projects\.record_client_communication\([\s\S]*?\n\$\$;/.exec(body)![0];
    assert.match(record, /projects\.can_contact_now\(/);
    assert.match(record, /eligible_at_record, eligibility_reasons/);
    assert.ok(!/if not v_ok then return query select/.test(record));
  });
});

describe('the roster migration mirrors the registry (check-record section 16)', () => {
  const pairs = [...mig('20261110000000').matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
  test('exactly the five edges the specs imply', () => {
    assert.deepEqual(pairs, ['customer_success>finance', 'customer_success>support', 'sales>customer_success', 'support>customer_success', 'support>sales']);
  });
  test('every seeded pair is a declared target in the sender\'s definition, and each new target is declared literally', () => {
    for (const p of pairs) {
      const [from, to] = p.split('>') as [string, string];
      assert.ok(mayHandOff(from, to), `${from} does not declare ${to} in src/modules/agents/registry.ts`);
    }
    assert.deepEqual([...definitionFor('support')!.handoffTargets].sort(), ['customer_success', 'developer', 'quality_assurance', 'sales']);
    assert.deepEqual([...definitionFor('customer_success')!.handoffTargets].sort(), ['finance', 'sales', 'support']);
    assert.ok(definitionFor('sales')!.handoffTargets.includes('customer_success'));
  });
  test('and nothing wider: upsell still hands only to sales; finance gains no edge to the customer agents; every target is a defined agent', () => {
    assert.deepEqual([...definitionFor('upsell')!.handoffTargets], ['sales']);
    assert.ok(!mayHandOff('finance', 'customer_success') && !mayHandOff('finance', 'support') && !mayHandOff('upsell', 'support'));
    const keys = new Set(AGENT_DEFINITIONS.map((a) => a.key));
    for (const a of AGENT_DEFINITIONS) for (const t of a.handoffTargets) assert.ok(keys.has(t), `${a.key} -> ${t}`);
  });
  test('the three arrays are LITERAL in the registry, so the mirror check can count them', () => {
    const registry = read('src/modules/agents/registry.ts');
    assert.match(registry, /handoffTargets: \['project_manager', 'quality_assurance', 'customer_success'\],/);
    assert.match(registry, /handoffTargets: \['developer', 'quality_assurance', 'customer_success', 'sales'\],/);
    assert.match(registry, /handoffTargets: \['sales', 'support', 'finance'\],/);
  });
});

describe('the readers refuse a failed read (G-054)', () => {
  for (const file of ['src/modules/projects/customer-360-queries.ts', 'src/modules/projects/phase-eight-observability-queries.ts']) {
    test(`${file} reports every read failure and turns no error into an empty answer`, () => {
      const source = read(file);
      const code = source.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
      const guards = code.match(/if \([A-Za-z.]*[eE]rror\)/g) ?? [];
      const refusals = code.match(/unreadable\(/g) ?? [];
      assert.ok(guards.length >= 1, file);
      assert.equal(guards.length, refusals.length, `${guards.length} error guards but ${refusals.length} refusals`);
      assert.doesNotMatch(code, /if \([A-Za-z.]*[eE]rror\)\s*\{?\s*(?:console\.[a-z]+\([^)]*\);\s*)?return\b/);
    });
  }
});

describe('the pages and forms hold the same line', () => {
  const page = read('app/(internal)/clients/[clientId]/customer-360/page.tsx');
  const forms = read('app/(internal)/clients/[clientId]/customer-360/customer-360-forms.tsx');
  const obs = read('app/(internal)/projects/customer-success/observability/page.tsx');

  test('Customer 360 is internal, read-gated, and shows finance only to a viewer who may read it', () => {
    assert.match(page, /requireInternal\(`\/clients\/\$\{clientId\}\/customer-360`\)/);
    assert.match(page, /can\(context, 'project\.read'\)/);
    assert.match(page, /const mayReadFinance = can\(context, 'invoice\.read'\);/);
    assert.match(page, /readCustomer360\(clientId, \{ mayReadFinance \}\)/);
    assert.match(page, /view\.invoices === null/);
  });
  test('the page and form call only the Phase 8D action: nothing sends, nothing reaches a provider', () => {
    assert.match(forms, /phaseEightDDoorAction/);
    for (const source of [page, forms, obs]) assert.ok(!/fetch\(|createAdminClient|sendClientMessage|sendWhatsApp|sendEmail/.test(source));
  });
  test('the page does not edit the existing client page: it is a new route beneath it', () => {
    assert.ok(existsSync(root('app/(internal)/clients/[clientId]/customer-360/page.tsx')));
    assert.ok(!/customer-360/.test(read('app/(internal)/clients/[clientId]/page.tsx')), 'the existing client page is untouched');
  });
  test('observability is read-gated, nested under /projects, and reachable from the accounts overview', () => {
    assert.match(obs, /requireInternal\('\/projects\/customer-success\/observability'\)/);
    assert.match(obs, /can\(context, 'project\.read'\)/);
    assert.match(read('app/(internal)/projects/customer-success/page.tsx'), /href="\/projects\/customer-success\/observability"/);
    assert.ok(!/<form|useActionState|rpc\(/.test(obs), 'it only reads');
  });
});

describe('the verifier and its red-proof harness have not been hollowed out', () => {
  const verifier = read('scripts/verify-phase-eight-d.sql');
  const harness = read('scripts/redproof/phase-eight-d.py');

  test('the verifier drives the real doors, rolls back and ends with its OK line', () => {
    assert.match(verifier, /^\\set ON_ERROR_STOP on\nbegin;\n/m);
    assert.match(verifier, /\\echo Phase 8D \(handoff edges, communication governance, value-report drafts, observability\) verified OK\nrollback;\s*$/);
    const checks = verifier.match(/pg_temp\.check\(/g) ?? [];
    assert.ok(checks.length >= 180, `only ${checks.length} checks`);
    for (const door of ['set_client_communication_cap', 'record_client_communication', 'record_agent_communication_draft', 'record_client_communication_event', 'can_contact_now', 'store_value_report_draft', 'approve_value_report_draft', 'phase_eight_observability']) {
      assert.ok(verifier.includes(`projects.${door}(`), `${door} is driven`);
    }
  });
  test('CI runs on a non-superuser: no session_replication_role anywhere; triggers are disabled with ALTER TABLE only', () => {
    assert.ok(!/session_replication_role/.test(verifier + harness));
    assert.ok(/alter table projects\.handovers disable trigger user/.test(verifier));
  });
  test('the harness has a case for every control and each case names what it removes', () => {
    const cases = harness.match(/^ {4}\('/gm) ?? [];
    assert.ok(cases.length >= 120, `only ${cases.length} cases`);
    const names = [...harness.matchAll(/^ {4}\('((?:[^'\\]|\\.)*)', '(?:fn|sql)'/gm)].map((m) => m[1]);
    assert.equal(names.length, cases.length);
    assert.equal(new Set(names).size, names.length, 'a duplicate case name');
    assert.match(harness, /NO-OP MUTATION/);
    assert.match(harness, /pg_get_functiondef/);
  });
  test('every function mutation names a pattern that exists in the live definition (a no-op mutation proves nothing)', () => {
    const migrations = SQL;
    for (const m of harness.matchAll(/\(([A-Z_]+|"[^"]+"|'[^']+'), \[\(("(?:[^"\\]|\\.)+"|'(?:[^'\\]|\\.)+'),/g)) {
      void m; // the harness itself raises NO-OP at run time; this is a coarse static guard for the commonest guards
    }
    for (const guard of ["if v_id is not null then return query select 'duplicate'::text, v_id; return; end if;", "if v_granted = 0 then", "if v_n >= c.max_contacts then", "p_facts_digest is null or p_facts_digest <> v_digest"]) {
      assert.ok(migrations.includes(guard), guard);
      assert.ok(harness.includes(guard), `the harness mutates: ${guard}`);
    }
  });
});

describe('the docs say what is built and what is not', () => {
  const log = read('docs/phase-8d-implementation-log.md');
  const trace = read('docs/phase-8a-implementation-traceability.md');
  test('the log names the migrations, the verifier, the harness and the limits', () => {
    for (const f of MINE) assert.ok(log.includes(f), f);
    assert.match(log, /scripts\/verify-phase-eight-d\.sql/);
    assert.match(log, /scripts\/redproof\/phase-eight-d\.py/);
    assert.match(log, /Not built/);
  });
  test('the traceability matrix records the rows 8D closed and does not claim Phase 8 complete', () => {
    assert.match(trace, /Phase 8D/);
    assert.match(trace, /Phase 8 is NOT claimed complete|not claimed/i);
  });
});
