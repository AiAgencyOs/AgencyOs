#!/usr/bin/env node
/**
 * The quotation offers a choice, verified against a real database.
 *
 * Gap G-166, decision ADM-97 — one opportunity, two or three plans, the owner
 * approves the OFFER once at the recommended plan's price, and the client picks
 * one. Everything this script drives is new, and every guarantee it proves is
 * held in Postgres rather than the service layer, because each is something two
 * callers could race or a raw PostgREST write could forge.
 *
 * What it proves:
 *
 *   1. A set is 2 or 3 plans. A single plan is refused (bad_count) and a fourth
 *      is refused — the cap ADM-97 chose over free siblings.
 *   2. The recommendation is required. A set that names no in-range recommended
 *      slot is refused, because its amount is what selects the approver.
 *   3. One live offer per deal, across both kinds: drafting a set supersedes a
 *      live standalone quote, and a standalone quote drafted afterwards
 *      supersedes the set. The re-keyed live index is what makes this hold.
 *   4. Submitting raises exactly ONE approval, on the recommended plan, carrying
 *      the recommended plan's total — so the same proposal money-floor ladder
 *      that decides a single quote decides the whole offer.
 *   5. Nothing reaches the client before the owner approves (ADM-07's gate).
 *   6. The client picks one plan: that plan is accepted, its siblings
 *      superseded, the set accepted, and plan_set.accepted fires with the
 *      CHOSEN plan's id and total — one winner, as if a single quote had been
 *      accepted. No proposal is deleted.
 *   7. A plan from another offer, or one already settled, cannot be chosen.
 *   8. Declining the whole offer refuses the set and every live member, and
 *      fires plan_set.rejected.
 *
 *   node scripts/verify-plan-set.mjs
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

// Drives the database directly and never calls the job runner, so no
// CRON_SECRET; needs the JWT secret to mint the owner who approves.
const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'verify-plan-set');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-planset';
const ORG = '00000000-0000-4000-8000-000000000001';

let failures = 0;
let checks = 0;

function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function call(token, method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: token,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Profile': schema,
      'Content-Profile': schema,
      Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: parse(text), text };
}

const rest = (m, s, p, b) => call(KEY, m, s, p, b);
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

function mint(userId, role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub: userId,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { organization_id: ORG, role },
    iat: now,
    exp: now + 900,
  });
  return `${header}.${body}.${createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url')}`;
}

// ── RPC shorthands ──────────────────────────────────────────────────────────

const draftSet = (opportunityId, plans, recommendedSlot, extra = {}) =>
  rest('POST', 'sales', 'rpc/draft_plan_set', {
    p_opportunity_id: opportunityId,
    p_plans: plans,
    p_recommended_slot: recommendedSlot,
    ...extra,
  });

const draftStandalone = (opportunityId, title) =>
  rest('POST', 'sales', 'rpc/draft_proposal', {
    p_opportunity_id: opportunityId,
    p_title: title,
  });

const addLine = (proposalId, description, quantity, unitPriceMinor) =>
  rest('POST', 'sales', 'rpc/add_proposal_item', {
    p_proposal_id: proposalId,
    p_description: description,
    p_quantity: quantity,
    p_unit_price_minor: unitPriceMinor,
  });

const submitSet = (planSetId, requestedBy) =>
  rest('POST', 'sales', 'rpc/submit_plan_set', {
    p_plan_set_id: planSetId,
    p_requested_by: requestedBy,
  });

const syncSet = (planSetId) =>
  rest('POST', 'sales', 'rpc/sync_plan_set_decision', { p_plan_set_id: planSetId });

const sendSet = (planSetId, extra = {}) =>
  rest('POST', 'sales', 'rpc/send_plan_set', { p_plan_set_id: planSetId, ...extra });

const chooseSet = (planSetId, chosenProposalId, extra = {}) =>
  rest('POST', 'sales', 'rpc/record_plan_set_choice', {
    p_plan_set_id: planSetId,
    p_chosen_proposal_id: chosenProposalId,
    ...extra,
  });

const respondSet = (planSetId, response, extra = {}) =>
  rest('POST', 'sales', 'rpc/record_plan_set_response', {
    p_plan_set_id: planSetId,
    p_response: response,
    ...extra,
  });

const statusOf = async (proposalId) =>
  (one(await rest('GET', 'sales', `proposals?id=eq.${proposalId}&select=status`)) ?? {}).status;

const setStatusOf = async (planSetId) =>
  (one(await rest('GET', 'sales', `proposal_plan_sets?id=eq.${planSetId}&select=status`)) ?? {})
    .status;

// A member is priced by adding one line — total_minor is item-summed
// arithmetic, so this is the trusted number submit_plan_set reads.
async function priceMembers(proposalIds, perPlanMinor) {
  for (let i = 0; i < proposalIds.length; i += 1) {
    await addLine(proposalIds[i], `Scope of plan ${i + 1}`, 1, perPlanMinor[i]);
  }
}

const created = { users: [], leads: [], opportunities: [], sets: [] };

async function newDeal(name) {
  const lead = one(
    await rest('POST', 'crm', 'leads', {
      organization_id: ORG,
      source: 'manual',
      title: `${MARKER} ${name}`,
      status: 'new',
    }),
  );
  created.leads.push(lead.id);

  const opportunity = one(
    await rest('POST', 'sales', 'opportunities', {
      organization_id: ORG,
      lead_id: lead.id,
      name: `${MARKER} ${name}`,
      stage: 'discovery',
      value_minor: 0,
      currency: 'INR',
    }),
  );
  created.opportunities.push(opportunity.id);
  return opportunity.id;
}

const THREE_PLANS = [
  { title: 'Starter', label: 'Starter', body: 'The essentials.' },
  { title: 'Growth', label: 'Growth', body: 'The recommended path.' },
  { title: 'Scale', label: 'Scale', body: 'Everything, at pace.' },
];
const TWO_PLANS = THREE_PLANS.slice(0, 2);

console.log('\n\x1b[1mAgencyOS — the quotation offers a choice (G-166, ADM-97)\x1b[0m');

try {
  // ── 1. the 2-3 cap ────────────────────────────────────────────────────────
  //
  // This is self-red-proving: it passes ONLY because draft_plan_set refuses a
  // count outside 2-3. Drop that check and both refusals below flip to
  // 'created', turning the whole run red — which is why no separate mangling
  // pass is needed to know the cap is live.
  console.log('\n1. A quotation offer is two or three plans, never one, never four');
  {
    const deal = await newDeal('cap');

    const one_plan = one(await draftSet(deal, [THREE_PLANS[0]], 1));
    check(
      one_plan?.outcome === 'bad_count',
      'a single plan is refused — an offer is a choice, and one plan is not a choice',
      `outcome ${one_plan?.outcome}`,
    );

    const four_plans = one(
      await draftSet(deal, [...THREE_PLANS, { title: 'Bespoke', label: 'Bespoke' }], 1),
    );
    check(
      four_plans?.outcome === 'bad_count',
      'a fourth plan is refused — the cap ADM-97 chose over free siblings',
      `outcome ${four_plans?.outcome}`,
    );

    // Nothing was minted by either refusal.
    const orphans = await rest(
      'GET',
      'sales',
      `proposals?opportunity_id=eq.${deal}&select=id`,
    );
    check(
      (orphans.json ?? []).length === 0,
      'and a refused count mints no proposals',
      `${(orphans.json ?? []).length} left behind`,
    );
  }

  // ── 2. the recommendation is required ──────────────────────────────────────
  console.log('\n2. The recommended plan is required, and must name a real slot');
  {
    const deal = await newDeal('recommended');

    const noneNamed = one(await draftSet(deal, THREE_PLANS, null));
    check(
      noneNamed?.outcome === 'bad_recommended',
      'a set naming no recommended slot is refused — its amount selects the approver',
      `outcome ${noneNamed?.outcome}`,
    );

    const outOfRange = one(await draftSet(deal, THREE_PLANS, 4));
    check(
      outOfRange?.outcome === 'bad_recommended',
      'and one recommending slot 4 of a 3-plan offer is refused too',
      `outcome ${outOfRange?.outcome}`,
    );
  }

  // ── 3. one live offer per deal, across both kinds ──────────────────────────
  //
  // The re-keyed live index (opportunity_id, coalesce(plan_slot, 0)) is what
  // lets three members share an opportunity while still allowing exactly one
  // live standalone quote (slot 0). Drafting one kind must supersede the other.
  console.log('\n3. A deal has one live offer — a set and a standalone cannot both be live');
  {
    const deal = await newDeal('exclusive');

    // A standalone quote goes live first.
    const quote = one(await draftStandalone(deal, `${MARKER} standalone`));
    check(quote?.outcome === 'created', 'a standalone quote drafts live', `outcome ${quote?.outcome}`);

    // Drafting a set supersedes it.
    const set1 = one(await draftSet(deal, TWO_PLANS, 2));
    check(set1?.outcome === 'created', 'a set drafts over it', `outcome ${set1?.outcome}`);
    check(
      (await statusOf(quote.proposal_id)) === 'superseded',
      'and the standalone it drafted over is superseded — one live offer, not two',
      await statusOf(quote.proposal_id),
    );

    // Drafting a standalone again supersedes the whole set.
    const quote2 = one(await draftStandalone(deal, `${MARKER} standalone again`));
    check(quote2?.outcome === 'created', 'a standalone drafts back over the set');
    check(
      (await setStatusOf(set1.plan_set_id)) === 'superseded',
      'and the set is superseded whole — the standalone took the floor',
      await setStatusOf(set1.plan_set_id),
    );
    for (const id of set1.proposal_ids) {
      check(
        (await statusOf(id)) === 'superseded',
        `  member ${id.slice(0, 8)} went superseded with its set`,
        await statusOf(id),
      );
    }
  }

  // ── the owner the rest of the run needs ────────────────────────────────────
  //
  // Through the Auth admin API, because core.users references auth.users.
  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      email: `${MARKER}-owner-${randomUUID().slice(0, 8)}@example.invalid`,
      password: randomUUID(),
      email_confirm: true,
    }),
  }).then((r) => r.json());
  const ownerId = authUser?.id;
  if (!ownerId) throw new Error(`could not create the owner: ${JSON.stringify(authUser).slice(0, 200)}`);

  await rest('POST', 'core', 'users', { id: ownerId, email: authUser.email });
  await rest('POST', 'core', 'memberships', {
    organization_id: ORG,
    user_id: ownerId,
    role: 'owner',
    status: 'active',
  });
  created.users.push(ownerId);
  const owner = mint(ownerId, 'owner');

  // The proposal money-floor policy this offer reuses (ADM-07: at the owner).
  await call(owner, 'POST', 'approvals', 'approval_policies', {
    organization_id: ORG,
    subject_type: 'proposal',
    min_amount_minor: 0,
    required_role: 'owner',
    sla_hours: 48,
    audience: 'internal',
  });

  // ── 4. one approval, on the recommended plan, carrying its total ───────────
  console.log('\n4. Submitting raises ONE approval, on the recommended plan, at its price');
  const deal = await newDeal('flow');
  const set = one(await draftSet(deal, THREE_PLANS, 2, { p_created_by: ownerId }));
  check(set?.outcome === 'created' && set?.proposal_ids?.length === 3, 'a 3-plan set drafts');
  created.sets.push(set.plan_set_id);
  const [slot1, slot2, slot3] = set.proposal_ids;

  // An offer with a hole in it is refused: a set whose rungs carry no lines has
  // no amount on some plan, and submit_plan_set will not raise an approval for it.
  const unpriced = one(await submitSet(set.plan_set_id, ownerId));
  check(
    unpriced?.outcome === 'no_items',
    'a set with an unpriced rung cannot be submitted — every plan is an offer',
    `outcome ${unpriced?.outcome}`,
  );

  // Price each rung distinctly; slot 2 (₹50,000) is the recommended one.
  await priceMembers([slot1, slot2, slot3], [3000000, 5000000, 8000000]);

  const submitted = one(await submitSet(set.plan_set_id, ownerId));
  check(submitted?.outcome === 'submitted', 'the priced set submits', `outcome ${submitted?.outcome}`);
  const requestId = submitted?.request_id;

  // Exactly one approval request, and its amount is the recommended plan's total.
  const requests = await rest(
    'GET',
    'approvals',
    `approval_requests?subject_id=eq.${slot2}&select=id,subject_type,amount_minor,required_role,state,audience`,
  );
  check(
    (requests.json ?? []).length === 1,
    'exactly one approval is raised, on the recommended plan (subject a real proposal row)',
    `${(requests.json ?? []).length} requests`,
  );
  const request = one(requests);
  check(
    request?.subject_type === 'proposal' && request?.amount_minor === 5000000,
    'carrying the recommended plan’s total — the proposal money-floor ladder decides the offer',
    `type ${request?.subject_type}, amount ${request?.amount_minor}`,
  );
  check(request?.required_role === 'owner', 'and the owner is who it names (ADM-07)');
  check(request?.audience === 'internal', 'internal — the owner signing, not the client answering');

  // No second request against any sibling.
  const siblingReqs = await rest(
    'GET',
    'approvals',
    `approval_requests?subject_id=in.(${slot1},${slot3})&select=id`,
  );
  check(
    (siblingReqs.json ?? []).length === 0,
    'the siblings raise no approval of their own — the owner approves the offer once',
    `${(siblingReqs.json ?? []).length} sibling requests`,
  );

  // Every member moved to pending_approval with the set.
  for (const id of set.proposal_ids) {
    check(
      (await statusOf(id)) === 'pending_approval',
      `  member ${id.slice(0, 8)} waits with the set`,
      await statusOf(id),
    );
  }

  // ── 5. nothing reaches the client before the owner approves ────────────────
  console.log('\n5. Nothing reaches the client before the owner says so');
  {
    const early = one(await sendSet(set.plan_set_id));
    check(
      early?.outcome === 'not_approved' && early?.status === 'pending_approval',
      'an unapproved offer cannot be sent (ADM-07’s gate)',
      `outcome ${early?.outcome}`,
    );

    // The owner approves.
    const decided = one(
      await call(owner, 'POST', 'approvals', 'rpc/decide_approval', {
        p_request_id: requestId,
        p_decision: 'approved',
      }),
    );
    check(decided?.outcome === 'decided', 'the owner approves the offer', `outcome ${decided?.outcome}`);

    const synced = await syncSet(set.plan_set_id);
    check(String(synced.json) === 'approved', 'and approval lands on the set');
    check((await setStatusOf(set.plan_set_id)) === 'approved', '  the set is approved');
    for (const id of set.proposal_ids) {
      check((await statusOf(id)) === 'approved', `  member ${id.slice(0, 8)} approved with it`);
    }

    const sent = one(await sendSet(set.plan_set_id, { p_message_ref: 'wamid.PLANSET' }));
    check(sent?.outcome === 'sent', 'an approved offer sends', `outcome ${sent?.outcome}`);
    check((await setStatusOf(set.plan_set_id)) === 'sent', '  the set is sent');
    for (const id of set.proposal_ids) {
      check((await statusOf(id)) === 'sent', `  member ${id.slice(0, 8)} sent with it`);
    }

    const sentEvent = await rest(
      'GET',
      'core',
      `outbox_events?subject_id=eq.${set.plan_set_id}&event_type=eq.plan_set.sent&select=id`,
    );
    check((sentEvent.json ?? []).length === 1, '  and plan_set.sent fires once');
  }

  // ── 7. a plan from another offer, or one already settled, cannot be chosen ─
  console.log('\n6. The chosen plan must be a live member of THIS offer');
  {
    const stranger = one(await sendSet(set.plan_set_id)); // already sent
    check(stranger?.outcome === 'already_sent', 'sending twice is one send, not two');

    // A proposal that belongs to no set (a standalone on a different deal).
    const otherDeal = await newDeal('stranger');
    const strangerQuote = one(await draftStandalone(otherDeal, `${MARKER} stranger quote`));
    const notMember = one(await chooseSet(set.plan_set_id, strangerQuote.proposal_id));
    check(
      notMember?.outcome === 'not_a_member',
      'a proposal from another deal cannot be the choice',
      `outcome ${notMember?.outcome}`,
    );
  }

  // ── 6. the client picks one plan ───────────────────────────────────────────
  console.log('\n7. The client picks one plan — one winner, its siblings superseded');
  {
    // The client chooses the recommended plan (slot 2).
    const chosen = one(
      await chooseSet(set.plan_set_id, slot2, { p_note: 'We’ll take Growth.' }),
    );
    check(chosen?.outcome === 'accepted', 'the choice is recorded', `outcome ${chosen?.outcome}`);

    check((await statusOf(slot2)) === 'accepted', 'the chosen plan is accepted');
    check((await statusOf(slot1)) === 'superseded', 'plan 1 is superseded');
    check((await statusOf(slot3)) === 'superseded', 'plan 3 is superseded');
    check((await setStatusOf(set.plan_set_id)) === 'accepted', 'the set is accepted');

    const setRow = one(
      await rest(
        'GET',
        'sales',
        `proposal_plan_sets?id=eq.${set.plan_set_id}&select=chosen_proposal_id`,
      ),
    );
    check(setRow?.chosen_proposal_id === slot2, 'the set records which plan was chosen');

    // No proposal was deleted — the losing plans are superseded, kept as record.
    const survivors = await rest(
      'GET',
      'sales',
      `proposals?plan_set_id=eq.${set.plan_set_id}&select=id`,
    );
    check(
      (survivors.json ?? []).length === 3,
      'all three plans survive as rows — a supersede is not a delete',
      `${(survivors.json ?? []).length} rows`,
    );

    // One accepted event, carrying the CHOSEN plan's id and total.
    const acceptedEvent = one(
      await rest(
        'GET',
        'core',
        `outbox_events?subject_id=eq.${set.plan_set_id}&event_type=eq.plan_set.accepted&select=payload`,
      ),
    );
    check(
      acceptedEvent?.payload?.chosenProposalId === slot2 &&
        acceptedEvent?.payload?.totalMinor === 5000000,
      'plan_set.accepted carries the chosen plan’s id and total — one winner, as a single quote would',
      JSON.stringify(acceptedEvent?.payload ?? null).slice(0, 120),
    );

    // An accepted offer is no longer answerable.
    const late = one(await chooseSet(set.plan_set_id, slot1));
    check(late?.outcome === 'not_answerable', 'a settled offer cannot be chosen again');
  }

  // ── 8. declining the whole offer ───────────────────────────────────────────
  console.log('\n8. The client can decline the whole offer');
  {
    const declineDeal = await newDeal('decline');
    const declineSet = one(await draftSet(declineDeal, TWO_PLANS, 1, { p_created_by: ownerId }));
    created.sets.push(declineSet.plan_set_id);
    await priceMembers(declineSet.proposal_ids, [2000000, 4000000]);

    const sub = one(await submitSet(declineSet.plan_set_id, ownerId));
    await call(owner, 'POST', 'approvals', 'rpc/decide_approval', {
      p_request_id: sub.request_id,
      p_decision: 'approved',
    });
    await syncSet(declineSet.plan_set_id);
    await sendSet(declineSet.plan_set_id);

    // Accepting through the decline path is refused — an acceptance is a choice.
    const wrongVerb = one(await respondSet(declineSet.plan_set_id, 'accepted'));
    check(
      wrongVerb?.outcome === 'invalid_response',
      'the decline path refuses ‘accepted’ — accepting is picking a plan',
      `outcome ${wrongVerb?.outcome}`,
    );

    const declined = one(await respondSet(declineSet.plan_set_id, 'rejected', { p_note: 'Not now.' }));
    check(declined?.outcome === 'recorded', 'the whole offer is declined', `outcome ${declined?.outcome}`);
    check((await setStatusOf(declineSet.plan_set_id)) === 'rejected', '  the set is rejected');
    for (const id of declineSet.proposal_ids) {
      check((await statusOf(id)) === 'rejected', `  member ${id.slice(0, 8)} rejected with it`);
    }

    const rejectedEvent = await rest(
      'GET',
      'core',
      `outbox_events?subject_id=eq.${declineSet.plan_set_id}&event_type=eq.plan_set.rejected&select=id`,
    );
    check((rejectedEvent.json ?? []).length === 1, '  and plan_set.rejected fires once');
  }
} finally {
  // Events first — keyed to the set (plan_set.*) and to the members (proposal.*
  // if any fired). Then rows, children before parents.
  for (const id of created.sets) {
    await rest('DELETE', 'core', `outbox_events?subject_id=eq.${id}`);
  }
  await rest('DELETE', 'core', 'outbox_events?subject_type=eq.approval_request');

  for (const id of created.opportunities) {
    const quotes = (await rest('GET', 'sales', `proposals?opportunity_id=eq.${id}&select=id`)).json ?? [];
    for (const q of quotes) {
      await rest('DELETE', 'core', `outbox_events?subject_id=eq.${q.id}`);
      await rest('DELETE', 'sales', `proposal_items?proposal_id=eq.${q.id}`);
    }
    // Members reference the set via plan_set_id; both cascade from the
    // opportunity, but the members must go before the set row.
    await rest('DELETE', 'sales', `proposals?opportunity_id=eq.${id}`);
    await rest('DELETE', 'sales', `proposal_plan_sets?opportunity_id=eq.${id}`);
    await rest('DELETE', 'sales', `opportunities?id=eq.${id}`);
  }
  for (const id of created.leads) {
    await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  }

  // Approval requests refuse deletion by design; they are cancelled instead.
  const pending = await rest('GET', 'approvals', 'approval_requests?state=eq.pending&select=id');
  for (const row of pending.json ?? []) {
    await rest('PATCH', 'approvals', `approval_requests?id=eq.${row.id}`, {
      state: 'cancelled',
      decided_at: new Date().toISOString(),
    });
  }
  await rest('DELETE', 'approvals', `approval_policies?organization_id=eq.${ORG}`);

  for (const id of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      cache: 'no-store',
    });
  }
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ Two or three plans, approved once, and the client picks one\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
