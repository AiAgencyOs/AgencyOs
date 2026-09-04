import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

import { renderQuotationPdf } from '../src/lib/pdf/quotation.ts';
import { quotationSectionsFor } from '../src/modules/sales/quotation-standards.ts';
import { quotationScopeSchema, parseQuotationDocument } from '../src/modules/sales/schema.ts';

/**
 * The quotation says what it is made of — G-178.
 *
 * A zero-trust audit's largest functional finding: the brief asks a quotation
 * to identify **modules, user roles, backend, frontend, admin, integrations
 * and third-party dependencies**, and `quotationScopeSchema` had a flat list
 * of priced lines with no way to express any of it.
 *
 * A role could appear only as prose inside a description, which made the
 * commonest scope dispute in the corpus unrepresentable: *we thought the admin
 * could do that too.* And there was no third-party section at all — a payment
 * gateway's percentage, a Play Store fee and an SMS rate could be mentioned in
 * an exclusion or nowhere, and "nowhere" is what a fixed-price quotation that
 * turns out to exclude the gateway's cut looks like at go-live.
 *
 * ── the three decisions worth defending ───────────────────────────────────
 *
 * **No parallel "modules" taxonomy.** `items` already describe the work. A
 * second list beside them would be two descriptions of one thing, and the two
 * would drift. What was missing is the AUDIENCE, so each line names the roles
 * it serves and the matrix falls out of the structure that already exists.
 *
 * **`serves` is a column, not another jsonb key.** It is a property of a LINE,
 * and lines live in `sales.proposal_items` with `features` beside them for
 * exactly this reason. Putting it in the document would have required a second
 * copy of every description to hang it off.
 *
 * **No price field for a third-party service.** A gateway's percentage and a
 * store's annual fee move, and neither is the agency's to promise. `charge` is
 * free text so the model can write what the requirements actually established
 * and nothing when they established nothing. `whoPays` is the enum, because
 * whose bill it is is the part that causes the argument.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const WORKFLOWS = codeOnly(read('app/api/jobs/run/workflows.ts'));
const MIGRATION = read('supabase/migrations/20260901130000_the_quotation_says_who_each_line_is_for.sql');

const BASE = {
  title: 'Turf booking platform',
  understanding:
    'A player finds a nearby turf, sees which slots are free and pays for one; the owner sets prices and blocks slots.',
  items: [
    {
      description: 'Player app',
      priceRupees: 30_000,
      kind: 'surface' as const,
      features: ['Mobile number and OTP login', 'Find turfs nearby and book a slot'],
    },
  ],
  summary: 'Covers the player app.',
  exclusions: [],
  assumptions: [],
  clientResponsibilities: [],
};

const ROLES = [
  { name: 'Player', whatTheyDo: 'Finds a turf, books a slot and pays for it.' },
  { name: 'Turf owner', whatTheyDo: 'Sets prices, blocks slots and sees their earnings.' },
];

const DOC = {
  organizationName: 'BussEnhancer',
  preparedFor: 'A Sample Client',
  title: 'Turf booking platform',
  version: 1,
  status: 'approved',
  body: null,
  currency: 'INR',
  items: [{ description: 'Player app', quantity: 1, amountMinor: 30_000_00, serves: ['Player'] }],
  subtotalMinor: 30_000_00,
  discountMinor: 0,
  taxMinor: 0,
  totalMinor: 30_000_00,
  validUntil: null,
  preparedAt: '2026-09-01T10:00:00.000Z',
  timeZone: 'Asia/Kolkata',
  reference: 'test-ref',
};

describe('A. who uses it', () => {
  test('the schema takes named roles with what each can actually do', () => {
    const parsed = quotationScopeSchema.safeParse({ ...BASE, roles: ROLES });
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  });

  test('a line may name the roles it serves', () => {
    const parsed = quotationScopeSchema.safeParse({
      ...BASE,
      roles: ROLES,
      items: [{ ...BASE.items[0]!, serves: ['Player'] }],
    });
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  });

  test('but only a role the quotation DECLARED — an invented user is invented scope', () => {
    // The client reads it, agrees to it, and asks for it at handover.
    const invented = quotationScopeSchema.safeParse({
      ...BASE,
      roles: ROLES,
      items: [{ ...BASE.items[0]!, serves: ['Franchise owner'] }],
    });
    assert.equal(invented.success, false);
    assert.match(JSON.stringify(invented.error?.issues), /not one of this quotation's roles/);
    // And it says which ones there were, so the fix is obvious.
    assert.match(JSON.stringify(invented.error?.issues), /player/);
  });

  test('and naming an audience with no roles at all says so differently', () => {
    // A different mistake and a different sentence: one is a typo, the other
    // is a quotation that forgot to describe its users.
    const none = quotationScopeSchema.safeParse({
      ...BASE,
      items: [{ ...BASE.items[0]!, serves: ['Player'] }],
    });
    assert.equal(none.success, false);
    assert.match(JSON.stringify(none.error?.issues), /declares no roles at all/);
  });

  test('capitalisation is not a scope decision', () => {
    // "admin" and "Admin" are one person. Refusing over it would be a rule
    // about typing rather than about scope.
    const cased = quotationScopeSchema.safeParse({
      ...BASE,
      roles: ROLES,
      items: [{ ...BASE.items[0]!, serves: ['player'] }],
    });
    assert.equal(cased.success, true, JSON.stringify(cased.error?.issues));
  });

  test('a build with one kind of user declares nothing, and that is valid', () => {
    assert.equal(quotationScopeSchema.safeParse(BASE).success, true);
  });

  test('the assembler turns roles into a line a person reads', () => {
    const sections = quotationSectionsFor(30_000_00, 0, { understanding: 'x', roles: ROLES }, []);
    assert.deepEqual(sections?.roleLines, [
      'Player — Finds a turf, books a slot and pays for it.',
      'Turf owner — Sets prices, blocks slots and sees their earnings.',
    ]);
  });

  test('and a quotation with no roles gets no section at all', () => {
    const sections = quotationSectionsFor(30_000_00, 0, { understanding: 'x' }, []);
    assert.equal(sections?.roleLines, null);
    assert.equal(sections?.integrationLines, null);
  });
});

describe('B. what it stands on, and whose bill it is', () => {
  const INTEGRATIONS = [
    {
      name: 'Razorpay',
      purpose: 'Taking card and UPI payments for a slot.',
      whoPays: 'client' as const,
      charge: '2% per transaction on the client’s own account.',
    },
    { name: 'Firebase push', purpose: 'Booking confirmations on the phone.', whoPays: 'included' as const },
  ];

  test('each names what it is for and who pays', () => {
    const parsed = quotationScopeSchema.safeParse({ ...BASE, integrations: INTEGRATIONS });
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  });

  test('there is no field to invent a price into', () => {
    // The decision this rests on: a gateway's percentage and a store's annual
    // fee move, and neither is the agency's to promise. A figure printed in a
    // fixed-price quotation becomes a commitment nobody made.
    const priced = quotationScopeSchema.safeParse({
      ...BASE,
      integrations: [{ ...INTEGRATIONS[0]!, monthlyRupees: 2000 }],
    });
    assert.equal(priced.success, false, 'a structured price must not survive the parse');
  });

  test('who pays is not free text — it is the part that causes the argument', () => {
    const vague = quotationScopeSchema.safeParse({
      ...BASE,
      integrations: [{ name: 'Razorpay', purpose: 'Taking payments for a slot.', whoPays: 'depends' }],
    });
    assert.equal(vague.success, false);
  });

  test('the lines say whose bill it is before they say anything else about money', () => {
    const sections = quotationSectionsFor(30_000_00, 0, { understanding: 'x', integrations: INTEGRATIONS }, []);
    const lines = sections?.integrationLines ?? [];
    assert.match(lines[0]!, /^Razorpay — Taking card and UPI payments for a slot\. Billed to you directly/);
    assert.match(lines[0]!, /2% per transaction/);
    assert.match(lines[1]!, /Firebase push — .*Included in this price\.$/);
  });

  test('and the standing clause appears once when any of them is the client’s', () => {
    const sections = quotationSectionsFor(30_000_00, 0, { understanding: 'x', integrations: INTEGRATIONS }, []);
    const clause = (sections?.integrationLines ?? []).filter((l) => l.includes('opened in your name'));
    assert.equal(clause.length, 1, 'said once, plainly');
  });

  test('but not when everything is included — there is nothing to warn about', () => {
    const sections = quotationSectionsFor(
      30_000_00,
      0,
      { understanding: 'x', integrations: [INTEGRATIONS[1]!] },
      [],
    );
    assert.equal((sections?.integrationLines ?? []).length, 1);
    assert.ok(!(sections?.integrationLines ?? []).some((l) => l.includes('opened in your name')));
  });

  test('a malformed stored entry does not take the document with it', () => {
    // `.catch(null)`, for the reason timelineWeeks has it: one bad entry must
    // not lose the understanding, the exclusions and the assumptions too.
    const doc = parseQuotationDocument({
      understanding: 'The client wants a booking platform.',
      integrations: 'not an array at all',
    });
    assert.equal(doc?.understanding, 'The client wants a booking platform.');
    assert.equal(doc?.integrations, null);
  });
});

describe('C. what the page shows', () => {
  test('both sections render, in the order a client asks the questions', async () => {
    const sections = quotationSectionsFor(
      30_000_00,
      0,
      {
        understanding: 'x',
        roles: ROLES,
        exclusions: ['An iOS build'],
        integrations: [
          { name: 'Razorpay', purpose: 'Taking payments for a slot.', whoPays: 'client', charge: '2% per transaction.' },
        ],
      },
      [],
    );
    const rendered = await renderQuotationPdf({ ...DOC, ...sections });
    const text = rendered.drawnText.join('\n');

    assert.ok(text.includes('WHO USES IT'));
    assert.ok(text.includes('SERVICES IT USES, AND WHO PAYS FOR THEM'));
    // Who is this for, then what else do I sign up for, THEN what is missing.
    // Exclusions reading first would make the limits the document's opening
    // statement about itself.
    assert.ok(text.indexOf('WHO USES IT') < text.indexOf('SERVICES IT USES'));
    assert.ok(text.indexOf('SERVICES IT USES') < text.indexOf('EXPLICITLY NOT INCLUDED'));
    assert.equal(rendered.replacedCharacters.length, 0);
  });

  test('a line says who it is for, under its own features', async () => {
    const sections = quotationSectionsFor(30_000_00, 0, { understanding: 'x', roles: ROLES }, []);
    const rendered = await renderQuotationPdf({ ...DOC, ...sections });
    assert.match(rendered.drawnText.join('\n'), /For: Player/);
  });

  test('and a quotation without roles draws neither section nor label', async () => {
    // The compatibility claim: every quotation in the database predates this.
    const sections = quotationSectionsFor(30_000_00, 0, { understanding: 'x' }, []);
    const rendered = await renderQuotationPdf({
      ...DOC,
      items: [{ description: 'Player app', quantity: 1, amountMinor: 30_000_00 }],
      ...sections,
    });
    const text = rendered.drawnText.join('\n');
    assert.ok(!text.includes('WHO USES IT'));
    assert.ok(!text.includes('SERVICES IT USES'));
    assert.ok(!text.includes('For: '));
  });
});

describe('D. the model is told, and the answer is kept', () => {
  test('all three prompts name the roles and the services', () => {
    assert.equal((WORKFLOWS.match(/ROLES — the kinds of person who use this/g) ?? []).length, 3);
    assert.equal((WORKFLOWS.match(/SERVICES IT USES, AND WHO PAYS/g) ?? []).length, 3);
  });

  test('and every one of them forbids writing a charge at all — G-207', () => {
    /**
     * A DELIBERATE EDIT. This pinned *"you may NOT invent a figure"*, which
     * G-178 wrote and which the audit's QM-20 then showed was not enough: the
     * same prompt also invited the model to *"write what the requirements
     * actually established about the charge"*, and what reached the document
     * was whatever a language model believes a gateway charges — printed
     * verbatim into a fixed-price quotation.
     *
     * The rule is now absolute in the prompt, and — the part that matters —
     * it is no longer only a prompt. See the resolver assertion below.
     */
    assert.equal((WORKFLOWS.match(/You may NEVER write a charge yourself, in any field, in any form/g) ?? []).length, 3);
    assert.equal((WORKFLOWS.match(/you cite it with `chargeRef`/g) ?? []).length, 3);
  });

  test('and warns that an undeclared role is an invented user', () => {
    assert.equal((WORKFLOWS.match(/a role you did not declare is a user you invented/g) ?? []).length, 3);
  });

  test('all three doors persist the roles and the services', () => {
    assert.equal((WORKFLOWS.match(/roles: validated\.data\.roles \?\? null/g) ?? []).length, 3);
  });

  test('and no door writes the model’s own charge — G-207', () => {
    // The stronger claim that replaced the old pin on
    // `integrations: validated.data.integrations ?? null`. Every door now goes
    // through the resolver, which reads the words out of the Admin's list and
    // DELETES anything the model wrote for itself. A prompt rule the model can
    // decline is not a control; this is where the refusal actually lives.
    assert.equal(
      (WORKFLOWS.match(/integrations: resolveIntegrationCharges\(validated\.data\.integrations \?\? null, \w+\)/g) ?? []).length,
      3,
    );
    assert.match(WORKFLOWS, /delete item\.charge;/);
  });

  test('and every item write carries the roles that line serves', () => {
    assert.equal((WORKFLOWS.match(/p_serves: item\.serves \?\? null/g) ?? []).length, 3);
  });

  test('the revisers are SHOWN it, or a revision silently drops the audience', () => {
    assert.equal(
      (WORKFLOWS.match(/serves: Array\.isArray\(i\.serves\) \? i\.serves : undefined/g) ?? []).length,
      2,
    );
  });

  test('every reader of the lines selects it, or the page draws nothing', () => {
    // Four surfaces render a quotation: the download, the send, the approval
    // announcement and the dispatch. A select that forgets the column is a
    // section that silently disappears on one of them.
    const readers = [
      read('src/modules/sales/service.ts'),
      read('src/modules/crm/handlers.ts'),
    ].join('\n');
    assert.equal(
      (readers.match(/'description, quantity, amount_minor, features, serves'/g) ?? []).length,
      4,
    );
  });
});

describe('E. the column, and what it deliberately does not do', () => {
  const sql = sqlCode(MIGRATION);

  test('it is added beside features, and nullable', () => {
    assert.match(sql, /alter table sales\.proposal_items\s*\n\s*add column if not exists serves jsonb;/);
  });

  test('the writer is DROPPED and recreated, never overloaded', () => {
    // `create or replace` with a different argument list creates a second
    // function, and a six-argument call is then ambiguous — a runtime error at
    // the first draft rather than a failure at apply time.
    assert.match(sql, /drop function if exists sales\.add_proposal_item\(uuid, text, numeric, bigint, integer, jsonb\);/);
    const dropped = sql.indexOf('drop function if exists sales.add_proposal_item');
    const created = sql.indexOf('create function sales.add_proposal_item');
    assert.ok(dropped > 0 && created > dropped);
  });

  test('the new parameter defaults to null, so every existing caller is unchanged', () => {
    assert.match(sql, /p_serves jsonb default null/);
  });

  test('and the function keeps every refusal it had', () => {
    // The lock, and the two answers that turn a trigger exception into
    // something a page can render. A rewrite that dropped either would be a
    // regression disguised as an addition.
    assert.match(sql, /for update;/);
    assert.match(sql, /'not_found'::text/);
    assert.match(sql, /'not_draft'::text/);
    // And the re-read that returns the totals the insert trigger rewrote.
    assert.match(sql, /select p\.\* into v_row from sales\.proposals p where p\.id = p_proposal_id;/);
  });
});
