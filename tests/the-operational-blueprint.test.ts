import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The operational blueprint — Project Planning §1, §4, §5, §7–§9, §11, §15.
 *
 * The specification's first locked line is a boundary: this agent plans the
 * project **operationally** and does not design tables, APIs, frameworks or
 * coding tasks — those belong to the Phase 5 Development Planning Agent (§6).
 * The interesting assertion is therefore a negative one with teeth: the
 * boundary is held by the schema having **nowhere to put** a technical
 * decision, not by anyone remembering the rule.
 *
 * Behaviour is proven where SQL runs — on a scratch Postgres, driven through
 * psql, with six structural guards each refused on a direct write and every
 * door's named refusal exercised.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260917140000_the_operational_blueprint.sql');
/** The SQL alone, so an assertion about the code cannot be satisfied by a comment. */
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
/** The prose with its comment markers folded, indented ones included. */
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
/**
 * The DDL alone — `comment on ... is '...'` statements removed as well as `--`
 * lines. Those comments STATE the rule ("must not design APIs"), and a test
 * that reads them as a breach of it would forbid documenting the boundary.
 */
const DDL = SQL.replace(/comment on [\s\S]*?';/g, '');
assert.ok(DDL.replace(/\s/g, '').length > 2000, 'the stripper ate the migration');
const SERVICE = read('src/modules/projects/planning.ts');
/** The service's CODE alone: a doc comment naming what it must not do is not it doing so. */
const SERVICE_CODE = SERVICE.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const table = (name: string) => {
  const start = SQL.indexOf(`create table if not exists projects.${name}`);
  assert.ok(start > 0, `${name} is not defined`);
  return SQL.slice(start, SQL.indexOf(');', start));
};
const door = (name: string) => {
  const start = SQL.indexOf(`create or replace function projects.${name}`);
  assert.ok(start > 0, `${name} is not defined`);
  return SQL.slice(start, SQL.indexOf('$$;', start));
};

describe('A. the boundary is held by what the schema cannot hold', () => {
  test('there is nowhere to put a technical decision', () => {
    // §5: must not design database schemas, API endpoints, frameworks, or
    // create coding tasks. A column for any of them is how that rule starts
    // being broken politely.
    // No word boundaries: `api_endpoint` and `db_schema` must fail too, and
    // `\bendpoint\b` does not match either because `_` is a word character.
    // That exact hole let a planted `api_endpoint` column through a red-proof.
    assert.doesNotMatch(
      DDL,
      /endpoint|api_contract|db_table|schema_design|framework|librar(y|ies)|repository|branch_name|code_task|story_points|estimate_hours/i,
    );
    assert.match(PROSE, /That boundary is kept \*\*by what this schema cannot hold\*\*/);
  });

  test('and the split is written down where a future reader will look', () => {
    assert.match(PROSE, /A Development Planning Agent, when Phase 5 builds one, gets its own tables/);
    assert.doesNotMatch(SERVICE_CODE, /endpoint|framework|database schema/i);
    assert.match(SERVICE.replace(/\n \* ?/g, ' '), /Operational, never technical/);
  });

  test('it does not overload the two tables that already look like it', () => {
    // `projects.deliverables` is a QA submission; `projects.milestones` is a
    // payment milestone. Neither is a planning register.
    assert.doesNotMatch(SQL, /alter table projects\.deliverables|alter table projects\.milestones/);
    assert.match(PROSE, /overloading one row with\s+both would make "status" mean two different things/);
    assert.match(PROSE, /an operational milestone map AND a finance milestone map/);
  });

  test('the approved scope is referenced, never modified', () => {
    assert.match(table('project_plans'), /scope_version_id uuid references projects\.scope_versions\(id\)/);
    assert.doesNotMatch(SQL, /update projects\.scope_versions|insert into projects\.scope_items|update projects\.scope_items/);
  });
});

describe('B. it cannot invent a deliverable', () => {
  test('every deliverable references something the client approved — a CHECK, not a convention', () => {
    assert.match(table('plan_deliverables'), /constraint plan_deliverables_has_approved_source check \(\s*\n?\s*scope_item_id is not null or proposal_item_id is not null\s*\n?\s*\)/);
  });

  test('and the door says so by name, before the constraint has to', () => {
    const fn = door('add_plan_deliverable');
    const refusal = fn.indexOf("'no_approved_source'");
    const insert = fn.indexOf('insert into projects.plan_deliverables');
    assert.ok(refusal > 0 && insert > refusal);
    assert.match(SERVICE, /otherwise it is a feature nobody agreed to/);
  });

  test('“the agent says it is done” is not evidence', () => {
    // §4.6, in its own words.
    const t = table('plan_deliverables');
    assert.match(t, /readiness_criteria text not null check \(length\(btrim\(readiness_criteria\)\) > 0\)/);
    assert.match(t, /evidence_required {2}text not null check \(length\(btrim\(evidence_required\)\) > 0\)/);
    assert.match(PROSE, /do not equate 'agent says done' with completion/);
  });

  test('ambiguity is carried, not resolved into confidence', () => {
    // §4.1: "flag ambiguity instead of guessing."
    assert.match(table('plan_deliverables'), /ambiguity_note {3}text/);
    assert.match(PROSE, /stored WITH the doubt attached rather than resolved/);
  });

  test('the phase vocabulary is only what these documents name', () => {
    const phases = /applicable_phase text not null check \(applicable_phase in \(\s*\n?\s*'phase_2', 'phase_3', 'phase_4', 'phase_5', 'phase_6', 'phase_7', 'not_applicable'\s*\n?\s*\)\)/;
    assert.match(SQL, phases);
    // No phase 8 or beyond: no locked document in this set names one, and a
    // phase invented here would be a lifecycle invented here.
    assert.doesNotMatch(SQL, /'phase_8'|'phase_9'/);
    assert.match(PROSE, /inventing a phase would be inventing a lifecycle/);
  });
});

describe('C. it cannot promise a date it has no basis for', () => {
  test('a window may be written only with a stated basis', () => {
    assert.match(table('plan_dependencies'), /constraint plan_dependencies_dates_need_a_basis check \(/);
    assert.match(table('plan_dependencies'), /\(needed_by_window_start is null and needed_by_window_end is null\)\s*\n?\s*or \(timing_basis is not null and length\(btrim\(timing_basis\)\) > 0\)/);
  });

  test('and a window that ends before it starts is impossible', () => {
    assert.match(table('plan_dependencies'), /needed_by_window_end >= needed_by_window_start/);
  });

  test('the door refuses it by name, and says what to do', () => {
    assert.match(door('add_plan_dependency'), /return query select 'dates_need_a_basis'/);
    assert.match(SERVICE, /Say where the date came from\. A window with no basis is a promise nobody can defend/);
  });
});

describe('D. the Planning Agent does not take over client communication', () => {
  test('a client-side dependency is always the PM’s — enforced', () => {
    assert.match(table('plan_dependencies'), /constraint plan_dependencies_client_items_are_pms check \(\s*\n?\s*kind not in \('client_information', 'client_access'\) or owner_role = 'project_manager'\s*\n?\s*\)/);
  });

  test('and the door refuses it by name', () => {
    assert.match(door('add_plan_dependency'), /return query select 'client_items_are_pms'/);
    assert.match(SERVICE, /Anything asked of the client is the project manager’s to collect/);
  });

  test('§9’s six dependency types, and no seventh', () => {
    assert.match(table('plan_dependencies'), /kind {13}text not null check \(kind in \(\s*\n?\s*'client_information', 'client_access', 'external_service',\s*\n?\s*'internal_output', 'human_approval', 'finance'\s*\n?\s*\)\)/);
  });

  test('nothing here messages anybody', () => {
    assert.doesNotMatch(SQL, /send_outbound_message|conversation_messages|whatsapp/i);
    // Narrowed to CODE by G-258: the service now explains that the kickoff
    // records rather than sends, because the production WhatsApp number is
    // BLK-003. A sentence saying why nothing is sent is not a send.
    assert.doesNotMatch(SERVICE_CODE, /sendMessage|dispatchMessage|whatsapp/i);
    // The twin: that explanation is present, and its absence would be the
    // defect — a kickoff door that silently did not send would be worse.
    assert.match(SERVICE.replace(/\n \* ?/g, ' '), /it does not send one/);
  });
});

describe('E. a plan is versioned, and history is not rewritten', () => {
  test('a second version must say why it exists', () => {
    assert.match(table('project_plans'), /constraint project_plans_change_reason_from_v2 check \(\s*\n?\s*version = 1 or change_reason is not null\s*\n?\s*\)/);
    assert.match(door('draft_project_plan'), /return query select 'needs_reason'/);
  });

  test('one active plan and one draft, as indexes rather than hopes', () => {
    assert.match(SQL, /create unique index if not exists project_plans_one_active\s*\n\s*on projects\.project_plans \(project_id\) where status = 'active'/);
    assert.match(SQL, /create unique index if not exists project_plans_one_draft\s*\n\s*on projects\.project_plans \(project_id\) where status = 'draft'/);
  });

  test('a live plan changes by drafting the next one; a superseded one not at all', () => {
    const freeze = door('freeze_active_plan');
    // The CONDITIONS, not the sentences beside them. Asserting the message
    // inside a `raise` passes happily when the `if` guarding it is neutered —
    // which is exactly what a red-proof of this control caught.
    assert.match(freeze, /if old\.status = 'superseded' then/);
    assert.match(freeze, /if old\.status = 'active'\s*\n\s*and \(new\.objective is distinct from old\.objective/);
    assert.match(freeze, /or new\.scope_version_id is distinct from old\.scope_version_id/);
    assert.match(freeze, /or new\.version is distinct from old\.version\)/);
  });

  test('and the registers are shut too — in the trigger AND at the door', () => {
    // A rule held by two layers must be tested through both.
    assert.match(door('refuse_write_to_settled_plan'), /if v_status is distinct from 'draft' then/);
    for (const t of ['deliverables', 'dependencies', 'notes']) {
      assert.match(SQL, new RegExp(`create trigger refuse_write_to_settled_plan_${t}\\s*\\n\\s*before insert or update or delete on projects\\.plan_${t}`));
    }
    for (const d of ['add_plan_deliverable', 'add_plan_dependency', 'add_plan_note']) {
      assert.match(door(d), /return query select 'not_draft'/, `${d} lets a live plan be edited`);
    }
  });

  test('an activation carries its moment, and an empty plan cannot go live', () => {
    assert.match(table('project_plans'), /\(status in \('active', 'superseded'\)\) = \(activated_at is not null\)/);
    assert.match(door('activate_project_plan'), /if v_count = 0 then\s*\n\s*return query select 'no_deliverables'/);
    assert.match(SERVICE, /A plan with no deliverables cannot go live/);
  });

  test('and a plan cannot be drafted with no approved scope to plan from', () => {
    assert.match(door('draft_project_plan'), /return query select 'no_scope'/);
    assert.match(SERVICE, /This project has no approved scope version to plan from/);
  });
});

describe('F. the registers §7 asks for, and the one deliberately elsewhere', () => {
  test('risks and assumptions share a table because they are the same shape', () => {
    assert.match(table('plan_notes'), /kind {13}text not null check \(kind in \('risk', 'assumption'\)\)/);
    // §4.7 says "where known" — so an owner is nullable, because inventing one
    // is worse than recording none.
    assert.match(table('plan_notes'), /owner_role {7}text,/);
    assert.match(PROSE, /inventing an owner is worse than recording none/);
  });

  test('the clarification register is NOT folded in with them', () => {
    assert.doesNotMatch(SQL, /'clarification'/);
    assert.match(PROSE, /a thing that gets answered does not share a table with a thing that does not/);
  });
});

describe('G. the discipline every table here carries', () => {
  test('all four are RLS-protected, internal-only, org-frozen and parent-checked', () => {
    // Asserted STATEMENT BY STATEMENT, not by finding the table's name in a
    // list. These were originally written as a `do $$ ... execute format()`
    // loop — shorter, and invisible: `check-record` counts the literal
    // statements to know how many tables are protected, and read all four as
    // unprotected. A control a static check cannot see is one nobody can
    // audit, and a test that only found the name in an array could not tell
    // the difference either.
    for (const t of ['project_plans', 'plan_deliverables', 'plan_dependencies', 'plan_notes']) {
      assert.match(SQL, new RegExp(`alter table projects\\.${t} enable row level security`), `${t}: RLS`);
      assert.match(SQL, new RegExp(`alter table projects\\.${t} force row level security`), `${t}: force`);
      const policy = SQL.indexOf(`create policy ${t}_select on projects.${t}`);
      assert.ok(policy > 0, `${t}: no select policy`);
      assert.match(SQL.slice(policy, policy + 300), /core\.is_internal\(\)/, `${t}: a client can read it`);
      assert.match(SQL, new RegExp(`create trigger freeze_org_${t}[\\s\\S]{0,160}core\\.freeze_organization_id\\(\\)`), `${t}: org not frozen`);
      assert.match(SQL, new RegExp(`create trigger set_updated_at_${t}`), `${t}: updated_at`);
    }
    assert.match(SQL, /enforce_parent_org\('project_id', 'projects\.projects'\)/);
    for (const t of ['plan_deliverables', 'plan_dependencies', 'plan_notes']) {
      assert.match(SQL, new RegExp(`org_match_${t}_plan[\\s\\S]{0,200}enforce_parent_org\\('plan_id', 'projects\\.project_plans'\\)`));
    }
  });

  test('the registers are reachable only through doors — no invoker write policy', () => {
    // Every write in this repository goes through a DEFINER door; the sanity
    // check `invoker writes without a policy: 0` depends on it. Driving this
    // on a scratch Postgres is how the missing doors were found: an
    // authenticated caller could not populate a plan at all.
    assert.doesNotMatch(SQL, /for insert to authenticated|for update to authenticated|for delete to authenticated/);
    for (const d of ['add_plan_deliverable', 'add_plan_dependency', 'add_plan_note']) {
      assert.match(SQL, new RegExp(`grant execute on function projects\\.${d}\\(`), `${d} is defined and ungranted`);
    }
  });

  test('every door is revoked from the world', () => {
    const revoked = [...SQL.matchAll(/revoke all on function projects\.([a-z_]+)\(/g)].map((m) => m[1]);
    const defined = [...SQL.matchAll(/create or replace function projects\.([a-z_]+)\(/g)]
      .map((m) => m[1]!)
      // The two triggers are not callable doors.
      .filter((n) => !['freeze_active_plan', 'refuse_write_to_settled_plan'].includes(n));
    assert.deepEqual([...defined].sort(), [...revoked].sort());
  });

  test('both events are declared before they are emitted', () => {
    for (const type of ['project.plan_drafted', 'project.plan_activated']) {
      assert.match(SQL, new RegExp(`\\('${type.replace('.', '\\.')}'`), `${type} is not declared`);
      assert.match(SQL, new RegExp(`emit_event\\([\\s\\S]{0,140}'${type.replace('.', '\\.')}'`), `${type} is never emitted`);
    }
  });
});
