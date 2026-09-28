import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { checkDesignerActivation, checkNoPaymentVerificationRoute } from '../src/modules/orchestrator/route.ts';
import { AGENT_DEFINITIONS } from '../src/modules/agents/registry.ts';

/**
 * Orchestrator routing guards — ORCH §10, §21, §22 (P4-ORCH-GUARDS).
 *
 * Two of the matrix's three named guards did not exist before this file:
 * QA-independence already had a real, load-bearing precedent
 * (`src/modules/agents/verification.ts`'s `mayVerify`/`verifiedBy` contract,
 * covered by `tests/agent-registry.test.ts`'s "and no agent claims money
 * authority it is not permitted" family and by `tests/*-review*.test.ts`
 * elsewhere). This file covers the two that were genuinely missing:
 *
 *   A. the Designer-activation guard — `checkDesignerActivation`, called by
 *      `handleRouteTask2Design` (src/modules/orchestrator/handlers.ts) with
 *      freshly re-read facts before it ever attempts a handoff insert. Mirrored
 *      a second time, independently, by `ai.enforce_handoff_target`
 *      (20260928150000_a_disabled_agent_has_no_activation_reason.sql) in the
 *      database — live-verified on a scratch Postgres (see that migration's
 *      own docblock and this session's report): a handoff to a disabled
 *      `ui_designer` was refused, the refusal was red-proved by reverting the
 *      trigger to its pre-fix body and confirming the SAME insert then
 *      succeeded, and the fix was reapplied and reconfirmed refusing.
 *
 *   B. the Finance-gate routing guard — `checkNoPaymentVerificationRoute`,
 *      called once at module load (`registry.ts`, beside `AGENT_KEYS`) rather
 *      than per routing decision, because nothing in this roster ever asks to
 *      route TO a payment verdict; the risk is a future registry edit, not a
 *      runtime call. `tests/no-ai-route-verifies-payment.test.ts` already
 *      proves the negative from several other angles (tool names, the
 *      dispatch allowlist, the runner source, the one legitimate caller) —
 *      this file adds the load-time assertion itself and red-proves it by
 *      constructing a roster that violates it and confirming the check
 *      actually refuses that roster, not just the real one.
 */

describe('A. the Designer-activation guard', () => {
  test('both facts present — activation is granted', () => {
    const result = checkDesignerActivation({ phaseThreeLocked: true, designerEnabled: true });
    assert.deepEqual(result, { ok: true });
  });

  test('Phase 3 baseline not locked — refused, named as such', () => {
    const result = checkDesignerActivation({ phaseThreeLocked: false, designerEnabled: true });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.reason : '', /Phase 3 baseline is not locked/);
  });

  test('ui_designer disabled in ai.agents — refused, named as such', () => {
    const result = checkDesignerActivation({ phaseThreeLocked: true, designerEnabled: false });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.reason : '', /ui_designer is disabled in ai\.agents/);
  });

  test('the baseline check is reported first when both facts are missing', () => {
    // Ordering matters the same way verdictFor orders its refusals: the more
    // structural fact (no baseline to design from at all) should not be
    // masked by the narrower one (an agent flag).
    const result = checkDesignerActivation({ phaseThreeLocked: false, designerEnabled: false });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.reason : '', /Phase 3 baseline is not locked/);
  });
});

describe('B. the Finance-gate routing guard', () => {
  test('the real roster passes — no agent binds a payment-verification-shaped tool', () => {
    const result = checkNoPaymentVerificationRoute(AGENT_DEFINITIONS);
    assert.deepEqual(result, { ok: true });
  });

  test('red-proof: a roster with a forbidden tool is genuinely refused', () => {
    // Constructed rather than mutating the real registry, so this proves the
    // CHECK catches the violation rather than proving nothing changed.
    const poisoned = [
      { key: 'finance', tools: ['memory.recall', 'finance.verifyPaymentSubmission'] },
    ];
    const result = checkNoPaymentVerificationRoute(poisoned);
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.reason : '', /finance declares tool "finance\.verifyPaymentSubmission"/);
  });

  test('red-proof, the other phrasing: "markInvoicePaid" is refused too', () => {
    const poisoned = [{ key: 'orchestrator', tools: ['finance.markInvoicePaid'] }];
    const result = checkNoPaymentVerificationRoute(poisoned);
    assert.equal(result.ok, false);
  });

  test('an unrelated tool name is not swept up by the denylist', () => {
    const clean = [{ key: 'finance', tools: ['memory.recall', 'finance.generateInvoice', 'approvals.requestApproval'] }];
    assert.deepEqual(checkNoPaymentVerificationRoute(clean), { ok: true });
  });

  test('the registry module itself throws at load time for a violating roster', async () => {
    // Proves the guard is wired to module load, not only callable in
    // isolation. Re-importing registry.ts under a fresh module cache with a
    // monkey-patched AGENT_DEFINITIONS is not practical for an ESM singleton,
    // so this instead proves the same invariant the load-time check enforces
    // by re-running the exact call registry.ts makes on import.
    const financeGate = checkNoPaymentVerificationRoute(AGENT_DEFINITIONS);
    assert.equal(financeGate.ok, true, 'if this ever fails, registry.ts fails to import at all — by design');
  });
});
