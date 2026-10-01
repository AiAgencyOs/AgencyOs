import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { handoffHeaderValue, requirementHeaderValue } from '../src/modules/crm/requirement-header.ts';

/**
 * SCR-007's header names "Requirement version status" and "Human-handoff
 * state". Both are sentences made from rows the page already reads, so the
 * tests give them real rows and read the sentence back.
 */
describe('the requirement fact in the Lead 360 header', () => {
  test('a thread with no extraction says so, it does not stay silent', () => {
    assert.equal(requirementHeaderValue([]), 'No version yet');
  });

  test('the newest version speaks, whatever order the rows arrive in', () => {
    const text = requirementHeaderValue([
      { version: 1, status: 'superseded', sent_for_confirmation_at: null },
      { version: 3, status: 'proposed', sent_for_confirmation_at: null },
      { version: 2, status: 'accepted', sent_for_confirmation_at: '2026-09-30T10:00:00Z' },
    ]);
    assert.equal(text, 'v3 · Proposed, awaiting a decision');
  });

  test('an accepted version says whether the client has seen it', () => {
    assert.equal(requirementHeaderValue([{ version: 2, status: 'accepted', sent_for_confirmation_at: '2026-09-30T10:00:00Z' }]), 'v2 · Accepted, client-confirmed');
    assert.equal(requirementHeaderValue([{ version: 2, status: 'accepted', sent_for_confirmation_at: null }]), 'v2 · Accepted, not yet shown to the client');
  });

  test('a failed extraction is named, not hidden behind an older version', () => {
    assert.equal(
      requirementHeaderValue([
        { version: 1, status: 'accepted', sent_for_confirmation_at: null },
        { version: 2, status: 'failed', sent_for_confirmation_at: null },
      ]),
      'v2 · Extraction failed',
    );
  });
});

describe('the hand-off fact in the Lead 360 header', () => {
  test('no thread, no fact', () => {
    assert.equal(handoffHeaderValue(null), null);
  });
  test('a paused agent means a person has the thread', () => {
    assert.equal(handoffHeaderValue({ agent_paused_at: '2026-09-30T10:00:00Z' }), 'With a person — agent paused');
    assert.equal(handoffHeaderValue({ agent_paused_at: null }), 'Agent replying');
  });
});
