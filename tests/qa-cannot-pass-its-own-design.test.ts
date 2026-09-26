import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { region, TO_END } from './_region.ts';

/**
 * QA cannot pass its own design — QAP §7; UID §19; ADM-82.
 * docs/phase-4-gap-analysis.md step 3's Design QA increment.
 *
 * The point of this unit: Design QA's verdict is decided by the SAME
 * producer≠verifier contract (`src/modules/agents/verification.ts`) every
 * other completion in this codebase goes through, not a bespoke rule
 * invented for this one case.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260923120000_qa_cannot_pass_its_own_design.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const HANDLERS_TS = read('src/modules/qa/handlers.ts');
const HANDLER = region(HANDLERS_TS, 'export async function handleReviewUIVersion', TO_END);
const RUNNER = read('app/api/jobs/run/route.ts');
const VERIFICATION_TS = read('src/modules/agents/verification.ts');

const door = (() => {
  const start = SQL.indexOf('create or replace function projects.record_ui_version_qa_verdict');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

describe('A. the verdict reuses the existing ADM-82 contract, not a new rule', () => {
  test('the handler calls verdictFor, not a bespoke Design QA check', () => {
    assert.match(HANDLERS_TS, /import \{ verdictFor \} from '@\/modules\/agents\/verification'/);
    assert.match(HANDLER, /verdictFor\(\[\{ kind: 'record', passed: coverageOk \}\], \{/);
    assert.match(HANDLER, /producer: 'ui_designer',/);
    assert.match(HANDLER, /verifier: 'quality_assurance',/);
  });

  test('and that contract genuinely refuses a producer verifying itself', () => {
    assert.match(VERIFICATION_TS, /if \(context\.verifier === context\.producer\) \{/);
    assert.match(VERIFICATION_TS, /cannot verify its own work/);
  });

  test('ui_designer already declares quality_assurance as its verifier — not invented for this handler', () => {
    const registry = read('src/modules/agents/registry.ts');
    const uiDesigner = region(registry, "const UI_DESIGNER: AgentDefinition", "const UI_PROTOTYPE: AgentDefinition");
    assert.match(uiDesigner, /verifiedBy: 'quality_assurance'/);
  });
});

describe('B. coverage checks only what is objective, and says so', () => {
  test('missing screens and missing declared states are both computed', () => {
    assert.match(HANDLER, /missingScreens\.push\(key\)/);
    assert.match(HANDLER, /stateGaps\.push\(/);
  });

  test('consistency/token-usage/usability are named as an explicit non-goal, not silently skipped', () => {
    const prose = HANDLERS_TS.replace(/\n\s*\*\s?/g, ' ');
    assert.match(prose, /Consistency, token usage and usability are real Design QA requirements this handler does not judge/);
  });
});

describe('C. idempotent by construction', () => {
  test('a version already past draft is treated as success, not re-reviewed', () => {
    assert.match(HANDLER, /if \(version\.status !== 'draft'\)/);
    assert.match(HANDLER, /outcome: 'already_reviewed'/);
  });

  test('and the door refuses to overwrite an existing verdict on replay', () => {
    assert.match(door, /if v_version\.status <> 'draft' then/);
    assert.match(door, /'already_reviewed'::text, v_version\.id/);
  });
});

describe('D. the guards every table and door in this repository carries', () => {
  test('the door is security definer, coalesced can_write, no fail-open', () => {
    assert.match(SQL, /security definer\s*\nset search_path = ''/);
    assert.match(door, /not coalesce\(\(select core\.can_write\(\)\), false\)/);
    assert.doesNotMatch(door, /not\s+\(\s*select\s+core\.can_write\s*\(/);
  });

  test('an unattended caller is refused unless it is the service role', () => {
    assert.match(door, /if v_actor is null and \(select auth\.role\(\)\) is distinct from 'service_role' then/);
  });

  test('not callable by the world', () => {
    assert.match(SQL, /revoke all on function projects\.record_ui_version_qa_verdict\(uuid, text, jsonb\) from public, anon/);
    assert.match(SQL, /grant execute on function projects\.record_ui_version_qa_verdict\(uuid, text, jsonb\) to authenticated, service_role/);
  });

  test('a qa_pass or qa_changes_required row must carry a reviewed timestamp', () => {
    assert.match(SQL, /constraint ui_versions_qa_reviewed_is_dated/);
    assert.match(SQL, /check \(status = 'draft' or qa_reviewed_at is not null\)/);
  });

  test('it audits and announces inside the same transaction', () => {
    assert.match(door, /perform core\.record_audit\(/);
    assert.match(door, /perform core\.emit_event\(/);
    assert.match(SQL, /insert into core\.event_types/);
  });
});

describe('E. it is reachable — the defect this repository has found repeatedly', () => {
  test('the catalog subscribes it to the event the draft door already emits', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.ui_version_drafted'], ['quality_assurance:reviewUIVersion']);
    assert.ok(HANDLERS.includes('quality_assurance:reviewUIVersion'));
    assert.equal(HANDLER_JOB_KIND['quality_assurance:reviewUIVersion'], 'ui_version.qa_review');
  });

  test('the runner drains that job kind', () => {
    assert.match(RUNNER, /const UI_VERSION_QA_JOB_KIND = HANDLER_JOB_KIND\['quality_assurance:reviewUIVersion'\]/);
    assert.match(RUNNER, /handleReviewUIVersion/);
    assert.match(RUNNER, /UI_VERSION_QA_JOB_KIND,\s*\n\s*handleReviewUIVersion/);
  });
});

describe('F. additive schema, not a rewrite', () => {
  test('qa columns extend ui_versions rather than a new table', () => {
    assert.match(SQL, /alter table projects\.ui_versions\s*\n\s*add column if not exists qa_findings/);
    assert.doesNotMatch(SQL, /create table/i);
  });
});
