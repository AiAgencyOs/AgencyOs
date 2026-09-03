import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

import { requirementConfirmationMessage } from '../src/modules/crm/schema.ts';

/**
 * The client confirms the summary — G-200 (Doc 09 §12, audit RD-05).
 *
 * §12's flow has a CLIENT CONFIRMATION step between extracting the
 * requirements and quoting them. In this system that step was an internal
 * button: `decideRequirementVersion` requires a signed-in session, so the
 * version a client's whole quotation is built on was agreed **on their
 * behalf** — and nothing ever sent them the summary to look at.
 *
 * The agency read the thread, wrote down what it heard, approved its own
 * reading, and priced it. Every step honest, and the client never saw the
 * sentence they were about to be quoted against.
 *
 * ── the line this does not cross ──────────────────────────────────────────
 *
 * It sends. **It does not read the reply.** Doc 08 §14 is explicit — *"Do not
 * infer acceptance from a generic 'looks good'"* — and `messageIntentSchema`'s
 * own comment says the same about the `acceptance` label it already produces:
 * *"there is no path from this label to any of them to guard."*
 *
 * Building one here would be building the path. So the client's answer stays
 * in the thread, in their own words, and what changes is that the person
 * accepting can see whether the client was ever shown it.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = sqlCode(read('supabase/migrations/20260904160000_the_client_confirms_the_summary.sql'));
const SERVICE = codeOnly(read('src/modules/crm/service.ts'));

describe('A. the message the client reads', () => {
  const payload = {
    summary: 'An ordering app for a tiffin service, with a driver app and an admin panel.',
    scopeItems: [
      { title: 'Customer app', detail: 'Browse, subscribe, pay' },
      { title: 'Driver app' },
    ],
    constraints: ['Launch before Diwali'],
    openQuestions: ['Which payment gateway?'],
  };

  test('it asks the one question the whole message exists to ask', () => {
    const body = requirementConfirmationMessage(payload);
    assert.match(body, /^Before we put a quotation together, here is what we have understood/);
    assert.match(body, /If anything here is wrong or missing, tell us and we will correct it before quoting\./);
  });

  test('it carries the scope, the constraints and what is still open', () => {
    const body = requirementConfirmationMessage(payload);
    assert.match(body, /• Customer app — Browse, subscribe, pay/);
    assert.match(body, /• Driver app$/m);
    assert.match(body, /Launch before Diwali/);
    assert.match(body, /Which payment gateway\?/);
  });

  test('and a bare summary produces a message with no empty headings', () => {
    const body = requirementConfirmationMessage({ summary: 'A small website.' });
    assert.ok(!body.includes('What we would build:'));
    assert.ok(!body.includes('Still to confirm:'));
    assert.match(body, /A small website\./);
  });

  test('it names no price — this is a scope confirmation', () => {
    // Every number in AgencyOS belongs to a quotation somebody approved.
    const body = requirementConfirmationMessage(payload);
    assert.ok(!/₹|\brupees?\b|\bprice\b/i.test(body));
  });

  test('and it is composed in CODE, never by a model', () => {
    // A model asked to restate an agreed scope will restate it differently,
    // and a client confirming a sentence nobody wrote down is worse than a
    // client who was never asked.
    assert.match(SERVICE, /p_body: requirementConfirmationMessage\(payload\.data\)/);
  });
});

describe('B. the send goes through the chokepoint, not around it', () => {
  test('it calls send_outbound_message with a key derived from the version', () => {
    assert.match(MIGRATION, /crm\.send_outbound_message\(\s*v_row\.conversation_id,\s*p_body,\s*'requirement:' \|\| p_version_id::text/);
  });

  test('and the chokepoint’s refusal is carried out as-is, not translated', () => {
    // The caller has to be able to tell "they have opted out" from "it failed".
    assert.match(MIGRATION, /return query select coalesce\(v_sent\.outcome, 'not_sent'\)::text, v_sent\.message_id;/);
    assert.match(SERVICE, /case 'no_consent':/);
  });

  test('only a version still awaiting a decision may be sent', () => {
    assert.match(MIGRATION, /if v_row\.status <> 'proposed' then\s+return query select 'not_proposed'/);
  });

  test('sending twice sends once — and the KEY is what refuses it', () => {
    /**
     * Which layer owns this was settled by a red-proof rather than by
     * reading: removing the early exit below and pressing send twice still
     * sends once, because `send_outbound_message`'s idempotency key is
     * derived from the version and is the same key on every attempt.
     *
     * So the key is pinned as the control, and the early exit is pinned as
     * what it is. A reader who assumed the branch was the guard could have
     * removed the key and left the branch, and the double-send would be back.
     */
    assert.match(MIGRATION, /'requirement:' \|\| p_version_id::text/);
    assert.match(MIGRATION, /if v_row\.sent_for_confirmation_at is not null then\s+return query select 'already_sent'/);
    const prose = read('supabase/migrations/20260904160000_the_client_confirms_the_summary.sql');
    assert.match(prose, /An early exit, and NOT the control/);
  });

  test('a payload the service cannot read is not composed into a guess', () => {
    assert.match(SERVICE, /This version’s requirements could not be read, so nothing was sent/);
  });
});

describe('C. what was sent is a record of what happened', () => {
  test('a send must name the message it was sent in', () => {
    // A row saying the client was shown something, with nothing to open, is
    // an assertion.
    assert.match(MIGRATION, /a summary sent for confirmation must name the message it was sent in/);
  });

  test('and once sent it does not change', () => {
    assert.match(MIGRATION, /when a client was shown this summary is a record of what happened, and does not change/);
  });

  test('the message it points at must belong to the same tenant', () => {
    assert.match(MIGRATION, /core\.enforce_parent_org\('confirmation_message_id', 'crm\.conversation_messages'\)/);
  });

  test('and the act is audited', () => {
    assert.match(MIGRATION, /'requirement\.sent_for_confirmation', 'requirement_version', p_version_id/);
  });
});

describe('D. and the reply is nobody’s to interpret', () => {
  test('nothing writes a confirmation status from a client message', () => {
    // The whole of the restraint, asserted as an absence with its reason: Doc
    // 08 §14 refuses to let acceptance be inferred, and there is no path from
    // a label to a status here to guard.
    assert.ok(!MIGRATION.includes('client_confirmed_at'), 'no column may hold a model’s reading of acceptance');
    assert.ok(!MIGRATION.includes('confirmed_by_agent'), 'and no agent may sign one');
  });

  test('the migration says so, in the file somebody would change', () => {
    const prose = read('supabase/migrations/20260904160000_the_client_confirms_the_summary.sql');
    assert.match(prose, /It does not read the reply/);
    assert.match(prose, /Do not infer\n-- acceptance from a generic 'looks good'/);
  });

  test('and approval is NOT blocked on the send', () => {
    // A scope agreed on a phone call is agreed, and refusing to record it
    // would push the truth out of the system to protect a checkbox.
    const service = codeOnly(read('src/modules/crm/service.ts'));
    const decide = service.slice(service.indexOf('export async function decideRequirementVersion'));
    assert.ok(
      !decide.slice(0, 2500).includes('sent_for_confirmation_at'),
      'the decision must not consult the send — it is advisory, not a gate',
    );
  });

  test('the screen says plainly when the client has not seen it', () => {
    const form = codeOnly(read('app/(internal)/leads/[leadId]/requirement-decision-form.tsx'));
    assert.match(form, /they are about to be quoted against a scope they never read/);
    assert.match(form, /nothing here reads it for you/);
  });
});
