import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DESIGNER_ACTIVATION_REASONS,
  DESIGNER_REFUSED_TRIGGERS,
  decideDesignerActivation,
  reasonForPriorStatus,
} from '../src/modules/orchestrator/designer-activation.ts';

/** Phase 4 UI Designer spec: Designer activates for A–G, and must NOT activate for the nine listed triggers. */
describe('Designer conditional activation', () => {
  test('each of the seven valid conditions activates, and says which', () => {
    assert.equal(DESIGNER_ACTIVATION_REASONS.length, 7);
    for (const reason of DESIGNER_ACTIVATION_REASONS) assert.deepEqual(decideDesignerActivation(reason), { activate: true, reason });
  });

  test('each listed non-condition is refused and routed to its real owner', () => {
    assert.equal(DESIGNER_REFUSED_TRIGGERS.length, 9);
    for (const trigger of DESIGNER_REFUSED_TRIGGERS) {
      const d = decideDesignerActivation(trigger);
      assert.equal(d.activate, false, trigger);
      if (!d.activate) assert.ok(d.routeTo.length > 0);
    }
  });

  test('an ambiguous rule is clarified through the PM, never guessed', () => {
    const d = decideDesignerActivation('ambiguous_business_rule');
    assert.ok(!d.activate && /PM clarification/.test(d.routeTo));
  });

  test('an unknown trigger cannot be invented into a seventh reason', () => {
    assert.equal(decideDesignerActivation('the model felt like it').activate, false);
  });

  test('the state a prior version was left in names the revision reason', () => {
    assert.equal(reasonForPriorStatus('qa_changes_required'), 'design_qa_defect');
    assert.equal(reasonForPriorStatus('admin_edit'), 'admin_edit');
    assert.equal(reasonForPriorStatus('client_change'), 'client_visual_revision');
    assert.equal(reasonForPriorStatus('qa_pass'), null);
  });

  test('the routing handler records the reason on the handoff it writes', () => {
    const handler = readFileSync(fileURLToPath(new URL('../src/modules/orchestrator/handlers.ts', import.meta.url)), 'utf8');
    assert.match(handler, /decideDesignerActivation\('initial_phase_four'\)/);
    assert.match(handler, /activationReason: activation\.reason/);
  });
});
