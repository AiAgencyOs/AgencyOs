import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The clarification loop — Project Planning §4.1, §5, §10, §14, PLAN-I08/I09.
 *
 * §10 is two sentences that are one rule:
 *
 *   *"Planning Agent never guesses an unclear client requirement."*
 *   *"If clarification implies a new/out-of-scope requirement, route to the
 *    appropriate scope/change process instead of silently adding it."*
 *
 * So a question has **exactly two honest endings** — answered, or become a
 * change request — and what is asserted here is that there is no third one,
 * and that a plan cannot go live while a question is still open.
 *
 * Behaviour is proven where SQL runs; five structural guards were refused on
 * direct writes against a scratch Postgres, including both branches of the
 * freeze trigger separately.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260917150000_the_clarification_loop.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const BLUEPRINT = read('supabase/migrations/20260917140000_the_operational_blueprint.sql');
const SERVICE = read('src/modules/projects/planning.ts');

const tableSql = (() => {
  const start = SQL.indexOf('create table if not exists projects.plan_clarifications');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('create index', start));
})();
const door = (name: string) => {
  const start = SQL.indexOf(`create or replace function projects.${name}`);
  assert.ok(start > 0, `${name} is not defined`);
  return SQL.slice(start, SQL.indexOf('$$;', start));
};

describe('A. two honest endings, and no third', () => {
  test('the states are exactly §10’s chain plus its two endings', () => {
    assert.match(
      tableSql,
      /status {11}text not null default 'open' check \(status in\s*\n?\s*\('open', 'asked', 'answered', 'resolved', 'routed_to_change_request'\)\)/,
    );
    // No state meaning "we worked out what they probably meant".
    assert.doesNotMatch(tableSql, /'assumed'|'inferred'|'presumed'|'defaulted'/);
    assert.match(PROSE, /There is no third ending\s+where an ambiguity quietly becomes a deliverable/);
  });

  test('a routed question NAMES the change request, and only a routed one carries it', () => {
    // Both directions: routed implies a reference, and a reference implies
    // routed. A half of either is a claim the row cannot support.
    assert.match(
      tableSql,
      /constraint plan_clarifications_routed_names_the_request check \(\s*\n?\s*\(status = 'routed_to_change_request'\) = \(change_request_id is not null\)\s*\n?\s*\)/,
    );
  });

  test('the change process is referenced, not re-invented', () => {
    assert.match(tableSql, /change_request_id uuid references projects\.change_requests\(id\) on delete restrict/);
    // No second copy of a change request's fields.
    assert.doesNotMatch(tableSql, /classification|timeline_days|effort_hours|proposal_id/);
    assert.match(PROSE, /not copying its fields into a second table that would drift from it/);
  });

  test('routing to another project’s change request is refused by name', () => {
    assert.match(door('route_clarification_to_change_request'), /return query select 'wrong_project'/);
    assert.match(SERVICE, /That change request belongs to a different project/);
  });
});

describe('B. a plan cannot go live carrying an open question', () => {
  test('the gate is in activate_project_plan, and names the states that count as settled', () => {
    const activate = door('activate_project_plan');
    assert.match(activate, /from projects\.plan_clarifications c/);
    assert.match(activate, /and c\.status not in \('resolved', 'routed_to_change_request'\)/);
    assert.match(activate, /return query select 'open_clarifications'/);
  });

  test('the door was carried forward VERBATIM, with its edits marked', () => {
    const v1 = BLUEPRINT.slice(
      BLUEPRINT.indexOf('create or replace function projects.activate_project_plan'),
    );
    // From the RAW migration, not the comment-stripped SQL: the edit markers
    // are themselves comments, and `door()` would have removed the very thing
    // this test is about.
    const rawStart = MIGRATION.indexOf('create or replace function projects.activate_project_plan');
    const v2 = MIGRATION.slice(rawStart, MIGRATION.indexOf('$$;', rawStart));
    assert.match(v2, /\[G-257 edit 1 of 2\]/);
    assert.match(v2, /\[G-257 edit 2 of 2\]/);
    assert.equal((v2.match(/\[G-257 edit \d of 2\]/g) ?? []).length, 2, 'more edits than are marked');

    // Every line of the original that is not part of a marked edit must still
    // be present, unchanged. This is what makes "carried forward" a fact
    // rather than an intention.
    const original = v1
      .slice(0, v1.indexOf('$$;'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('--'));
    const carried = v2.split('\n').map((l) => l.trim());
    const missing = original.filter((l) => !carried.includes(l));
    assert.deepEqual(missing, [], 'lines dropped in the carry-forward');
  });

  test('and the service says what to do about it rather than just refusing', () => {
    assert.match(SERVICE, /case 'open_clarifications':/);
    assert.match(SERVICE, /Resolve them, or route them to a change request/);
  });
});

describe('C. nothing is closed by deciding what the client meant', () => {
  test('a question cannot be resolved without an answer', () => {
    const fn = door('resolve_clarification');
    assert.match(fn, /if v_row\.status <> 'answered' then\s*\n\s*return query select 'no_answer'/);
    assert.match(SERVICE, /Closing a question with no answer is deciding what the client meant/);
  });

  test('an answer to a question nobody asked is refused', () => {
    assert.match(door('record_clarification_answer'), /if v_row\.status = 'open' then\s*\n\s*return query select 'not_asked'/);
    assert.match(SERVICE, /Record that the question was asked before recording an answer to it/);
  });

  test('and an empty answer is not an answer', () => {
    const fn = door('record_clarification_answer');
    // Refused before the lock: a caller who sent whitespace learns that
    // without holding one.
    const refusal = fn.indexOf("'empty_answer'");
    const lock = fn.indexOf('for update;');
    assert.ok(refusal > 0 && lock > refusal);
  });

  test('every state carries its moment, so half a transition cannot be stored', () => {
    for (const shape of ['asked_shape', 'answered_shape', 'resolved_shape']) {
      assert.match(tableSql, new RegExp(`constraint plan_clarifications_${shape} check`), `${shape} missing`);
    }
    assert.match(tableSql, /\(status in \('answered', 'resolved'\)\) = \(answer is not null\)/);
  });

  test('a question that has been asked cannot be reworded', () => {
    // They answered THAT question. Editing it afterwards makes their answer
    // mean something they did not say.
    const freeze = door('freeze_settled_clarification');
    assert.match(freeze, /if old\.status <> 'open' and new\.question is distinct from old\.question then/);
    assert.match(freeze, /the question was already put to the client and cannot be reworded now/);
  });

  test('and a settled one cannot be edited at all', () => {
    const freeze = door('freeze_settled_clarification');
    assert.match(freeze, /if old\.status in \('resolved', 'routed_to_change_request'\)/);
    assert.match(freeze, /new\.answer is distinct from old\.answer/);
  });
});

describe('D. evidence, and the PM’s side of the loop', () => {
  test('a question points at what made it ambiguous', () => {
    assert.match(
      tableSql,
      /constraint plan_clarifications_has_a_source check \(\s*\n?\s*scope_item_id is not null or deliverable_id is not null\s*\n?\s*\)/,
    );
    assert.match(door('raise_clarification'), /return query select 'no_source'/);
    assert.match(SERVICE, /a question with no source is an assertion/);
  });

  test('impact is required, because a question nobody can price is a question nobody answers', () => {
    assert.match(tableSql, /impact {11}text not null check \(length\(btrim\(impact\)\) > 0\)/);
  });

  test('only raising is the agent’s; every client-facing step needs a person', () => {
    // The agent finds ambiguity. Asking a client, hearing back, and deciding
    // which ending it has are all things that happen outside this system.
    assert.match(door('raise_clarification'), /if v_actor is null and \(select auth\.role\(\)\) is distinct from 'service_role'/);
    for (const name of ['mark_clarification_asked', 'record_clarification_answer', 'resolve_clarification', 'route_clarification_to_change_request']) {
      assert.match(door(name), /if v_actor is null then\s*\n\s*return query select 'needs_person'/, `${name} lets nobody witness it`);
    }
    // And the grants match the refusals.
    assert.match(SQL, /grant execute on function projects\.raise_clarification\(uuid, text, text, uuid, uuid\) to authenticated, service_role;/);
    for (const sig of ['mark_clarification_asked\\(uuid\\)', 'resolve_clarification\\(uuid\\)']) {
      assert.match(SQL, new RegExp(`grant execute on function projects\\.${sig} to authenticated;`));
      assert.doesNotMatch(SQL, new RegExp(`grant execute on function projects\\.${sig} to authenticated, service_role`));
    }
  });

  test('nothing in the loop sends anything', () => {
    assert.doesNotMatch(SQL, /send_outbound_message|conversation_messages|whatsapp|template/i);
    assert.match(PROSE, /Nothing here messages anybody/);
  });
});

describe('E. the discipline every table here carries', () => {
  test('RLS, force, an internal-only policy, and a guard on every org-scoped key', () => {
    assert.match(SQL, /alter table projects\.plan_clarifications enable row level security/);
    assert.match(SQL, /alter table projects\.plan_clarifications force row level security/);
    const policy = SQL.indexOf('create policy plan_clarifications_select');
    assert.ok(policy > 0);
    assert.match(SQL.slice(policy, policy + 300), /core\.is_internal\(\)/);
    // All four foreign keys, not just the obvious parent — the omission CI
    // caught on G-256.
    for (const [col, parent] of [
      ['plan_id', 'projects.project_plans'],
      ['scope_item_id', 'projects.scope_items'],
      ['deliverable_id', 'projects.plan_deliverables'],
      ['change_request_id', 'projects.change_requests'],
    ] as const) {
      assert.match(
        SQL,
        new RegExp(`enforce_parent_org\\('${col}', '${parent.replace('.', '\\.')}'\\)`),
        `${col} has no org-consistency guard`,
      );
    }
    assert.match(SQL, /create trigger freeze_org_plan_clarifications/);
    assert.match(SQL, /create trigger set_updated_at_plan_clarifications/);
  });

  test('every door is revoked from the world', () => {
    const revoked = new Set([...SQL.matchAll(/revoke all on function projects\.([a-z_]+)\(/g)].map((m) => m[1]));
    const defined = [...SQL.matchAll(/create or replace function projects\.([a-z_]+)\(/g)]
      .map((m) => m[1]!)
      // The trigger is not a callable door; `activate_project_plan` was
      // revoked by the migration that first defined it.
      .filter((n) => !['freeze_settled_clarification', 'activate_project_plan'].includes(n));
    for (const name of defined) assert.ok(revoked.has(name), `${name} is callable by PUBLIC`);
  });

  test('both events are declared before they are emitted', () => {
    for (const type of ['project.clarification_required', 'project.clarification_resolved']) {
      assert.match(SQL, new RegExp(`\\('${type.replace('.', '\\.')}'`), `${type} is not declared`);
      assert.match(SQL, new RegExp(`emit_event\\([\\s\\S]{0,160}'${type.replace('.', '\\.')}'`), `${type} is never emitted`);
    }
    // And no semicolon inside a description, which would hide every later
    // tuple from the declaration check — the trap G-256 hit.
    const declaration = SQL.slice(SQL.indexOf('into core.event_types'), SQL.indexOf('on conflict (type)'));
    assert.equal(declaration.includes(';'), false, 'a semicolon here hides the later declarations');
  });
});
