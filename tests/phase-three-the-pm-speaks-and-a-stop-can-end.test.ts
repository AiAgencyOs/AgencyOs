import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { HANDLER_JOB_KIND, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { figmaViewUrl, optionLines } from '../src/modules/projects/pm-design-comms.ts';

const read = (p: string) => readFileSync(p, 'utf8');
const migration = read('supabase/migrations/20261012100000_a_stopped_phase_has_a_person_who_restarts_it.sql');

// Phase 3 PM §7.1/§15, Master §16-§17. Driving the whole flow (scripts/verify-phase-three-e2e.mjs) found
// four things built and unreachable; these hold the seams a live run cannot see.

describe('the PM speaks to the client during Phase 3', () => {
  test('the Phase 3 start and the client selection each have a handler, and both have a job kind', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.phase_three_started'], ['projects:announcePhaseThree']);
    assert.deepEqual(SUBSCRIPTIONS['project.client_design_selected'], ['projects:askFinalDesignConfirmation']);
    assert.equal(HANDLER_JOB_KIND['projects:announcePhaseThree'], 'pm.phase3_announce');
    assert.equal(HANDLER_JOB_KIND['projects:askFinalDesignConfirmation'], 'pm.design_final_ask');
  });

  test('both handlers are drained by the job runner, not just declared', () => {
    const route = read('app/api/jobs/run/route.ts');
    assert.match(route, /runEventJobs\(admin, PM_PHASE3_ANNOUNCE_JOB_KIND, handleAnnouncePhaseThree/);
    assert.match(route, /runEventJobs\(admin, PM_DESIGN_FINAL_ASK_JOB_KIND, handleAskFinalConfirmation/);
  });

  test('the handlers take the project from the row, never the event payload', () => {
    const src = read('src/modules/projects/pm-design-comms.ts');
    assert.match(src, /from\('phase_three'\)[\s\S]{0,200}\.eq\('id', phaseId\)/);
    assert.match(src, /from\('client_design_decisions'\)[\s\S]{0,200}\.eq\('id', decisionId\)/);
    assert.doesNotMatch(src, /payload\??\.projectId/);
  });

  test('the shared-options message lists each option with a Figma or preview link, in order', () => {
    const body = optionLines([
      { optionIndex: 2, name: 'Bold', figmaUrl: null, previewUrl: 'https://example.com/b.png' },
      { optionIndex: 1, name: 'Calm', figmaUrl: figmaViewUrl('FILEKEY', '1:1'), previewUrl: null },
    ]);
    assert.equal(body, '1. Calm - https://www.figma.com/design/FILEKEY?node-id=1-1\n2. Bold - https://example.com/b.png');
    assert.equal(figmaViewUrl(null, '1:1'), null);
  });
});

describe('the screen list can be opened and finalized from the app', () => {
  test('finalize_screen_baseline is reachable: service, action, form and page', () => {
    assert.match(read('src/modules/projects/screen-service.ts'), /rpc\('finalize_screen_baseline'/);
    assert.match(read('src/modules/projects/screen-actions.ts'), /export async function finalizeScreenBaselineAction/);
    assert.match(read('app/(internal)/projects/[projectId]/design/screens/screen-forms.tsx'), /finalizeScreenBaselineAction/);
    assert.match(read('app/(internal)/projects/[projectId]/design/screens/page.tsx'), /<ScreenBaselinePanel/);
  });
});

describe('a stopped phase has a door out, and only an admin holds it', () => {
  test('the door re-checks the admin tier, needs a note, and names the resolution per stop', () => {
    const start = migration.indexOf('create or replace function projects.resolve_phase_three_stop');
    const body = migration.slice(start, migration.indexOf('comment on function projects.resolve_phase_three_stop', start));
    assert.match(body, /core\.is_admin\(\)/);
    assert.match(body, /needs_note/);
    const pairs: [string, string][] = [
      ["scope_escalation'          and p_resolution = 'declined_continue", 'waiting_client'],
      ["revision_limit_escalation' and p_resolution = 'allow_more_rounds", 'revision'],
      ["blocked_requirement'       and p_resolution = 'requirement_supplied", 'screen_definition'],
    ];
    for (const [when, then] of pairs) {
      assert.ok(body.includes(when), when);
      assert.ok(body.includes(`then '${then}'`), then);
    }
  });

  test('a resolution is immutable history, and the table has no end-user write grant', () => {
    assert.match(migration, /before update or delete on projects\.phase_three_stop_resolutions/);
    assert.match(migration, /revoke all on table projects\.phase_three_stop_resolutions from public, anon, authenticated/);
    assert.doesNotMatch(migration, /grant (insert|update|delete)[^;]*phase_three_stop_resolutions to[^;]*authenticated/);
  });

  test('the stop screen offers the door to a person', () => {
    assert.match(read('src/modules/projects/design.ts'), /rpc\('resolve_phase_three_stop'/);
  });
});
