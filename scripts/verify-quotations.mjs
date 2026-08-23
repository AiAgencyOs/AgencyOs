#!/usr/bin/env node
/**
 * The quotation loop, verified against a real database.
 *
 * Gap G-011, decision ADM-07 — staff draft, the owner approves, then it is
 * sent — against Document 09 §15–§18 and §22.
 *
 * `sales.proposals` and `sales.proposal_items` had tables and no code from the
 * first day of this repository. Everything this script drives is new, and the
 * guarantees it proves are held in Postgres rather than in the service layer,
 * because every one of them is something two callers could race.
 *
 * What it proves:
 *
 *   1. The totals are arithmetic, not a caller's claim. A line whose
 *      `amount_minor` disagrees with its own quantity and price is corrected,
 *      and the subtotal is summed from the lines — which matters because the
 *      total is what selects the approver.
 *   2. Versions are allocated under the opportunity's lock: two simultaneous
 *      drafts become v1 and v2, never two v1s.
 *   3. Only one version is live (§16). Drafting the next one supersedes the
 *      previous, and cancels the approval it was waiting on.
 *   4. A version is frozen the moment it leaves draft — its terms and its
 *      lines both, because an approval names the exact version (§16).
 *   5. Submitting raises an internal approval carrying the total, and the
 *      policy ladder resolves the approver from it (§17).
 *   6. No proposal policy may name below the owner: the money floor refuses it
 *      in DDL (ADM-07).
 *   7. Sending refuses anything the owner has not approved, and the owner's
 *      refusal returns the quote to draft.
 *   8. Delivery is not acceptance (§18): a sent quote must be answered
 *      explicitly, an unsent one cannot be accepted at all, and a lapsed one
 *      cannot be accepted but can still be refused (§15).
 *   9. A settled quotation never moves again.
 *
 *   node scripts/verify-quotations.mjs
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';
// The announcement's own composer, imported rather than reimplemented.
//
// Both halves of §14 were provable on their own and the join between them was
// not: `submit_proposal` writes a payload, `announcementFor` renders one, and
// nothing checked they were the same shape. A rename on either side would have
// left every check green with the owner's message quietly back to a total and
// a code. Running the real payload through the real composer is what closes
// that — it is the reason this script is launched with the alias loader.
import { announcementFor } from '../src/modules/crm/schema.ts';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

// Drives the database directly and never calls the job runner, so no
// CRON_SECRET; needs the JWT secret to mint the owner who approves.
const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'verify-quotations');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-quote';
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

const draft = (opportunityId, title, extra = {}) =>
  rest('POST', 'sales', 'rpc/draft_proposal', {
    p_opportunity_id: opportunityId,
    p_title: title,
    ...extra,
  });

const addLine = (proposalId, description, quantity, unitPriceMinor) =>
  rest('POST', 'sales', 'rpc/add_proposal_item', {
    p_proposal_id: proposalId,
    p_description: description,
    p_quantity: quantity,
    p_unit_price_minor: unitPriceMinor,
  });

const statusOf = async (proposalId) =>
  (
    one(await rest('GET', 'sales', `proposals?id=eq.${proposalId}&select=status`)) ?? {}
  ).status;

const created = { users: [], leads: [], opportunities: [] };

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

console.log('\n\x1b[1mAgencyOS — the quotation loop (G-011, ADM-07)\x1b[0m');

try {
  // ── 6, first: the money floor, before any policy exists ─────────────────
  console.log('\n1. No quotation policy may name below the owner');
  {
    const refused = await rest('POST', 'approvals', 'approval_policies', {
      organization_id: ORG,
      subject_type: 'proposal',
      min_amount_minor: 0,
      required_role: 'ops_admin',
      sla_hours: 48,
      audience: 'internal',
    });
    check(
      refused.status >= 400 && refused.text.includes('approval_policies_money_floor'),
      'an ops_admin quotation policy is refused in DDL (ADM-07)',
      `status ${refused.status}`,
    );

    const alsoRefused = await rest('POST', 'approvals', 'approval_policies', {
      organization_id: ORG,
      subject_type: 'proposal',
      min_amount_minor: 0,
      required_role: 'delivery_lead',
      sla_hours: 48,
      audience: 'internal',
    });
    check(
      alsoRefused.status >= 400,
      'and so is a delivery_lead one',
      `status ${alsoRefused.status}`,
    );
  }

  // ── 1. the totals are arithmetic ────────────────────────────────────────
  console.log('\n2. The total is arithmetic, not a claim');
  {
    const deal = await newDeal('totals');
    const quote = one(await draft(deal, 'Website build'));
    check(quote?.outcome === 'created' && quote?.version === 1, 'the first version is v1');

    const added = one(await addLine(quote.proposal_id, 'Design', 3, 100000));
    check(
      added?.subtotal_minor === 300000 && added?.total_minor === 300000,
      'three lines at ₹1,000 sum to ₹3,000',
      `subtotal ${added?.subtotal_minor}`,
    );

    // The line that lies about itself. Posted straight through PostgREST,
    // which is the path a service-layer calculation would not cover.
    await rest('POST', 'sales', 'proposal_items', {
      organization_id: ORG,
      proposal_id: quote.proposal_id,
      position: 9,
      description: 'Liar',
      quantity: 2,
      unit_price_minor: 1000,
      amount_minor: 99999999,
    });

    const liar = one(
      await rest('GET', 'sales', `proposal_items?description=eq.Liar&select=amount_minor`),
    );
    check(
      liar?.amount_minor === 2000,
      'a line whose amount disagrees with its own numbers is corrected',
      `amount ${liar?.amount_minor}`,
    );

    const summed = one(
      await rest('GET', 'sales', `proposals?id=eq.${quote.proposal_id}&select=subtotal_minor,total_minor`),
    );
    check(
      summed?.subtotal_minor === 302000 && summed?.total_minor === 302000,
      'and the subtotal is the sum of the lines, not what anybody posted',
      `subtotal ${summed?.subtotal_minor}`,
    );

    const priced = one(
      await rest('POST', 'sales', 'rpc/set_proposal_pricing', {
        p_proposal_id: quote.proposal_id,
        p_discount_minor: 50000,
        p_tax_minor: 18000,
      }),
    );
    check(
      priced?.total_minor === 270000,
      'discount and tax fall out of the same arithmetic (302000 − 50000 + 18000)',
      `total ${priced?.total_minor}`,
    );

    const tooMuch = one(
      await rest('POST', 'sales', 'rpc/set_proposal_pricing', {
        p_proposal_id: quote.proposal_id,
        p_discount_minor: 99999999,
      }),
    );
    check(
      tooMuch?.outcome === 'discount_exceeds_subtotal',
      'a discount larger than the work is an answer, not a 500',
      `outcome ${tooMuch?.outcome}`,
    );

    created.totalsDeal = deal;
    created.totalsQuote = quote.proposal_id;
  }

  // ── 2. version allocation under the lock ────────────────────────────────
  console.log('\n3. Two drafts at once become v1 and v2');
  {
    const deal = await newDeal('versions');
    const [a, b] = await Promise.all([draft(deal, 'Option A'), draft(deal, 'Option B')]);
    const versions = [one(a)?.version, one(b)?.version].sort();

    check(
      versions[0] === 1 && versions[1] === 2,
      'never two v1s, because the number is allocated under the opportunity’s lock',
      versions.join(' and '),
    );

    const live = (
      await rest(
        'GET',
        'sales',
        `proposals?opportunity_id=eq.${deal}&status=in.(draft,pending_approval,approved,sent)&select=id,version`,
      )
    ).json;
    check(
      Array.isArray(live) && live.length === 1 && live[0].version === 2,
      'and exactly one is live — the later one (§16)',
      `${live?.length} live`,
    );

    const superseded = (
      await rest('GET', 'sales', `proposals?opportunity_id=eq.${deal}&status=eq.superseded&select=version`)
    ).json;
    check(
      Array.isArray(superseded) && superseded.length === 1,
      'the earlier version stays, as the history §16 asks for',
      `${superseded?.length} superseded`,
    );
  }

  // ── the owner the rest of the run needs ─────────────────────────────────
  //
  // Through the Auth admin API, because core.users references auth.users: an
  // id that never signed up fails the foreign key, and the failure surfaces
  // much later as "decided_by is not present in users".
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

  // ── 5, first half: with no policy, nothing is submitted ─────────────────
  console.log('\n4. Without an approver, nothing is submitted');
  {
    const refused = one(
      await rest('POST', 'sales', 'rpc/submit_proposal', { p_proposal_id: created.totalsQuote }),
    );
    check(
      refused?.outcome === 'no_policy',
      'submission is refused when no policy covers quotations',
      `outcome ${refused?.outcome}`,
    );
    check(
      (await statusOf(created.totalsQuote)) === 'draft',
      'and the quotation stays a draft',
    );
  }

  const policy = await call(owner, 'POST', 'approvals', 'approval_policies', {
    organization_id: ORG,
    subject_type: 'proposal',
    min_amount_minor: 0,
    required_role: 'owner',
    sla_hours: 48,
    audience: 'internal',
  });
  check(policy.status < 300, 'an owner policy is accepted', `status ${policy.status}`);
  created.policy = one(policy)?.id;

  // ── 5. submitting carries the money ─────────────────────────────────────
  console.log('\n5. Submitting puts the price in front of the owner');
  {
    const submitted = one(
      await rest('POST', 'sales', 'rpc/submit_proposal', {
        p_proposal_id: created.totalsQuote,
        p_requested_by: ownerId,
      }),
    );
    check(submitted?.outcome === 'submitted', 'the first submission raises a request', `outcome ${submitted?.outcome}`);
    created.request = submitted?.request_id;

    const request = one(
      await rest(
        'GET',
        'approvals',
        `approval_requests?id=eq.${created.request}&select=subject_type,audience,amount_minor,required_role,state`,
      ),
    );
    check(
      request?.subject_type === 'proposal' && request?.audience === 'internal',
      'against the quotation, for the agency to answer — not the client',
      `${request?.subject_type}/${request?.audience}`,
    );
    check(
      request?.amount_minor === 270000,
      'carrying the total, which is what §17’s ladder resolves the approver from',
      `amount ${request?.amount_minor}`,
    );
    check(request?.required_role === 'owner', 'and the owner is who it names (ADM-07)');

    // ── §14: what the owner is handed is the quotation, not a pointer to it ──
    //
    // The announcement is composed from this payload, so what is missing here
    // is missing from the owner's phone. Before this, the payload carried the
    // totals and no scope: the owner saw ₹3,020 and could not see that it was
    // three days of design — which is the half of a quotation a review is
    // actually about.
    const row = one(
      await rest('GET', 'approvals', `approval_requests?id=eq.${created.request}&select=payload,reference,summary,subject_type`),
    );
    const payload = row?.payload;

    check(Array.isArray(payload?.items), 'the payload carries the quotation’s lines', `items ${JSON.stringify(payload?.items)}`);
    check(
      payload?.items?.length === 2,
      'both of them, not the first or a sample',
      `${payload?.items?.length} line(s)`,
    );
    check(
      payload?.items?.[0]?.description === 'Design' && payload?.items?.[1]?.description === 'Liar',
      'in the order the quotation lists them, so two announcements of one quote read alike',
      JSON.stringify(payload?.items?.map((i) => i.description)),
    );
    check(
      Number(payload?.items?.[0]?.quantity) === 3,
      'with the quantity, which is the reason a number sits beside a line',
      `quantity ${payload?.items?.[0]?.quantity}`,
    );
    check(
      payload?.items?.[0]?.amount_minor === 300000,
      'and the corrected amount, not the one a caller claimed',
      `amount ${payload?.items?.[0]?.amount_minor}`,
    );
    check(
      payload?.total_minor === request?.amount_minor,
      'the payload’s total is the same total the ladder resolved the approver from',
      `${payload?.total_minor} vs ${request?.amount_minor}`,
    );
    check(
      payload?.items?.length > 0 && payload.items.every((i) => i.unit_price_minor === undefined),
      'and the line carries no unit price — the announcement states what a line costs, not how it was arrived at',
    );

    // ── and the shape survives the trip into the announcement ─────────────
    //
    // The real payload, through the real composer. Not a fixture that agrees
    // with itself.
    const announced = announcementFor(
      {
        reference: row?.reference,
        subjectType: row?.subject_type,
        subjectId: created.totalsQuote,
        summary: row?.summary ?? null,
        amountMinor: request?.amount_minor ?? null,
        requiredRole: request?.required_role ?? null,
        slaDueAt: null,
      },
      true,
      payload,
    );

    check(/What it covers:/.test(announced), 'the announcement built from it shows the scope', announced.split('\n')[0]);
    check(
      /• Design ×3 — ₹3,000/.test(announced),
      'with the line as the quotation records it — quantity, description and price',
      announced.split('\n').find((l) => l.startsWith('• ')) ?? '(no lines)',
    );
    // This quotation carries a discount, so the announcement owes the owner
    // all three numbers: what the work came to, what came off it, and what is
    // left. A bare total hides the concession being approved.
    check(
      /Subtotal: ₹3,020\.00/.test(announced),
      'the subtotal the lines add up to',
      announced.split('\n').find((l) => l.startsWith('Subtotal')) ?? '(none)',
    );
    check(
      /Discount: −₹500\.00/.test(announced),
      'the discount coming off it, which is the concession being approved',
      announced.split('\n').find((l) => l.startsWith('Discount')) ?? '(none)',
    );
    check(
      /Tax: ₹180\.00/.test(announced),
      'the tax going back on',
      announced.split('\n').find((l) => l.startsWith('Tax')) ?? '(none)',
    );
    check(
      announced.split('Website build').length - 1 === 1,
      'and the generated summary is not printed above a block that already says it',
      `title appears ${announced.split('Website build').length - 1}×`,
    );
    check(
      /Total: ₹2,700\.00/.test(announced),
      'and what is left',
      announced.split('\n').find((l) => l.startsWith('Total')) ?? '(none)',
    );
    if (process.env.SHOW_ANNOUNCEMENT) console.log(`\n${announced}\n`);
    check(
      !/Reply/i.test(announced) && /Decide it in AgencyOS/.test(announced),
      'and it still sends the owner to AgencyOS rather than inviting a reply (ADM-74)',
    );

    const again = one(
      await rest('POST', 'sales', 'rpc/submit_proposal', { p_proposal_id: created.totalsQuote }),
    );
    check(
      again?.outcome === 'already_pending' && again?.request_id === created.request,
      'submitting twice does not raise a second question',
      `outcome ${again?.outcome}`,
    );
  }

  // ── 4. frozen once it leaves draft ──────────────────────────────────────
  console.log('\n6. A submitted version is frozen, terms and lines both');
  {
    const retitled = await rest('PATCH', 'sales', `proposals?id=eq.${created.totalsQuote}`, {
      title: 'Quietly renamed',
    });
    check(
      retitled.status >= 400 && !retitled.text.includes('PGRST106'),
      'the title cannot be changed after the fact',
      `status ${retitled.status}, ${retitled.text.slice(0, 100)}`,
    );

    const repriced = await rest('PATCH', 'sales', `proposals?id=eq.${created.totalsQuote}`, {
      total_minor: 1,
    });
    check(repriced.status >= 400, 'and neither can the total the owner is looking at');

    const extraLine = await addLine(created.totalsQuote, 'Sneaked in', 1, 500000);
    check(
      one(extraLine)?.outcome === 'not_draft',
      'a line cannot be added to it',
      `outcome ${one(extraLine)?.outcome}`,
    );

    const directLine = await rest('POST', 'sales', 'proposal_items', {
      organization_id: ORG,
      proposal_id: created.totalsQuote,
      position: 50,
      description: 'Straight through PostgREST',
      quantity: 1,
      unit_price_minor: 500000,
    });
    check(
      directLine.status >= 400,
      'not even straight through PostgREST, which no service check would cover',
      `status ${directLine.status}`,
    );
  }

  // ── 7. sending waits for the owner ──────────────────────────────────────
  console.log('\n7. Nothing reaches the client before the owner says so');
  {
    const early = one(
      await rest('POST', 'sales', 'rpc/send_proposal', { p_proposal_id: created.totalsQuote }),
    );
    check(
      early?.outcome === 'not_approved' && early?.status === 'pending_approval',
      'a quotation awaiting approval cannot be sent',
      `outcome ${early?.outcome}`,
    );

    // The owner refuses: back to draft, and the settled request is let go.
    const rejected = one(
      await call(owner, 'POST', 'approvals', 'rpc/decide_approval', {
        p_request_id: created.request,
        p_decision: 'rejected',
        p_note: 'Too cheap.',
      }),
    );
    check(rejected?.outcome === 'decided', 'the owner can refuse it', `outcome ${rejected?.outcome}`);

    const synced = await rest('POST', 'sales', 'rpc/sync_proposal_decision', {
      p_proposal_id: created.totalsQuote,
    });
    check(
      String(synced.json) === 'draft',
      'a refusal returns it to draft, which is where a revision is made',
      `${JSON.stringify(synced.json)}`,
    );

    const cleared = one(
      await rest('GET', 'sales', `proposals?id=eq.${created.totalsQuote}&select=approval_request_id`),
    );
    check(
      cleared?.approval_request_id === null,
      'and the settled request is let go, so it cannot report a pending approval',
    );

    // Now the whole way through, on the same version.
    const resubmitted = one(
      await rest('POST', 'sales', 'rpc/submit_proposal', {
        p_proposal_id: created.totalsQuote,
        p_requested_by: ownerId,
      }),
    );
    check(resubmitted?.outcome === 'submitted', 'it can be submitted again');
    created.request2 = resubmitted?.request_id;

    await call(owner, 'POST', 'approvals', 'rpc/decide_approval', {
      p_request_id: created.request2,
      p_decision: 'approved',
    });
    const approved = await rest('POST', 'sales', 'rpc/sync_proposal_decision', {
      p_proposal_id: created.totalsQuote,
    });
    check(String(approved.json) === 'approved', 'and approval lands on the quotation');

    const sent = one(
      await rest('POST', 'sales', 'rpc/send_proposal', {
        p_proposal_id: created.totalsQuote,
        p_message_ref: 'wamid.QUOTE-V1',
      }),
    );
    check(sent?.outcome === 'sent', 'an approved quotation sends', `outcome ${sent?.outcome}`);

    const row = one(
      await rest('GET', 'sales', `proposals?id=eq.${created.totalsQuote}&select=sent_at,sent_message_ref`),
    );
    check(
      row?.sent_at !== null && row?.sent_message_ref === 'wamid.QUOTE-V1',
      'recording when it went and what carried it (§18)',
    );
  }

  // ── 8. delivery is not acceptance ───────────────────────────────────────
  console.log('\n8. Delivering a quotation is not the client accepting it');
  {
    const status = await statusOf(created.totalsQuote);
    check(status === 'sent', 'a delivered quotation is `sent`, not `accepted`', status);

    const accepted = one(
      await rest('POST', 'sales', 'rpc/record_proposal_response', {
        p_proposal_id: created.totalsQuote,
        p_response: 'accepted',
        p_note: 'Said yes on WhatsApp.',
      }),
    );
    check(accepted?.outcome === 'recorded', 'acceptance is its own act', `outcome ${accepted?.outcome}`);
    check((await statusOf(created.totalsQuote)) === 'accepted', 'and only then is it accepted');

    // §22 puts payment between acceptance and WON, so this deliberately does
    // not move the deal.
    const deal = one(
      await rest('GET', 'sales', `opportunities?id=eq.${created.totalsDeal}&select=stage`),
    );
    check(
      deal?.stage === 'discovery',
      'a quotation accepted does not win the deal — §22 puts payment in between',
      `stage ${deal?.stage}`,
    );

    // ── 9. settled is settled ─────────────────────────────────────────────
    const again = one(
      await rest('POST', 'sales', 'rpc/record_proposal_response', {
        p_proposal_id: created.totalsQuote,
        p_response: 'rejected',
      }),
    );
    check(
      again?.outcome === 'not_answerable',
      'an answered quotation cannot be answered twice',
      `outcome ${again?.outcome}`,
    );

    const forced = await rest('PATCH', 'sales', `proposals?id=eq.${created.totalsQuote}`, {
      status: 'draft',
    });
    check(forced.status >= 400, 'and it cannot be dragged back to draft', `status ${forced.status}`);

    // A proposal is superseded/rejected/lapsed through its status, never
    // deleted (20260815370000): the guard freezes its state on INSERT/UPDATE,
    // but `proposals_write` is the ALL policy and DELETE was left open — an
    // authenticated end-user could erase the quotation and its history. The
    // BEFORE DELETE guard refuses an end-user's DELETE; the service-role
    // cleanup in `finally` (identity-less) is exempt.
    const del = await call(owner, 'DELETE', 'sales', `proposals?id=eq.${created.totalsQuote}`);
    check(
      del.status >= 400,
      'an authenticated end-user cannot DELETE a quotation — it is superseded, not erased',
      `status ${del.status}, ${del.text.slice(0, 120)}`,
    );
    check(
      (await statusOf(created.totalsQuote)) === 'accepted',
      'and the quotation row survives the refused delete',
    );
  }

  // ── 8b. an unsent quotation cannot be accepted ──────────────────────────
  console.log('\n9. Only a quotation that was actually sent can be answered');
  {
    const deal = await newDeal('unsent');
    const quote = one(await draft(deal, 'Never sent'));
    await addLine(quote.proposal_id, 'Work', 1, 100000);

    const early = one(
      await rest('POST', 'sales', 'rpc/record_proposal_response', {
        p_proposal_id: quote.proposal_id,
        p_response: 'accepted',
      }),
    );
    check(
      early?.outcome === 'not_answerable' && early?.status === 'draft',
      'a draft cannot be accepted on the client’s behalf',
      `outcome ${early?.outcome}`,
    );
  }

  // ── 8c. the validity date ───────────────────────────────────────────────
  console.log('\n10. A lapsed quotation cannot be accepted, but can be refused');
  {
    const deal = await newDeal('lapsed');
    const quote = one(
      await draft(deal, 'Expired offer', { p_valid_until: '2020-01-01' }),
    );
    await addLine(quote.proposal_id, 'Work', 1, 100000);
    const submitted = one(
      await rest('POST', 'sales', 'rpc/submit_proposal', {
        p_proposal_id: quote.proposal_id,
        p_requested_by: ownerId,
      }),
    );
    await call(owner, 'POST', 'approvals', 'rpc/decide_approval', {
      p_request_id: submitted.request_id,
      p_decision: 'approved',
    });
    await rest('POST', 'sales', 'rpc/sync_proposal_decision', { p_proposal_id: quote.proposal_id });
    await rest('POST', 'sales', 'rpc/send_proposal', { p_proposal_id: quote.proposal_id });

    const expired = one(
      await rest('POST', 'sales', 'rpc/record_proposal_response', {
        p_proposal_id: quote.proposal_id,
        p_response: 'accepted',
      }),
    );
    check(
      expired?.outcome === 'expired',
      'accepting a quotation past its validity date is refused (§15)',
      `outcome ${expired?.outcome}`,
    );

    const refused = one(
      await rest('POST', 'sales', 'rpc/record_proposal_response', {
        p_proposal_id: quote.proposal_id,
        p_response: 'rejected',
      }),
    );
    check(
      refused?.outcome === 'recorded',
      'but it can still be recorded as refused, which is what actually happened',
      `outcome ${refused?.outcome}`,
    );
  }

  // ── 8d. the lapse becomes a state of its own ────────────────────────────
  //
  // G-111, decisions ADM-71 and ADM-77/78/79. Before this the row still read
  // `sent`, so a queue of outstanding quotations counted a cold offer forever.
  console.log('\n10b. A quotation that went cold says so');
  {
    const setup = async (name, validUntil) => {
      const deal = await newDeal(name);
      const q = one(await draft(deal, `Offer ${name}`, { p_valid_until: validUntil }));
      await addLine(q.proposal_id, 'Work', 1, 100000);
      const sub = one(await rest('POST', 'sales', 'rpc/submit_proposal', {
        p_proposal_id: q.proposal_id, p_requested_by: ownerId,
      }));
      await call(owner, 'POST', 'approvals', 'rpc/decide_approval', {
        p_request_id: sub.request_id, p_decision: 'approved',
      });
      await rest('POST', 'sales', 'rpc/sync_proposal_decision', { p_proposal_id: q.proposal_id });
      await rest('POST', 'sales', 'rpc/send_proposal', { p_proposal_id: q.proposal_id });
      return { deal, id: q.proposal_id };
    };

    const cold = await setup('cold', '2020-01-01');
    const future = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    const warm = await setup('warm', future);

    const swept = await rest('POST', 'sales', 'rpc/lapse_overdue_proposals', { p_limit: 50 });
    const ids = (Array.isArray(swept.json) ? swept.json : []).map((r) => r.lapsed_id);
    check(ids.includes(cold.id), 'the sweep lapses a quotation past its date', `${ids.length} lapsed`);
    check(!ids.includes(warm.id), 'and leaves one still inside its validity alone');

    const after = one(await rest('GET', 'sales', `proposals?id=eq.${cold.id}&select=status`));
    check(after?.status === 'lapsed', 'the row says lapsed rather than still saying sent', after?.status);

    const warmRow = one(await rest('GET', 'sales', `proposals?id=eq.${warm.id}&select=status`));
    check(warmRow?.status === 'sent', 'the warm one is untouched', warmRow?.status);

    // ADM-77, and the check most worth having here. The `not_sent` guard ran
    // before the validity check, so persisting the lapse would have removed a
    // client's ability to decline as a silent side effect.
    const declined = one(await rest('POST', 'sales', 'rpc/record_proposal_response', {
      p_proposal_id: cold.id, p_response: 'rejected',
    }));
    check(
      declined?.outcome === 'recorded',
      'a LAPSED quotation can still be declined — ADM-77, and the reason this is not a silent change',
      `outcome ${declined?.outcome}`,
    );

    const cold2 = await setup('cold-again', '2020-01-01');
    await rest('POST', 'sales', 'rpc/lapse_overdue_proposals', { p_limit: 50 });
    const accepted = one(await rest('POST', 'sales', 'rpc/record_proposal_response', {
      p_proposal_id: cold2.id, p_response: 'accepted',
    }));
    check(
      accepted?.outcome === 'expired',
      'but it still cannot be accepted, which is what a validity period means',
      `outcome ${accepted?.outcome}`,
    );

    // Idempotence: a tick every minute must not re-lapse or re-emit.
    const again = await rest('POST', 'sales', 'rpc/lapse_overdue_proposals', { p_limit: 50 });
    const againIds = (Array.isArray(again.json) ? again.json : []).map((r) => r.lapsed_id);
    check(
      !againIds.includes(cold.id) && !againIds.includes(cold2.id),
      'and a second sweep lapses nothing twice — the tick runs every minute',
      `${againIds.length} lapsed`,
    );

    // ADM-78 / the live set. `lapsed` is not "on its way to an answer", so the
    // deal is free for a new quotation without superseding anything.
    const next = await draft(cold2.deal, 'Replacement offer');
    check(
      next.status < 400,
      'a lapsed quotation frees the deal for a new one, without superseding',
      `status ${next.status}`,
    );
  }

  // ── 3b. superseding cancels the question ────────────────────────────────
  console.log('\n11. Superseding a version takes its pending question with it');
  {
    const deal = await newDeal('supersede');
    const v1 = one(await draft(deal, 'First offer'));
    await addLine(v1.proposal_id, 'Work', 1, 200000);
    const submitted = one(
      await rest('POST', 'sales', 'rpc/submit_proposal', {
        p_proposal_id: v1.proposal_id,
        p_requested_by: ownerId,
      }),
    );
    check(submitted?.outcome === 'submitted', 'v1 is waiting on the owner');

    const v2 = one(await draft(deal, 'Revised offer'));
    check(
      v2?.outcome === 'created' && v2?.version === 2 && v2?.superseded === v1.proposal_id,
      'drafting v2 supersedes v1',
      `superseded ${v2?.superseded}`,
    );

    const request = one(
      await rest('GET', 'approvals', `approval_requests?id=eq.${submitted.request_id}&select=state,decision_note`),
    );
    check(
      request?.state === 'cancelled',
      'and v1’s pending approval is cancelled, not left rotting in the queue',
      `state ${request?.state}`,
    );
    check(
      typeof request?.decision_note === 'string' && request.decision_note.includes('v2'),
      'saying why it was withdrawn',
      `${request?.decision_note}`,
    );

    // A cancelled request is not an approved one.
    const send = one(
      await rest('POST', 'sales', 'rpc/send_proposal', { p_proposal_id: v1.proposal_id }),
    );
    check(
      send?.outcome === 'not_approved' && send?.status === 'superseded',
      'a superseded version can never be sent',
      `outcome ${send?.outcome}/${send?.status}`,
    );
  }

  // ── the audit trail ─────────────────────────────────────────────────────
  console.log('\n12. The history is written by the database');
  {
    const log = (
      await rest(
        'GET',
        'audit',
        `audit_log?subject_type=eq.proposal&subject_id=eq.${created.totalsQuote}&select=action&order=created_at.asc`,
      )
    ).json;
    const actions = (log ?? []).map((r) => r.action);

    check(
      actions.includes('proposal.drafted'),
      'drafting is recorded',
      actions.join(', ').slice(0, 160),
    );
    check(
      actions.includes('proposal.pending_approval') && actions.includes('proposal.approved'),
      'and so is every state it moved through',
    );
    check(actions.includes('proposal.sent') && actions.includes('proposal.accepted'), 'to the end');
    check(
      actions.includes('proposal.repriced'),
      'including the reprice, which changes money without changing status',
    );
  }

  // ── a deal that is settled takes no new quotations ──────────────────────
  console.log('\n13. A settled deal takes no new quotations');
  {
    const deal = await newDeal('settled');
    await rest('PATCH', 'sales', `opportunities?id=eq.${deal}`, {
      stage: 'lost',
      closed_at: new Date().toISOString(),
      lost_reason: 'Went elsewhere.',
      // Doc 09 §38 - a lost deal records both the words and the category §37
      // counts, and `opportunities_lost_says_why` holds it at the row.
      lost_category: 'chose_competitor',
    });

    const refused = one(await draft(deal, 'Too late'));
    check(
      refused?.outcome === 'settled',
      'drafting against a lost deal is refused',
      `outcome ${refused?.outcome}`,
    );
  }

  // ── 4b. the status graph is held in the database, not just the engine ────
  //
  // proposals_write RLS is core.is_admin() (owner OR ops_admin) and INSERT and
  // UPDATE are granted to authenticated, so before proposals_guard learned the
  // transition graph an ops_admin could PATCH the row straight over the Data
  // API — past ADM-07's owner sign-off (draft → sent with approval_request_id
  // NULL, a send the engine makes impossible because the money floor pins the
  // proposal approver to the owner), and past the client (draft → accepted, a
  // fabricated acceptance whose total convertToProject reads back as the
  // project budget). The guard refuses each, and the row does not move.
  console.log('\n14. The status graph is held in the database, not just the engine');
  {
    const deal = await newDeal('forge');
    const q = one(await draft(deal, 'Forge target'));
    await addLine(q.proposal_id, 'Work', 1, 500000);

    const toSent = await rest('PATCH', 'sales', `proposals?id=eq.${q.proposal_id}`, { status: 'sent' });
    const afterSent = await statusOf(q.proposal_id);
    check(
      toSent.status >= 400 && afterSent === 'draft',
      'a draft cannot be PATCHed straight to sent — ADM-07 is not skippable by hand',
      `status ${toSent.status}, row ${afterSent}`,
    );

    const toAccepted = await rest('PATCH', 'sales', `proposals?id=eq.${q.proposal_id}`, { status: 'accepted' });
    const afterAccepted = await statusOf(q.proposal_id);
    check(
      toAccepted.status >= 400 && afterAccepted === 'draft',
      'nor can a draft be marked accepted — a client acceptance cannot be forged',
      `status ${toAccepted.status}, row ${afterAccepted}`,
    );

    // ADM-78: a lapsed quote is out of its validity window, and no direct write
    // brings it back to an acceptance the engine (record_proposal_response)
    // refuses as expired.
    const deal2 = await newDeal('forge-lapsed');
    const q2 = one(await draft(deal2, 'Lapse target', { p_valid_until: '2020-01-01' }));
    await addLine(q2.proposal_id, 'Work', 1, 500000);
    const sub = one(
      await rest('POST', 'sales', 'rpc/submit_proposal', {
        p_proposal_id: q2.proposal_id,
        p_requested_by: ownerId,
      }),
    );
    await call(owner, 'POST', 'approvals', 'rpc/decide_approval', {
      p_request_id: sub.request_id,
      p_decision: 'approved',
    });
    await rest('POST', 'sales', 'rpc/sync_proposal_decision', { p_proposal_id: q2.proposal_id });
    await rest('POST', 'sales', 'rpc/send_proposal', { p_proposal_id: q2.proposal_id });
    await rest('POST', 'sales', 'rpc/lapse_overdue_proposals', { p_limit: 50 });
    check((await statusOf(q2.proposal_id)) === 'lapsed', 'a sent quote past its date lapses');

    const lapsedToAccepted = await rest('PATCH', 'sales', `proposals?id=eq.${q2.proposal_id}`, {
      status: 'accepted',
    });
    const afterLapsed = await statusOf(q2.proposal_id);
    check(
      lapsedToAccepted.status >= 400 && afterLapsed === 'lapsed',
      'and a lapsed quote cannot be PATCHed to accepted — a validity period means something (ADM-78)',
      `status ${lapsedToAccepted.status}, row ${afterLapsed}`,
    );
  }
} finally {
  // Submitting a quotation raises an INTERNAL-audience approval, and G-110
  // made that emit `approval.requested`. The deletes below clear events keyed
  // to the *proposal*; an announcement is keyed to the **request**, so it
  // survives them. `verify-milestone-unlock` asserts the deployment holds zero
  // outbox events, and four of these were what CI failed on.
  await rest('DELETE', 'core', 'outbox_events?subject_type=eq.approval_request');

  for (const id of created.opportunities) {
    const quotes = (await rest('GET', 'sales', `proposals?opportunity_id=eq.${id}&select=id`)).json ?? [];
    for (const q of quotes) {
      await rest('DELETE', 'core', `outbox_events?subject_id=eq.${q.id}`);
      await rest('DELETE', 'sales', `proposal_items?proposal_id=eq.${q.id}`);
    }
    await rest('DELETE', 'sales', `proposals?opportunity_id=eq.${id}`);
    await rest('DELETE', 'sales', `opportunities?id=eq.${id}`);
  }
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);

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
  console.log('\x1b[32m✔ Staff draft, the owner approves, then it is sent\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
