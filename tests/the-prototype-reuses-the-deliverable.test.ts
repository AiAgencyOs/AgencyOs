import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { prototypeBuildSchema, PROTOTYPE_ELEMENT_TYPES } from '../src/modules/projects/schema.ts';
import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { region, TO_END } from './_region.ts';

/**
 * The prototype reuses the deliverable — PROTO §4, §5, §8; QAP §7; ADM-82.
 * docs/phase-4-gap-analysis.md step 4.
 *
 * The point of this unit: no new review lifecycle was invented. Everything
 * Phase 4 needs beyond `projects.deliverables`' own real, working
 * draft→in_review→approved lifecycle and client-audience approval is exactly
 * one thing — the structured, safe content of the build — plus the one gate
 * deliverables genuinely lacks, independent QA.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260923150000_the_prototype_reuses_the_deliverable.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const WORKFLOWS_TS = read('app/api/jobs/run/workflows.ts');
const WORKFLOW = region(WORKFLOWS_TS, 'const PROTOTYPE_BUILD: AgentWorkflow', '\n/**\n *');
const HANDLERS_TS = read('src/modules/qa/handlers.ts');
const QA_HANDLER = region(HANDLERS_TS, 'export async function handleReviewPrototypeBuild', TO_END);
const RUNNER = read('app/api/jobs/run/route.ts');

const buildDoor = (() => {
  const start = SQL.indexOf('create or replace function projects.record_prototype_build');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

const qaDoor = (() => {
  const start = SQL.indexOf('create or replace function projects.record_prototype_qa_verdict');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

describe('A. no new review lifecycle — deliverables stays the only one', () => {
  test('the build door calls the EXISTING add_deliverable, never a new insert', () => {
    assert.match(buildDoor, /from projects\.add_deliverable\(/);
    assert.doesNotMatch(buildDoor, /insert into projects\.deliverables/);
  });

  test('this table has no status/lifecycle column of its own', () => {
    const table = SQL.slice(SQL.indexOf('create table if not exists projects.prototype_artifacts'), SQL.indexOf('comment on table'));
    assert.doesNotMatch(table, /\bstatus\b/);
  });

  test('QA never touches deliverables.status — the human Submit click stays real', () => {
    assert.doesNotMatch(qaDoor, /update projects\.deliverables/);
    assert.match(
      HANDLERS_TS.replace(/\n\s*\*\s?/g, ' '),
      /The human "Submit for review" action on the existing prototype Admin Panel screen stays a human/,
    );
  });
});

describe('B. structured content only — never raw markup', () => {
  test('the element vocabulary is closed', () => {
    assert.deepEqual([...PROTOTYPE_ELEMENT_TYPES], [
      'heading', 'text', 'button', 'link', 'input', 'image_placeholder', 'list',
    ]);
  });

  test('an unknown element type is refused', () => {
    const bad = prototypeBuildSchema.safeParse({
      screens: [{ screenKey: 'home', elements: [{ type: 'script', label: 'x' }] }],
    });
    assert.equal(bad.success, false);
  });

  test('a valid build parses, including a navigable button', () => {
    const ok = prototypeBuildSchema.safeParse({
      screens: [
        { screenKey: 'home', elements: [{ type: 'button', label: 'Go', navigatesTo: 'dashboard' }] },
        { screenKey: 'dashboard', elements: [{ type: 'heading', label: 'Dashboard' }] },
      ],
    });
    assert.equal(ok.success, true);
  });

  test('the renderer never uses dangerouslySetInnerHTML', () => {
    const renderer = read('app/(internal)/projects/[projectId]/prototype/preview/[uiVersionId]/prototype-screen-view.tsx');
    // The docblock itself names the prop, to explain why it is never used —
    // stripped here so that prose does not make this check pass trivially.
    const code = region(renderer, "export function PrototypeScreenView", TO_END);
    assert.doesNotMatch(code, /dangerouslySetInnerHTML/);
    assert.match(renderer.replace(/\n\s*\*\s?/g, ' '), /Never `dangerouslySetInnerHTML`/);
  });
});

describe('C. the workflow rejects invented screens AND broken routes before persisting', () => {
  test('both checks run before the door is ever called', () => {
    const beforeDoor = WORKFLOW.slice(0, WORKFLOW.indexOf("rpc('record_prototype_build'"));
    assert.match(beforeDoor, /inventedScreens\.length > 0 \|\| brokenTargets\.length > 0/);
  });

  test('a broken route is treated as QAP\'s own named negative test', () => {
    assert.match(
      WORKFLOWS_TS.replace(/\n\s*(\*|\/\/)\s?/g, ' '),
      /exactly the "broken route" QAP's own negative test names/,
    );
  });
});

describe('D. only a LOCKED UI version may build, structurally', () => {
  test('the build door refuses anything but locked', () => {
    assert.match(buildDoor, /if v_version\.status <> 'locked' then/);
    assert.match(buildDoor, /'wrong_state'::text/);
  });

  test('one build per ui_version, enforced by a UNIQUE column not just a check', () => {
    assert.match(SQL, /ui_version_id\s+uuid not null unique references projects\.ui_versions\(id\)/);
  });

  test('a replay answers already_built with the existing ids', () => {
    assert.match(buildDoor, /'already_built'::text, v_existing\.id, v_existing\.deliverable_id/);
  });
});

describe('E. Prototype QA reuses the same producer≠verifier contract as Design QA', () => {
  test('it calls verdictFor with ui_prototype as producer', () => {
    assert.match(QA_HANDLER, /verdictFor\(\[\{ kind: 'record', passed: coverageOk \}\], \{/);
    assert.match(QA_HANDLER, /producer: 'ui_prototype',/);
    assert.match(QA_HANDLER, /verifier: 'quality_assurance',/);
  });

  test('ui_prototype already declares quality_assurance as its verifier', () => {
    const registry = read('src/modules/agents/registry.ts');
    const uiPrototype = region(registry, 'const UI_PROTOTYPE: AgentDefinition', "const HANDOVER: AgentDefinition");
    assert.match(uiPrototype, /verifiedBy: 'quality_assurance'/);
  });

  test('a missing screen AND a broken route are both computed as coverage gaps', () => {
    assert.match(QA_HANDLER, /missingScreens = designScreens\.filter/);
    assert.match(QA_HANDLER, /brokenRoutes = buildScreens/);
  });

  test('idempotent: an already-reviewed build is not re-reviewed', () => {
    assert.match(QA_HANDLER, /if \(artifact\.qa_reviewed_at\)/);
    assert.match(qaDoor, /if v_artifact\.qa_reviewed_at is not null then/);
    assert.match(qaDoor, /'already_reviewed'::text, v_artifact\.id/);
  });
});

describe('F. client access is prepared, not built', () => {
  test('the RLS policy already mirrors deliverables_select\'s client branch', () => {
    assert.match(SQL, /core\.is_client\(\)/);
    assert.match(SQL, /core\.current_client_account_id\(\)/);
    assert.match(SQL, /d\.status <> 'draft'/);
  });

  test('and the preview page says plainly that no client-facing route exists yet', () => {
    const page = read('app/(internal)/projects/[projectId]/prototype/preview/[uiVersionId]/page.tsx');
    assert.match(page.replace(/\n\s*\*\s?/g, ' '), /Staff-only in this pass/);
  });
});

describe('G. the guards every table and door in this repository carries', () => {
  test('both doors are security definer, coalesced can_write, no fail-open', () => {
    for (const door of [buildDoor, qaDoor]) {
      assert.match(door, /not coalesce\(\(select core\.can_write\(\)\), false\)/);
      assert.doesNotMatch(door, /not\s+\(\s*select\s+core\.can_write\s*\(/);
    }
  });

  test('not callable by the world', () => {
    assert.match(SQL, /revoke all on function projects\.record_prototype_build\(uuid, jsonb\) from public, anon/);
    assert.match(SQL, /revoke all on function projects\.record_prototype_qa_verdict\(uuid, text, jsonb\) from public, anon/);
  });

  test('both doors audit and announce inside their own transaction', () => {
    for (const door of [buildDoor, qaDoor]) {
      assert.match(door, /perform core\.record_audit\(/);
      assert.match(door, /perform core\.emit_event\(/);
    }
  });
});

describe('H. it is reachable — the defect this repository has found repeatedly', () => {
  test('the catalog wires both events to their handlers', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.ui_version_locked'], ['ui_prototype:build', 'crm:announceUiVersionLocked']);
    assert.deepEqual(SUBSCRIPTIONS['project.prototype_build_ready'], ['quality_assurance:reviewPrototypeBuild']);
    assert.ok(HANDLERS.includes('ui_prototype:build'));
    assert.ok(HANDLERS.includes('quality_assurance:reviewPrototypeBuild'));
    assert.equal(HANDLER_JOB_KIND['ui_prototype:build'], 'prototype.build');
    assert.equal(HANDLER_JOB_KIND['quality_assurance:reviewPrototypeBuild'], 'prototype.qa_review');
  });

  test('the AI workflow is registered so its job kind is actually claimed', () => {
    assert.match(WORKFLOWS_TS, /jobKind: 'prototype\.build'/);
    assert.match(WORKFLOWS_TS, /agentKey: 'ui_prototype'/);
    const registration = region(WORKFLOWS_TS, 'export const AGENT_WORKFLOWS', TO_END);
    assert.match(registration.slice(0, 500), /PROTOTYPE_BUILD/);
  });

  test('the runner drains the QA job kind', () => {
    assert.match(RUNNER, /const PROTOTYPE_QA_JOB_KIND = HANDLER_JOB_KIND\['quality_assurance:reviewPrototypeBuild'\]/);
    assert.match(RUNNER, /handleReviewPrototypeBuild/);
  });
});
