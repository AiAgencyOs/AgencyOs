import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

import { planJobsForEvent } from '../src/lib/events/catalog.ts';
import { quotationMessage } from '../src/modules/sales/schema.ts';

/**
 * An offer the owner made in advance — G-184, decision ADM-98.
 *
 * ── what this change does, and what it costs ──────────────────────────────
 *
 * ADM-22 said it plainly, and had said it since 2026-08-13: *"There is no
 * price catalog. Every price is quoted per client by a human."* Every number
 * reaching a client had a person's decision immediately behind it.
 *
 * Asked on the zero-trust audit what the agent should be allowed to do when a
 * client pushes back on price, the owner answered **both** — draft a revision
 * for approval (G-183), *and* let the agent apply concessions the owner has
 * already authorised. The second half is a real reduction in control, and it
 * is recorded as an override rather than as a clarification: from here, one
 * number can reach a client without a fresh decision.
 *
 * ── so the authority is bounded in five ways, and each is tested here ─────
 *
 *  1. **One offer per organization**, authored by the owner, retired rather
 *     than deleted when it changes.
 *  2. **A cap in DDL** — 1 to 50 per cent — not in a form. A form is one door.
 *  3. **One concession per opportunity, EVER.** A client who pushes twice does
 *     not get it twice; that would be a negotiation the agent is having alone.
 *  4. **The owner's own floor wins** (G-179). Their cap says what they will
 *     give away; the floor says what they cannot afford to.
 *  5. **The client is told the condition** and **the owner is told after.**
 *
 * The live verifier (`db:verify:quotedispatch` §10) drives all five against a
 * real database; this file pins the structure they rest on.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION_RAW = read('supabase/migrations/20260901170000_an_offer_the_owner_made_in_advance.sql');
const MIGRATION = sqlCode(MIGRATION_RAW);
const WORKFLOWS = codeOnly(read('app/api/jobs/run/workflows.ts'));
const HANDLERS = codeOnly(read('src/modules/crm/handlers.ts'));

describe('A. one concession, authored by the owner, bounded by the column', () => {
  test('the cap lives in DDL, where a second door cannot get round it', () => {
    assert.match(MIGRATION, /discount_pct\s+integer not null check \(discount_pct between 1 and 50\)/);
  });

  test('the label and the condition are the owner’s words, and both are required', () => {
    assert.match(MIGRATION, /label\s+text not null check/);
    assert.match(MIGRATION, /condition\s+text not null check/);
  });

  test('only one may be live at a time', () => {
    // A second live offer would make the agent choose between concessions,
    // which is the decision this whole change is careful not to hand it.
    assert.match(MIGRATION, /create unique index[\s\S]{0,120}approved_offers_live_key[\s\S]{0,120}where active;/);
    assert.match(MIGRATION, /set active = false\n\s+where organization_id = p_organization_id and active;/);
  });

  test('and the retired one is kept — what this agency once offered is a record', () => {
    assert.ok(!/delete from sales\.approved_offers/.test(MIGRATION));
  });

  test('authoring is owner-only in the database, not only in the form', () => {
    assert.match(MIGRATION, /if v_actor is not null and not \(select core\.is_owner\(\)\) then\n\s+return query select 'forbidden'/);
  });

  test('the input is judged before the caller, so a bad date reports itself', () => {
    // The first draft answered `no_author` to an expired date — a true
    // statement about a different problem.
    const expiryAt = MIGRATION.indexOf("'already_expired'");
    const authorAt = MIGRATION.indexOf("'no_author'");
    assert.ok(expiryAt > 0 && authorAt > expiryAt, 'the expiry check must come first');
  });

  test('an offer with no author is refused rather than written unowned', () => {
    // The whole point of the row is whose decision it carries.
    assert.match(MIGRATION, /where m\.organization_id = p_organization_id and m\.role = 'owner'/);
    assert.match(MIGRATION, /if v_actor is null then\n\s+return query select 'no_author'/);
  });
});

describe('B. applying it, and the four things that stop it', () => {
  test('every refusal is named, and each returns before touching the row', () => {
    for (const outcome of ['not_found', 'not_draft', 'already_offered', 'no_offer', 'below_floor']) {
      assert.ok(MIGRATION.includes(`'${outcome}'`), `${outcome} must be an answer this function can give`);
    }
  });

  test('one per opportunity, ever — not one per quotation', () => {
    // Keyed on the opportunity, so a NEW version of the same deal cannot be
    // discounted a second time. Live §10 proves both refusals by hitting them.
    assert.match(MIGRATION, /where p\.opportunity_id = v_row\.opportunity_id\n\s+and p\.applied_offer_id is not null/);
  });

  test('an expired offer is not applied even while its row is active', () => {
    assert.match(MIGRATION, /and \(o\.valid_until is null or o\.valid_until >= current_date\)/);
  });

  test('the floor is read from the quotation’s OWN frozen document', () => {
    // G-172 and G-179 both chose this: the figure that binds is the one that
    // was in front of the decider, not the one today's settings would give.
    assert.match(MIGRATION, /v_floor := \(\(v_row\.document->'productionCost'->>'minimumRupees'\)::numeric \* 100\)::bigint/);
  });

  test('the discount and the total are written together', () => {
    // `proposals_total_is_arithmetic` is a CHECK, not a trigger: it holds
    // `total = subtotal - discount + tax` at every instant, so a discount
    // written on its own is refused outright. The live verifier caught this
    // one; no unit test could have, which is why the reason is recorded here.
    assert.match(MIGRATION, /set discount_minor\s+= v_discount,[\s\S]{0,400}?total_minor\s+= v_total,/);
  });

  test('the approval it settles is a REAL request, raised the ordinary way', () => {
    // Not an invented row. `submit_proposal` raises it, so every downstream
    // consumer — the dispatch, the learning, the audit — works unchanged.
    assert.match(MIGRATION, /select \* into v_submit from sales\.submit_proposal\(p_proposal_id, null, null\);/);
    assert.match(MIGRATION, /set state\s+= 'approved',[\s\S]{0,200}decided_by\s+= v_offer\.created_by/);
  });

  test('and it names a human who genuinely decided it, in advance', () => {
    assert.match(MIGRATION, /decision_note = 'Pre-authorised offer applied: '/);
  });

  test('a submission that did not succeed is reported, not papered over', () => {
    assert.match(MIGRATION, /if v_submit\.outcome <> 'submitted' then\n\s+return query select v_submit\.outcome::text/);
  });
});

describe('C. the client is told what they got and why', () => {
  const MESSAGE = {
    title: 'Delivery platform',
    version: 2,
    body: null,
    currency: 'INR',
    items: [{ description: 'Customer app', quantity: 1, amountMinor: 40_000_00 }],
    subtotalMinor: 40_000_00,
    discountMinor: 4_000_00,
    taxMinor: 0,
    totalMinor: 36_000_00,
    validUntil: null,
  };
  const DOC = { offerLabel: 'Sign this week', offerCondition: 'you confirm within 7 days' };

  test('the condition is printed with the discount', () => {
    const body = quotationMessage({ ...MESSAGE, document: DOC });
    assert.match(body, /Sign this week — applies because you confirm within 7 days\./);
    assert.match(body, /Discount: −₹4,000\.00/);
  });

  test('and it sits immediately above the money, so the two are read together', () => {
    const body = quotationMessage({ ...MESSAGE, document: DOC });
    assert.ok(body.indexOf('applies because') < body.indexOf('Subtotal:'));
  });

  test('a quotation with no discount says nothing about an offer', () => {
    // The row carries the label from the moment it is applied; the sentence is
    // about the money, and with no money off there is nothing to explain.
    const body = quotationMessage({ ...MESSAGE, discountMinor: 0, totalMinor: 40_000_00, document: DOC });
    assert.ok(!body.includes('applies because'));
  });

  test('a half-written document loses the sentence, never the figures', () => {
    for (const doc of [null, {}, { offerLabel: 'Sign this week' }, 'not a document']) {
      const body = quotationMessage({ ...MESSAGE, document: doc });
      assert.ok(!body.includes('applies because'), JSON.stringify(doc));
      assert.match(body, /Total: ₹36,000\.00/);
    }
  });

  test('the words are written into the document by the database, while it is still a draft', () => {
    // `proposals_guard` freezes the document the instant it leaves draft, so
    // this is the only moment the sentence can be added at all.
    assert.match(MIGRATION, /'offerLabel', v_offer\.label,\n\s+'offerCondition', v_offer\.condition/);
  });
});

describe('D. the owner is told afterwards', () => {
  test('applying one emits its own event, for its own audience', () => {
    assert.match(MIGRATION, /perform core\.emit_event\([\s\S]{0,80}'offer\.applied'/);
    assert.match(MIGRATION_RAW, /owner being TOLD, which is the half of ADM-98 they asked for by name/);
  });

  test('and it still emits approval.decided, so nothing downstream changes', () => {
    // The dispatch that sends it and the learning that records it both listen
    // to that event already. Neither needs to know an offer was involved.
    assert.match(MIGRATION, /perform core\.emit_event\([\s\S]{0,80}'approval\.decided'/);
  });

  test('the event buys exactly one job, and it is the announcement', () => {
    const jobs = planJobsForEvent({
      id: 1,
      organization_id: 'org-1',
      type: 'offer.applied',
      subject_type: 'proposal',
      subject_id: 'prop-1',
      payload: { offerId: 'off-1' },
    });
    assert.deepEqual(jobs.map((j) => j.kind), ['offer.announce']);
  });

  test('the handler re-reads the ROW — the payload only says which one', () => {
    // ADM-96. An outbox event is insertable over PostgREST by an org owner, so
    // a forged one must not be able to invent a discount nobody gave.
    assert.match(HANDLERS, /\.from\('proposals'\)[\s\S]{0,220}\.eq\('organization_id', job\.organization_id\)/);
    assert.match(HANDLERS, /if \(!proposal\.applied_offer_id\)/);
  });

  test('and it says the thing is done, not that something is waiting', () => {
    assert.match(HANDLERS, /has already gone to the client/);
    assert.match(HANDLERS, /Nothing is waiting on you/);
  });

  test('a redelivered event cannot buzz the owner twice', () => {
    assert.match(HANDLERS, /p_external_ref: `offer:\$\{proposal\.id\}`/);
  });

  test('the announcement is authored by the person whose decision it executes', () => {
    // Satisfies `crm.refuse_unread_price` by being TRUE rather than by carving
    // a hole in it — they really did decide this number, in advance.
    assert.match(HANDLERS, /p_author_id: offer\.created_by/);
  });
});

describe('E. only a price objection, and only before the ordinary path', () => {
  test('a scope change never triggers it — that is not a concession', () => {
    assert.match(WORKFLOWS, /objection\.kind === 'price' \? await applyStandingOffer\(admin, draft\.proposal_id\) : null/);
  });

  test('when it does not apply, the draft goes to the owner exactly as before', () => {
    // Every refusal is a null, not a failure: the offer is an accelerator on a
    // path that already works, and a draft must never be lost because a
    // concession could not be applied to it.
    assert.match(WORKFLOWS, /if \(row\?\.outcome !== 'applied'\) return null;/);
    assert.match(WORKFLOWS, /if \(offered\) \{/);
    assert.match(WORKFLOWS, /const submitted = await submitDraftedQuotation\(admin, draft\.proposal_id\);/);
  });

  test('an error reading the offer is logged and then ignored', () => {
    assert.match(WORKFLOWS, /scope: 'applyStandingOffer'/);
  });
});

describe('F. the override is written down as an override', () => {
  test('the migration says whose decision it is and what it reduces', () => {
    assert.match(MIGRATION_RAW, /THIS MIGRATION REDUCES A CONTROL/);
    assert.match(MIGRATION_RAW, /ADM-22/);
    assert.match(MIGRATION_RAW, /overriding their own earlier decision/);
  });

  test('and the roadmap records ADM-98 as overriding ADM-22 by name', () => {
    const roadmap = JSON.parse(read('docs/roadmap/roadmap.json'));
    const adm98 = roadmap.adminDecisions.find((d: { id: string }) => d.id === 'ADM-98');
    assert.ok(adm98, 'ADM-98 must exist');
    assert.match(JSON.stringify(adm98), /ADM-22/);
    const gap = roadmap.gaps.find((g: { id: string }) => g.id === 'G-184');
    assert.ok(gap, 'G-184 must exist');
    assert.match(gap.status, /^CLOSED/);
  });
});

describe('G. the two write paths, and who each one belongs to', () => {
  /**
   * `db:verify:invokerrls` refused the first version of this migration, which
   * is exactly the class that check exists for: both functions are INVOKER,
   * both write RLS-enabled tables, and neither table had a policy for the
   * write. Against the service role everything passed; from the settings form,
   * signed in as the owner, the insert would have been refused by RLS and the
   * feature would have been dead in the app while every script stayed green.
   */
  test('authoring is an owner act, so the owner may actually write it', () => {
    assert.match(MIGRATION, /create policy approved_offers_insert on sales\.approved_offers[\s\S]{0,160}core\.is_owner\(\)/);
    assert.match(MIGRATION, /create policy approved_offers_update on sales\.approved_offers[\s\S]{0,240}core\.is_owner\(\)/);
  });

  test('and the door that policy opens is only as wide as those two functions', () => {
    // A policy without this is a direct-write forgery surface: an owner could
    // PATCH an uncapped row nobody recorded deciding.
    assert.match(MIGRATION, /current_setting\('sales\.offer_write', true\) = 'on'/);
    assert.match(MIGRATION, /create trigger offer_write_is_sanctioned/);
    assert.equal((MIGRATION.match(/set_config\('sales\.offer_write', 'on', true\)/g) ?? []).length, 2);
  });

  test('the service role passes it, because it holds the whole database already', () => {
    assert.match(MIGRATION, /if \(select auth\.uid\(\)\) is null then\n\s+return new;/);
  });

  test('applying one is reachable by nobody who is signed in', () => {
    // It settles an approval request. An authenticated caller reaching it
    // decides their own price, which is the whole thing ADM-98 bounded.
    assert.match(MIGRATION, /revoke execute on function sales\.apply_approved_offer\(uuid\) from anon, authenticated;/);
  });

  test('and is granted back to the one caller it has', () => {
    // Revoking from PUBLIC takes the default grant from every role including
    // this one. Without the grant the agent cannot call its own function —
    // which the live verifier said in the plainest way: every guard passed and
    // nothing could be applied.
    assert.match(MIGRATION, /grant execute on function sales\.apply_approved_offer\(uuid\) to service_role;/);
  });
});
