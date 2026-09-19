import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { region } from './_region.ts';

/**
 * The lock has a button — Master §7.11, §7.12; PM §4.10; Designer §4.9; G-289.
 *
 * The last Phase 3 door without a caller, and the one whose signature is the
 * whole point. G-285 built `lock_phase_three_direction` to take **only the
 * phase**: it reads the client's `final_confirmed` decision to learn what to
 * lock, so a caller cannot lock something the client never confirmed.
 *
 * A surface can give that back. A form with a theme picker on it would put
 * §16's no-silent-overwrite rule back in the hands of whoever last touched a
 * dropdown — which is exactly where G-285 took it from.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const SERVICE = read('src/modules/projects/design.ts');
const ACTIONS = read('src/modules/projects/actions.ts');
const FORMS = read('app/(internal)/projects/[projectId]/design/design-forms.tsx');
const PAGE = read('app/(internal)/projects/[projectId]/design/page.tsx');
const LOCK = read('supabase/migrations/20260919180000_the_lock_is_what_the_client_confirmed.sql');

// BOUNDED. An open-ended slice swallowed G-293's form, appended after this
// one, and its <select> failed the "no picker" assertion. Third instance of
// this shape in this suite.
const lockForm = (() => {
  const start = FORMS.indexOf('export function LockDirectionForm');
  const end = FORMS.indexOf('\nexport function ', start + 1);
  const cut = FORMS.slice(start, end > 0 ? end : undefined);
  assert.ok(cut.length > 0 && cut.length < FORMS.length, 'the lock form is not bounded');
  return cut;
})();
const lockService = (() => {
  const start = SERVICE.indexOf('export async function lockPhaseThreeDirection');
  const end = SERVICE.indexOf('\nexport async function ', start + 1);
  const cut = SERVICE.slice(start, end > 0 ? end : undefined);
  assert.ok(cut.length > 0 && cut.length < SERVICE.length, 'the lock service is not bounded');
  return cut;
})();

describe('A. nothing in this surface says what to lock', () => {
  test('the service passes the phase and nothing else', () => {
    assert.match(lockService, /rpc\('lock_phase_three_direction', \{\s*\n\s*p_phase_three_id: input\.phaseThreeId,\s*\n\s*\}\)/);
    assert.doesNotMatch(lockService, /p_theme_option_id|p_color_option_id|themeOptionId/);
  });

  test('the form has no picker of any kind', () => {
    assert.doesNotMatch(lockForm, /<select|name="themeOptionId"|name="colorOptionId"/);
    assert.match(lockForm, /<input type="hidden" name="phaseThreeId" value=\{phaseThreeId\} \/>/);
  });

  test('and the door it fronts still takes only the phase', () => {
    // The positive twin. If that signature ever grew arguments, this surface
    // would be free to fill them.
    assert.match(LOCK, /create or replace function projects\.lock_phase_three_direction\(\s*\n\s*p_phase_three_id uuid\s*\n\)/);
  });

  test('the confirmation shown is a label, not a decision', () => {
    // The page reads it to word the button; the door reads it again to act.
    // If they ever disagree the door wins and refuses.
    assert.match(PAGE, /const confirmation = trail\.clientDecisions\.find\(\(c\) => c\.decision === 'final_confirmed'\) \?\? null;/);
    assert.match(FORMS, /this is a label, not a\s*\n?\s*\*?\s*decision/);
  });

  test('and it is the same confirmation the door will read — the newest', () => {
    // The reader orders client decisions newest-first and the door takes
    // `order by created_at desc limit 1`. A page showing the oldest would
    // label the button with words the door is not acting on.
    assert.match(read('src/modules/projects/queries.ts'), /\.from\('client_design_decisions'\)[\s\S]{0,400}?\.order\('created_at', \{ ascending: false \}\)/);
    assert.match(LOCK, /and d\.decision = 'final_confirmed'\s*\n\s*order by d\.created_at desc\s*\n\s*limit 1;/);
  });
});

describe('B. locked-not-ready is a success, and says both things', () => {
  test('the service treats it as ok, not as an error', () => {
    // Phase 3 IS complete — the client confirmed. Refusing to record that
    // would be the faked completion rule inverted.
    assert.match(lockService, /case 'locked_not_ready':\s*\n\s*return ok\(\{ handoffId: row\?\.handoff_id \?\? null, phaseFourReady: false \}\);/);
  });

  test('and the message separates the two facts', () => {
    assert.match(ACTIONS, /Locked, and Phase 3 is complete — but the handoff is not Phase 4 ready/);
    assert.match(ACTIONS, /Phase 4 stays blocked until it exists\./);
  });

  test('the form warns before the click, not only after it', () => {
    // Somebody completing a phase should know what they are about to record.
    assert.match(lockForm, /There is no Figma reference on the confirmed option/);
    assert.match(lockForm, /hasFigma/);
  });

  test('and readiness is computed by the door, never by the page', () => {
    assert.match(LOCK, /v_ready := v_theme\.figma_node_id is not null;/);
    // The page passes a flag to word a warning; it does not decide readiness.
    assert.doesNotMatch(PAGE, /phaseFourReady =|phaseFourReady:/);
  });
});

describe('C. every refusal says which precondition failed', () => {
  test('each has its own message, not one "not ready"', () => {
    for (const phrase of [
      'The client has not confirmed a final theme and colour yet',
      'This direction is already locked',
      'There is no finalized screen baseline',
      'never passed the Admin gate',
      'This phase is waiting on a person',
    ]) {
      assert.ok(lockService.includes(phrase), `${phrase} is not said`);
    }
  });

  test('already-locked explains what to do instead', () => {
    // §16: a later change is a new version and a new change process.
    assert.match(lockService, /A later change is a new version, not an edit to this one\./);
  });
});

describe('D. the button appears only when the phase can be completed', () => {
  test('offered only once the client has confirmed', () => {
    assert.match(PAGE, /confirmation && mayDecide \? \(\s*\n\s*<LockDirectionForm/);
  });

  test('and never once something is locked', () => {
    assert.match(PAGE, /\{!trail\.handoff \? \(/);
  });

  test('without a confirmation the page says what is missing', () => {
    assert.match(PAGE, /The direction locks when the client confirms an exact theme and\s*\n?\s*colour\./);
  });

  test('completing the phase refreshes the project page too', () => {
    // The project's own status board reads the phase; leaving it stale would
    // show a project still in design after Phase 3 closed.
    const lockAction = region(ACTIONS, 'export async function lockPhaseThreeDirectionAction');
    assert.match(lockAction, /revalidatePath\(`\/projects\/\$\{projectId\}\/design`\)/);
    assert.match(lockAction, /revalidatePath\(`\/projects\/\$\{projectId\}`\)/);
  });
});
