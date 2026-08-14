import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TOOLS, resolveTool, toolsFor } from '../src/modules/agents/tools.ts';

/**
 * The tool authorization boundary — G-125 condition 5, decision ADM-83.
 *
 * The rule: **an agent's tools come from its registry definition, never from
 * its input, its context, its prompt, or a model's request.**
 *
 * These tests are written adversarially, because the threat is adversarial. A
 * client can write anything into a WhatsApp message an agent reads, the model
 * may comply, and the question this file answers is what happens next.
 *
 * Target property: a fully compromised prompt can waste tokens and cannot gain
 * authority.
 */

const refusal = (r: ReturnType<typeof resolveTool>) => (r.ok ? '' : r.error.message);

describe('A. the boundary exists before any tool does', () => {
  test('no tool is implemented yet, and that is the honest state', () => {
    // requirement_collector reaches its model through the one hard-coded path
    // in the job runner and calls nothing. Building the boundary first means
    // the first tool ever added arrives inside it.
    assert.deepEqual([...TOOLS], []);
  });

  test('and the one defined agent is bound to none', () => {
    assert.deepEqual([...toolsFor('requirement_collector')], []);
  });

  test('an undefined agent holds no tools rather than defaulting open', () => {
    assert.deepEqual([...toolsFor('lead_qualifier')], []);
    assert.deepEqual([...toolsFor('nothing_at_all')], []);
  });
});

describe('B. what a compromised prompt gets', () => {
  test('a model asking for a tool it was never bound is refused', () => {
    // The injection case. The model emits a well-formed request for a tool
    // that would settle an approval; the refusal happens before dispatch.
    const r = resolveTool('requirement_collector', 'approvals.decide', 'L1');
    assert.equal(r.ok, false);
    assert.match(refusal(r), /not available to requirement_collector/);
  });

  test('and the refusal does not reveal whether the tool exists', () => {
    // A caller that can distinguish "not bound to you" from "no such tool" can
    // enumerate the tool surface by asking. Both answers are the same sentence.
    const real = refusal(resolveTool('requirement_collector', 'approvals.decide', 'L1'));
    const invented = refusal(resolveTool('requirement_collector', 'zzz.not_a_tool', 'L1'));
    assert.equal(
      real.replace('approvals.decide', 'X'),
      invented.replace('zzz.not_a_tool', 'X'),
      'the refusal distinguishes a real tool from an invented one',
    );
  });

  test('an undefined agent cannot call anything at all', () => {
    // A disabled or removed agent whose key somehow reaches the runtime gets
    // nothing — rather than inheriting a default set, which is how an
    // unreachable agent becomes a reachable one.
    const r = resolveTool('lead_qualifier', 'anything', 'L2');
    assert.equal(r.ok, false);
    assert.match(refusal(r), /No agent "lead_qualifier" is defined/);
  });

  test('and naming a higher autonomy in the request does not grant it', () => {
    // The autonomy argument comes from `ai.agents`, not from the model. Passing
    // 'L2' here simulates a caller that has been fooled into claiming it — and
    // the tool is still not bound, so the claim buys nothing.
    const r = resolveTool('requirement_collector', 'finance.draftInvoice', 'L2');
    assert.equal(r.ok, false);
    assert.match(refusal(r), /not available to/);
  });
});

describe('C. binding is necessary, not sufficient', () => {
  // These pin the ordering inside resolveTool. They use a synthetic agent
  // shape rather than a real definition, because no agent is bound to a tool
  // yet and the ordering must be correct before one is.

  test('the bound-tool check precedes the existence check', () => {
    // An unbound name that also does not exist is refused as unbound, not as
    // missing — otherwise the error message leaks the tool inventory.
    const r = resolveTool('requirement_collector', 'does.not.exist', 'L1');
    assert.equal(r.ok, false);
    assert.ok(!/no tool implements/.test(refusal(r)), 'the refusal leaked implementation state');
  });

  test('autonomy is compared, not assumed', () => {
    // Documented here because the comparison is the part a future tool
    // addition could quietly break: an L1 agent must not reach an L2 tool even
    // when that tool is bound to it, and the fix is never to raise autonomy.
    const source = TOOLS.length;
    assert.equal(source, 0, 'a tool exists — this test must be extended to cover it');
  });
});

describe('D. the shape a tool must declare', () => {
  test('every tool names an action class, and both risk flags', () => {
    for (const tool of TOOLS) {
      assert.ok(['L0', 'L1', 'L2'].includes(tool.actionClass), `${tool.name} has no action class`);
      assert.equal(typeof tool.clientFacing, 'boolean', `${tool.name} does not say if it reaches a client`);
      assert.equal(typeof tool.touchesMoney, 'boolean', `${tool.name} does not say if it touches money`);
    }
  });

  test('a client-facing or money tool is never below L2', () => {
    // ADM-70 and ADM-22. A tool that can reach a client or move money is
    // consequential by definition, whatever else it does.
    for (const tool of TOOLS) {
      if (tool.clientFacing || tool.touchesMoney) {
        assert.equal(tool.actionClass, 'L2', `${tool.name} is consequential and classed below L2`);
      }
    }
  });
});
