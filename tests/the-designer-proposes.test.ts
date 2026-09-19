import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The designer proposes — Master §7.5, §11, §12, §18; Designer §4.2, §4.3,
 * §6, §10; ADM-61 §2; G-302 and G-303.
 *
 * Everything Phase 3 had built assumed a person did the design work and
 * recorded it. This is the agent that proposes the two or three directions
 * §4.2 asks for — **at L2 as `draft` work**, which is ADM-61 §2's own
 * category and the same one PR #283 established for this agent's screen
 * inventory. Producing is drafting; approving is §3 work the internal group
 * keeps, and this workflow has no way to reach it.
 *
 * **It writes through the doors a person uses.** The 2–3 ceiling, the
 * context-version idempotency, the three gate statuses that start at draft —
 * none of them is reimplemented, and an agent that bypassed the doors would
 * need every one of them written twice.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const RUNNER = read('app/api/jobs/run/workflows.ts');
const SCHEMA = read('src/modules/projects/schema.ts');
const CATALOG = read('src/lib/events/catalog.ts');
const MIGRATION = read('supabase/migrations/20260920080000_an_agent_is_an_actor_the_door_knows.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const ORIGINAL = read('supabase/migrations/20260918160000_two_or_three_and_not_one_more.sql');

const bounded = (source: string, start: string, next: string) => {
  const i = source.indexOf(start);
  assert.ok(i > 0, `${start} does not exist`);
  const j = source.indexOf(next, i + 1);
  const cut = source.slice(i, j > 0 ? j : undefined);
  assert.ok(cut.length > 0 && cut.length < source.length, `${start} is not bounded`);
  return cut;
};
const workflow = bounded(RUNNER, 'const DESIGN_DIRECTIONS: AgentWorkflow', '\nconst ');
const themeDoor = bounded(SQL, 'create or replace function projects.record_theme_option', '$$;');

describe('A. it drafts at L2, and cannot reach §3 work', () => {
  test('the work class is `draft`, ADM-61 §2’s own category', () => {
    assert.match(workflow, /workClass: 'draft',/);
    assert.match(workflow, /agentKey: 'ui_designer',/);
  });

  test('and the agent it runs as is the one ADM-82 approved for design', () => {
    // Not a fourteenth agent and not a re-levelled one: `ui_designer` already
    // runs the screen inventory at L2 as `draft`.
    assert.match(RUNNER, /agentKey: 'ui_designer',[\s\S]{0,2000}?schemaName: 'ScreenInventory'/);
  });

  test('nothing in the workflow approves, shares or locks', () => {
    for (const door of ['submit_admin_design_decision', 'submit_internal_design_review',
                        'record_design_share', 'lock_phase_three_direction']) {
      assert.ok(!workflow.includes(door), `${door} is reachable from the workflow`);
    }
  });

  test('and the grant is where that boundary is held', () => {
    // An agent cannot call what it was never given. Driven: the service role
    // has no execute on approve, share or lock.
    assert.match(SQL, /grant execute on function projects\.record_theme_option\(uuid, int, text, text, jsonb\) to service_role;/);
    assert.match(SQL, /grant execute on function projects\.record_color_option\(uuid, int, text, text, jsonb, text, text\) to service_role;/);
    assert.equal((SQL.match(/to service_role;/g) ?? []).length, 2);
  });
});

describe('B. the two reasons it could not call the doors at all', () => {
  test('the grant, which refuses before any of the door’s logic runs', () => {
    assert.match(PROSE, /permission\s+denied for function record_theme_option/);
  });

  test('and the actor, because auth.uid() is null for the service role', () => {
    assert.match(themeDoor, /if v_actor is null and \(select auth\.role\(\)\) is distinct from 'service_role' then/);
    assert.match(PROSE, /an\s+agent would be told it is nobody/);
  });

  test('both were found by calling the door, not by reading it', () => {
    assert.match(PROSE, /Found by calling the door as `service_role` on a scratch database, not by\s+reading it/);
  });

  test('the escape follows start_phase_three rather than inventing a mechanism', () => {
    assert.match(
      read('supabase/migrations/20260920040000_a_default_is_not_a_decision.sql'),
      /if v_actor is null and \(select auth\.role\(\)\) is distinct from 'service_role' then/,
    );
  });
});

describe('C. the change is minimal, and every original rule survives', () => {
  test('Designer §2’s baseline rule is still there', () => {
    // The first draft of that migration was written from memory and dropped
    // this. A theme drawn against no agreed screens is a picture.
    assert.match(themeDoor, /if v_baseline = 0 then\s*\n\s*return query select 'no_baseline'::text/);
    assert.match(ORIGINAL, /return query select 'no_baseline'::text/);
  });

  test('the ceiling is still caught as `check_violation`, not `when others`', () => {
    // A blanket handler re-raising only on a substring match would swallow
    // unrelated errors silently.
    assert.match(themeDoor, /exception\s*\n\s*when check_violation then/);
    assert.doesNotMatch(themeDoor, /when others then/);
  });

  test('the return is still three columns, and the outcomes are unrenamed', () => {
    assert.match(themeDoor, /outcome\s+text,\s*\n\s*theme_option_id uuid,\s*\n\s*context_version text/);
    for (const o of ['recorded', 'already_recorded', 'limit_reached', 'no_phase_three', 'no_baseline']) {
      assert.match(themeDoor, new RegExp(`'${o}'::text`), `${o} was renamed or dropped`);
    }
  });

  test('and the event it emits survives', () => {
    assert.match(themeDoor, /perform core\.emit_event\([\s\S]{0,200}?'project\.theme_options_generated'/);
  });

  test('the near-miss is recorded where the next editor will read it', () => {
    assert.match(PROSE, /Rewriting a function means copying it, not remembering it/);
  });
});

describe('D. tenancy does not move, and authorship is honest', () => {
  test('the organisation comes from the phase, never from the caller', () => {
    assert.match(themeDoor, /v_phase3\.organization_id, p_project_id, v_phase3\.id/);
    assert.match(PROSE, /there is no caller-supplied organisation to trust/);
  });

  test('the person check applies only when there is a person', () => {
    assert.match(themeDoor, /if v_actor is not null\s*\n\s*and \(v_phase3\.organization_id is distinct from/);
  });

  test('and it no longer fails open on a NULL role', () => {
    assert.match(themeDoor, /or not coalesce\(\(select core\.can_write\(\)\), false\)\)/);
    assert.doesNotMatch(themeDoor, /or not \(select core\.can_write\(\)\)\)/);
  });

  test('created_by stays null for an agent, because no person drew it', () => {
    assert.match(themeDoor, /v_context, v_actor\s*\n\s*\)/);
    assert.match(PROSE, /`ai\.agent_runs` records\s+which agent, which model and what it cost/);
  });
});

describe('E. §18’s ceiling and reuse, paid for once', () => {
  test('the schema asks for two or three, so a fourth is never generated', () => {
    // The row rule refuses a fourth anyway; asking for one has already paid
    // for the tokens that produced it.
    assert.match(SCHEMA, /\.min\(2, '§18 asks for two or three meaningful directions, not one'\)/);
    assert.match(SCHEMA, /\.max\(3, '§18 asks for two or three meaningful directions, not more'\)/);
  });

  test('and reuse is checked BEFORE the model is called', () => {
    // Presence FIRST. A bare ordering assertion passes when the block is
    // DELETED, because indexOf returns -1 and -1 is less than anything — the
    // same trap G-286's ordering assertions had, made again here.
    assert.ok(workflow.includes('already has directions'), 'the reuse check is gone');
    assert.ok(workflow.includes('await callModel'), 'the model call is gone');
    assert.ok(
      workflow.indexOf('already has directions') < workflow.indexOf('await callModel'),
      'the reuse check runs after the model call',
    );
    assert.match(workflow, /a refused insert has already paid for the\s*\n\s*\/\/ tokens that produced it/);
  });

  test('`limit_reached` and `already_recorded` are not treated as failures', () => {
    assert.match(workflow, /if \(option\?\.outcome !== 'recorded' \|\| !option\.theme_option_id\) continue;/);
    assert.match(workflow, /`limit_reached` and `already_recorded` are not failures/);
  });

  test('a phase waiting on a person is not generated into', () => {
    assert.match(workflow, /\['blocked_requirement', 'scope_escalation', 'revision_limit_escalation', 'completed'\]\.includes\(phase\.state\)/);
  });

  test('and a superseded baseline is not designed against', () => {
    assert.match(workflow, /if \(baseline\.status !== 'finalized'\)/);
  });
});

describe('F. it draws nothing, and the palette tokens are named', () => {
  test('the output schema has no field to claim a Figma artifact', () => {
    const block = bounded(SCHEMA, 'export const designDirectionsSchema', '\nexport type DesignDirections');
    assert.doesNotMatch(block, /figma/i);
    assert.match(SCHEMA, /\*\*No Figma field, and that is the boundary\.\*\*/);
  });

  test('colour is given as named tokens, not swatches', () => {
    // §4.3: "define reusable color tokens instead of only visual swatches."
    assert.match(SCHEMA, /primaryHex: z\.string\(\)\.trim\(\)\.regex\(\/\^#\[0-9a-fA-F\]\{6\}\$\/\)/);
    assert.match(workflow, /p_palette_name: direction\.palette\.paletteName,/);
  });

  test('and the token keys are the camelCase ones the door reads', () => {
    // An earlier draft sent snake_case. The door reads `p_tokens->>'secondary'`,
    // so snake_case is not an error — it silently records only the primary.
    // Driven on a scratch Postgres, both ways.
    assert.match(workflow, /secondary: direction\.palette\.secondaryHex \?\? null,/);
    assert.match(workflow, /textPrimary: direction\.palette\.textPrimaryHex \?\? null,/);
    assert.doesNotMatch(workflow, /secondary_hex: direction\.palette/);
    assert.match(ORIGINAL, /p_tokens->>'secondary'/);
  });

  test('contrast is asked for as a sentence, not a ratio', () => {
    // A number a model produces is a claim about arithmetic it did not do.
    assert.match(SCHEMA, /a number a model produces is a claim about arithmetic\s*\n\s*\* it did not do/);
  });
});

describe('G. it is wired to the moment there is something to draw for', () => {
  test('the trigger is the finalized screen baseline', () => {
    // Phase 3 starting is too early: the baseline does not exist yet.
    assert.match(CATALOG, /'project\.screen_list_finalized': \['ui_designer:designDirections'\],/);
    assert.match(CATALOG, /Phase 3 starting is\s*\n\s*\/\/ too early: the baseline does not exist yet\./);
  });

  test('the handler and its job kind are declared', () => {
    assert.match(CATALOG, /'ui_designer:designDirections',/);
    assert.match(CATALOG, /'ui_designer:designDirections': 'design\.directions',/);
    assert.match(workflow, /jobKind: 'design\.directions',/);
  });

  test('and the runner registers the workflow', () => {
    assert.match(RUNNER, /^\s+DESIGN_DIRECTIONS,$/m);
  });
});
