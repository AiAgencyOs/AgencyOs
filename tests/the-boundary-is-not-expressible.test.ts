import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AGENT_KEYS } from '../src/modules/agents/registry.ts';

/**
 * The boundary is not expressible — Project Planning §5 and §6.
 *
 * §6 is the one line of the Phase 2 specification that exists to stop two
 * agents becoming one: *"Both agents are necessary because planning the agency
 * lifecycle and planning the software implementation are different
 * responsibilities."* §5 lists thirteen things the Project Planning Agent must
 * **not** do, and the traceability matrix has carried this row as `N/A yet`
 * with one instruction against it since the first sweep:
 *
 *   *"The boundary must be enforced in the prompt AND asserted in a test."*
 *
 * **Half of that instruction is not buildable and saying so is the point.**
 * There is no project-planning agent and no prompt to put anything in: the
 * registry defines an agent by what it IS, ADM-82 granted thirteen agents and
 * explicitly withheld implementation, and a definition naming tools nothing
 * implements is the exact defect the registry was written to remove. Writing a
 * prompt for an agent that does not run would be writing the reassurance and
 * not the control.
 *
 * So this is the other half, and it is the half that actually holds: **the
 * forbidden states are not expressible.** Same doctrine as the registry's own
 * `moneyAuthority` having no `decides` member — a rule the schema cannot state
 * is stronger than a rule a prompt asks for.
 */

const root = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(root(rel), 'utf8');
const BLUEPRINT = read('supabase/migrations/20260917140000_the_operational_blueprint.sql');
const TIMELINE = read('supabase/migrations/20260917190000_the_plan_has_a_shape_in_time.sql');
const CLARIFY = read('supabase/migrations/20260917150000_the_clarification_loop.sql');
const VALIDATE = read('supabase/migrations/20260917210000_a_plan_that_validates_itself.sql');

/** Every column name the plan's own tables define. */
const planColumns = (() => {
  const columns: string[] = [];
  for (const [source, tables] of [
    [BLUEPRINT, ['project_plans', 'plan_deliverables', 'plan_dependencies', 'plan_notes']],
    [TIMELINE, ['plan_milestones', 'plan_milestone_dependencies']],
    [CLARIFY, ['plan_clarifications']],
  ] as const) {
    for (const table of tables) {
      const start = source.indexOf(`create table if not exists projects.${table} (`);
      assert.ok(start > 0, `${table} is not defined`);
      const body = source.slice(start, source.indexOf('\n);', start));
      for (const line of body.split('\n').slice(1)) {
        const match = /^\s{2}([a-z_]+)\s+(uuid|text|int|bigint|date|boolean|jsonb|numeric|timestamptz)/.exec(line);
        if (match?.[1]) columns.push(match[1]);
      }
    }
  }
  assert.ok(columns.length > 40, `only ${columns.length} columns found — the scan is broken`);
  return columns;
})();

describe('A. §5’s technical prohibitions have nowhere to land', () => {
  test('the scan actually found the plan’s columns, so an absence means something', () => {
    // An absence-only assertion passes just as well against an empty list.
    // These are the positives that prove the scan is looking at the right rows.
    for (const column of ['readiness_criteria', 'evidence_required', 'applicable_phase', 'gate_criteria']) {
      assert.ok(planColumns.includes(column), `${column} is missing — the plan is not what it was`);
    }
  });

  test('no column can hold a database design', () => {
    // §5: "Must not design database schemas/tables."
    for (const forbidden of ['schema_design', 'table_design', 'data_model', 'er_diagram', 'migration_plan']) {
      assert.ok(!planColumns.includes(forbidden), `plan tables can hold ${forbidden}`);
    }
  });

  test('no column can hold an API contract', () => {
    // §5: "Must not design API endpoints/contracts as a technical architect."
    // `\bendpoint\b` does NOT match `api_endpoint` — a red-proof taught that
    // once already — so the check is a substring over the whole name.
    for (const column of planColumns) {
      assert.ok(
        !/endpoint|api_contract|openapi|request_schema|response_schema/.test(column),
        `${column} is an API contract`,
      );
    }
  });

  test('no column can hold a technology choice', () => {
    // §5: "Must not choose frameworks/libraries/models as an implementation
    // decision unless already locked as project context."
    for (const column of planColumns) {
      assert.ok(
        !/framework|library|tech_stack|runtime|model_choice/.test(column),
        `${column} is a technology decision`,
      );
    }
  });

  test('no column can hold a coding task or a UI design', () => {
    // §5: "Must not create detailed coding tasks for developers", "Must not
    // perform UI design", "Must not perform QA testing".
    for (const column of planColumns) {
      assert.ok(
        !/coding_task|ticket|estimate_hours|story_point|wireframe|mockup|figma|test_case/.test(column),
        `${column} is Phase 5 or Phase 6 work`,
      );
    }
  });

  test('and the schema SAYS it holds the boundary this way', () => {
    // So the next person adding a column finds the rule where they are working
    // rather than in a specification they have not read.
    assert.match(
      BLUEPRINT.replace(/\n\s*--\s?/g, ' '),
      /this schema holds that boundary by having nowhere to put them/,
    );
    assert.match(
      BLUEPRINT.replace(/\n\s*--\s?/g, ' '),
      /A Development Planning Agent gets its own tables when Phase 5 builds one/,
    );
  });
});

describe('B. the prohibitions the schema holds actively, not by absence', () => {
  test('“must not modify approved scope” — a deliverable REFERENCES scope, never edits it', () => {
    // G-256: every deliverable must name approved scope, and G-265 made
    // leaving one out a validation failure. Neither lets a plan write scope.
    assert.match(BLUEPRINT, /scope_item_id\s+uuid references projects\.scope_items\(id\) on delete restrict/);
    assert.match(BLUEPRINT, /proposal_item_id\s+uuid references sales\.proposal_items\(id\) on delete restrict/);
    for (const door of ['draft_project_plan', 'add_plan_deliverable', 'add_plan_dependency']) {
      const start = BLUEPRINT.indexOf(`create or replace function projects.${door}`);
      const body = BLUEPRINT.slice(start, BLUEPRINT.indexOf('$$;', start));
      assert.doesNotMatch(body, /insert into projects\.scope_items|update projects\.scope_items|update sales\./);
    }
  });

  test('“must not convert an ambiguous requirement into an invented requirement”', () => {
    // §10's clarification loop: a plan cannot activate with an open question.
    assert.match(VALIDATE, /plan_clarifications|open question/i);
    assert.match(CLARIFY, /create table if not exists projects\.plan_clarifications/);
  });

  test('“must not promise dates that are not supported”', () => {
    // A dated window carries a required basis, so a date with no stated
    // support cannot be written down.
    assert.match(TIMELINE, /timing_basis/);
    assert.match(
      TIMELINE.replace(/\n\s*--\s?/g, ' '),
      /basis/i,
    );
  });

  test('“must not approve payment or bypass Finance/Admin gates”', () => {
    // A finance-gate milestone POINTS AT a payment milestone. It carries no
    // money of its own, writes none, and cannot verify any.
    assert.match(TIMELINE, /payment_milestone_id\s+uuid references projects\.milestones\(id\) on delete restrict/);
    assert.doesNotMatch(TIMELINE, /amount_minor|verified_minor|finance\.payments|verify_payment/);
    assert.doesNotMatch(BLUEPRINT, /amount_minor|verified_minor|finance\.payments|verify_payment/);
  });
});

describe('C. §6’s two agents stay two', () => {
  test('no project-planning agent is defined, and that is the honest state', () => {
    // ADM-82 granted thirteen agents and withheld implementation. A definition
    // naming tools nothing implements is the defect the registry was written
    // to remove — told in TypeScript instead of in seed data.
    const keys = AGENT_KEYS;
    assert.ok(!keys.includes('project_planning'), 'a project-planning agent appeared — assert its boundary');
    assert.ok(!keys.includes('development_planning'), 'a development-planning agent appeared — Phase 5 does not exist');
    // The positive twin: the registry is populated, so this is a real absence
    // rather than an empty list agreeing with everything.
    assert.ok(keys.length >= 8, `only ${keys.length} agents defined — the registry scan is wrong`);
  });

  test('nothing in the repository has quietly merged the two responsibilities', () => {
    // The one line §6 exists for. A single "planning agent" key, or a plan
    // table living beside development artifacts, is how two responsibilities
    // become one without anybody deciding to merge them.
    const migrations = readdirSync(root('supabase/migrations')).filter((f) => f.endsWith('.sql'));
    const offenders = migrations.filter((file) => {
      const sql = readFileSync(root(`supabase/migrations/${file}`), 'utf8').replace(/^\s*--.*$/gm, '');
      return /create table[^;]*projects\.plan_[a-z_]*\s*\([^;]*\b(endpoint|schema_design|coding_task|wireframe)\b/s.test(sql);
    });
    assert.deepEqual(offenders, [], 'a plan table grew a Phase 5 column');
  });

  test('the split is recorded where somebody deciding would look', () => {
    assert.match(
      BLUEPRINT.replace(/\n\s*--\s?/g, ' '),
      /§6 tabulates the split/,
    );
  });
});

describe('D. the half of the instruction that is NOT built, said plainly', () => {
  test('there is no prompt layer for a planning agent to be constrained in', () => {
    // The matrix asks for the boundary "enforced in the prompt AND asserted in
    // a test". The prompt half has nowhere to live: the registry describes
    // what an agent IS and carries no instruction text at all.
    const registry = read('src/modules/agents/registry.ts');
    assert.doesNotMatch(registry, /systemPrompt|instructions:|promptTemplate/);
    // So the claim is not that the prompt half was done. It is that it cannot
    // be done yet, and the structural half does not depend on it.
    assert.match(
      read('docs/phase2/AGENCYOS_PHASE2_TRACEABILITY.md'),
      /the prompt half has nowhere to live/,
    );
  });
});
