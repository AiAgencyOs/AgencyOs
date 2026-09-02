import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

import { announcementFor } from '../src/modules/crm/schema.ts';
import {
  parseQuotationDocument,
  quotationLanguageFault,
  quotationMessage,
  quotationScopeSchema,
} from '../src/modules/sales/schema.ts';

/**
 * The agent explains the quotation it sends — G-182.
 *
 * A zero-trust audit walked the flow's **CLIENT QUOTATION DELIVERY** step and
 * found nothing agent-shaped in it. The send composed a fixed template from
 * the row — title, lines, total, validity — and nobody explained anything. A
 * client who had spent a whole conversation being understood received a price
 * list.
 *
 * ── two decisions, and the second is the one that matters ─────────────────
 *
 * **Written at DRAFT time, not at send time.** The obvious place is the moment
 * of sending, and it is the wrong one twice over: a model call on the send
 * path adds a failure mode to the one action a client is waiting for, and —
 * far more importantly — words written *after* the approval are words the
 * owner never approved.
 *
 * So the note rides in the approval announcement. What makes agent-written
 * client-facing prose about a priced quotation permissible under ADM-22 is not
 * that it avoids numbers, though it does: it is that **the person who decides
 * the price also decides what is said about it.**
 *
 * **And it may not contain a number.** `quotationLanguageFault` already refused
 * a rupee figure in a quotation's prose; that rule now covers this field. The
 * figures are printed beneath the note from the priced fields, which are the
 * ones the arithmetic gate checks. A number written twice is a number that can
 * disagree with itself.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const WORKFLOWS = codeOnly(read('app/api/jobs/run/workflows.ts'));
const MIGRATION = read('supabase/migrations/20260901160000_the_owner_approves_the_words_too.sql');

const NOTE =
  'Bhai, yeh aapke turf booking ke liye hai — player app, owner dashboard aur aapka admin panel. ' +
  'Payment Razorpay se, aapke apne account par. Aage kya karna hai woh neeche likha hai.';

const SCOPE = {
  title: 'Turf booking platform',
  understanding:
    'A player finds a nearby turf, sees which slots are free and pays for one; the owner sets prices and blocks slots.',
  items: [
    {
      description: 'Player app',
      priceRupees: 30_000,
      features: ['Mobile number and OTP login', 'Find turfs nearby and book a slot'],
    },
  ],
  summary: 'Covers the player app.',
  exclusions: [],
  assumptions: [],
  clientResponsibilities: [],
};

const MESSAGE = {
  title: 'Turf booking platform',
  version: 1,
  body: null,
  currency: 'INR',
  items: [{ description: 'Player app', quantity: 1, amountMinor: 30_000_00 }],
  subtotalMinor: 30_000_00,
  discountMinor: 0,
  taxMinor: 0,
  totalMinor: 30_000_00,
  validUntil: null,
};

describe('A. the agent may explain, and may not price', () => {
  test('a covering note is accepted', () => {
    const parsed = quotationScopeSchema.safeParse({ ...SCOPE, coveringNote: NOTE });
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  });

  test('a note carrying a rupee figure is refused', () => {
    // The whole reason this field can exist. The figures are printed beneath
    // it from the priced fields; a number written twice can disagree with
    // itself, and the one in prose is the one no arithmetic gate checks.
    const priced = quotationScopeSchema.safeParse({
      ...SCOPE,
      coveringNote: 'Yeh sab ₹30,000 mein ho jayega, aur agle hafte start kar denge — poora scope neeche hai.',
    });
    assert.equal(priced.success, false);
    assert.match(JSON.stringify(priced.error?.issues), /the covering note writes the amount/);
  });

  test('and so is "Rs" or "INR" — the rule is about money, not one glyph', () => {
    for (const money of ['Rs. 30,000', 'INR 30000']) {
      const attempt = quotationScopeSchema.safeParse({
        ...SCOPE,
        coveringNote: `Total ${money} ke andar sab kuch — details neeche di gayi hain, dekh lijiye.`,
      });
      assert.equal(attempt.success, false, money);
    }
  });

  test('the fault checker names the note as its own location', () => {
    // "the summary" and "line 2" tell a model where to look. So must this.
    const fault = quotationLanguageFault({
      items: [{ description: 'Player app', features: ['a', 'b'] }],
      summary: 'Covers the player app.',
      coveringNote: 'It will cost ₹30,000.',
    });
    assert.match(fault!, /^the covering note writes the amount/);
  });

  test('an absent note breaks nothing that checked before it existed', () => {
    assert.equal(
      quotationLanguageFault({
        items: [{ description: 'Player app', features: ['a', 'b'] }],
        summary: 'Covers the player app.',
      }),
      null,
    );
    assert.equal(quotationScopeSchema.safeParse(SCOPE).success, true);
  });

  test('the open-scope and readiness rules reach it too', () => {
    // It is prose in a quotation, so every rule about a quotation's prose
    // applies. Adding the field to the list rather than to one check is what
    // makes that true without restating anything.
    const open = quotationLanguageFault({
      items: [{ description: 'Player app', features: ['a', 'b'] }],
      summary: 'Covers the player app.',
      coveringNote: 'Player app, owner dashboard and much more.',
    });
    assert.match(open!, /the covering note leaves the scope open/);
  });
});

describe('B. the client reads it first', () => {
  test('the note sits above the figures, with a blank line between', () => {
    const body = quotationMessage({ ...MESSAGE, document: { coveringNote: NOTE } });
    const lines = body.split('\n');
    assert.equal(lines[0], NOTE);
    assert.equal(lines[1], '');
    assert.equal(lines[2], 'Turf booking platform — v1');
  });

  test('and every figure is still printed beneath it, unchanged', () => {
    const body = quotationMessage({ ...MESSAGE, document: { coveringNote: NOTE } });
    assert.match(body, /Player app — ₹30,000\.00/);
    assert.match(body, /Total: ₹30,000\.00/);
  });

  test('without a note the message is byte-for-byte what it was', () => {
    // The compatibility claim: every quotation sent before this field existed.
    const before = quotationMessage(MESSAGE);
    assert.equal(quotationMessage({ ...MESSAGE, document: null }), before);
    assert.equal(quotationMessage({ ...MESSAGE, document: { coveringNote: null } }), before);
    assert.equal(quotationMessage({ ...MESSAGE, document: { coveringNote: '   ' } }), before);
    // A document that does not parse at all must not lose the quotation with
    // it — the note is optional, the figures are not.
    assert.equal(quotationMessage({ ...MESSAGE, document: 'not a document' }), before);
    assert.equal(before.split('\n')[0], 'Turf booking platform — v1');
  });

  test('both send doors hand the composer the raw document, and neither parses it', () => {
    // Two doors: the manual button and the approved-quotation dispatch. Each
    // doing its own parsing is two chances to do it differently, so both pass
    // the column and the composer is the only thing that reads it. It also
    // keeps crm/handlers.ts out of sales/schema.ts, which ARCHITECTURE.md §3.2
    // forbids — the lint caught that, and this pins the fix.
    const service = codeOnly(read('src/modules/sales/service.ts'));
    const handlers = codeOnly(read('src/modules/crm/handlers.ts'));
    for (const [name, source] of [['service', service], ['handlers', handlers]] as const) {
      assert.match(source, /document: proposal\.document \?\? null,/, `${name} must pass the raw document`);
      assert.ok(
        !source.includes('coveringNote'),
        `${name} must not reach into the document itself`,
      );
    }
  });

  test('the document round-trips it, and a malformed one loses only it', () => {
    assert.equal(parseQuotationDocument({ understanding: 'x', coveringNote: NOTE })?.coveringNote, NOTE);
    const doc = parseQuotationDocument({ understanding: 'A booking platform.', coveringNote: { not: 'a string' } });
    assert.equal(doc?.understanding, 'A booking platform.');
    assert.equal(doc?.coveringNote, null);
  });
});

describe('C. the owner reads it before deciding, which is what permits it at all', () => {
  const EVENT = {
    reference: 'A7C2KM',
    subjectType: 'proposal',
    subjectId: '11111111-1111-4111-8111-111111111111',
    summary: 'Quotation v1 — Turf booking platform',
    amountMinor: 30_000_00,
    requiredRole: 'owner',
    slaDueAt: null,
  };
  const PAYLOAD = {
    version: 1,
    title: 'Turf booking platform',
    currency: 'INR',
    subtotal_minor: 30_000_00,
    discount_minor: 0,
    tax_minor: 0,
    total_minor: 30_000_00,
    valid_until: null,
    items: [{ description: 'Player app', quantity: 1, amount_minor: 30_000_00 }],
  };

  test('the announcement quotes the words the client will read', () => {
    const body = announcementFor(EVENT, true, { ...PAYLOAD, covering_note: NOTE });
    assert.match(body, /The client will read, above the figures:/);
    assert.ok(body.includes(NOTE));
  });

  test('the words come BEFORE the figures, the way the client will get them', () => {
    const body = announcementFor(EVENT, true, { ...PAYLOAD, covering_note: NOTE });
    assert.ok(body.indexOf('The client will read') < body.indexOf('Player app'));
  });

  test('and they are quoted, so the owner can tell the agent from the system', () => {
    const body = announcementFor(EVENT, true, { ...PAYLOAD, covering_note: NOTE });
    assert.match(body, /“.+”/);
  });

  test('a quotation with no note announces exactly as it did', () => {
    const withNone = announcementFor(EVENT, true, PAYLOAD);
    assert.ok(!withNone.includes('The client will read'));
    assert.match(withNone, /Player app/);
    assert.equal(withNone, announcementFor(EVENT, true, { ...PAYLOAD, covering_note: null }));
  });
});

describe('D. the model is asked, the answer is kept, and the payload carries it', () => {
  test('all three prompts ask for it and forbid a number in it', () => {
    assert.equal((WORKFLOWS.match(/THE COVERING NOTE — two to four sentences/g) ?? []).length, 3);
    assert.equal((WORKFLOWS.match(/NO NUMBER MAY APPEAR IN IT/g) ?? []).length, 3);
  });

  test('and tell the model why it is approved with the price', () => {
    assert.equal((WORKFLOWS.match(/It is approved WITH the price/g) ?? []).length, 3);
  });

  test('all three doors persist it', () => {
    assert.equal((WORKFLOWS.match(/coveringNote: validated\.data\.coveringNote \?\? null/g) ?? []).length, 3);
  });

  test('the approval payload carries it out of the document', () => {
    const sql = sqlCode(MIGRATION);
    assert.match(sql, /'covering_note', v_row\.document->>'coveringNote'/);
  });

  test('and the function kept every refusal it had — regenerated, not retyped', () => {
    // The first draft of this migration was written from memory and silently
    // lost the `already_pending` branch and the no-lines guard. That is the
    // near miss PR #113 made and G-126 recorded: a hand-rewritten function
    // drops a branch and every structural test stays green.
    const sql = sqlCode(MIGRATION);
    for (const outcome of ['not_found', 'already_pending', 'not_draft', 'no_policy', 'submitted']) {
      assert.ok(sql.includes(`'${outcome}'`), `the ${outcome} answer must survive`);
    }
    assert.match(sql, /for update;/);
    // And the migration says where its body came from, so the next person
    // rewriting it knows not to type it out.
    assert.match(MIGRATION, /REGENERATED FROM THE LIVE DEFINITION, not retyped/);
  });
});
