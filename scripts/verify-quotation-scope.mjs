/**
 * The scope AND the price are the agent's; the decision is not — ADM-96, G-162.
 *
 * Document 09 §15's "quote generation is assisted by AI" grew to its full
 * size on the owner's grant ("agent sab kuch kre mai bs pdf approve changes
 * karo"): accepted requirements become a PRICED draft, submitted into the
 * approval queue, and the owner's two verbs are approve and changes. What
 * this script holds is the drafting half of that loop, live:
 *
 *   A. accepting requirements asks the agent for a scope
 *   B. it writes the lines PRICED — rupees ×100, arithmetic checked
 *   C. and says who drafted it, which nothing has ever recorded
 *   D. the submission is part of the same job, and the request names 'system'
 *   E. what a submission freezes, no caller can reprice
 *   F. requirements nobody accepted are not quoted from
 *   G. a lead with no open deal is GIVEN one — G-088's index still referees
 *   H. the same requirements are not quoted twice
 *
 *   node scripts/verify-quotation-scope.mjs
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: true, anon: false });
await announceTarget(target, 'the scope and the price are the agent’s; the decision is not');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const APP = target.appUrl ?? 'http://localhost:3000';
const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-quote-${randomUUID().slice(0, 8)}`;
const MODEL_PORT = 54399;

/**
 * G-179 — the agency's own cost rates, set for this run and cleared after.
 *
 * ₹8,000 a build-day plus ₹2,000 of AI and tooling, with the owner's stated
 * ×2 / ×2.5 / ×3. The stub estimates 13 days, so the work costs ₹1,30,000 to
 * produce while the draft asks ₹87,000 for it — deliberately BELOW cost,
 * which is the one case this whole model exists to surface and the one the
 * corpus formula cannot see, because the corpus records what this agency
 * CHARGED and not what it cost.
 */
const PRICING = [
  ['pricing_day_rate_rupees', '8000'],
  ['pricing_ai_day_rate_rupees', '2000'],
  ['pricing_multiplier_min', '2'],
  ['pricing_multiplier_target', '2.5'],
  ['pricing_multiplier_max', '3'],
];

let failures = 0;
let checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return t; } };

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema, Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: parse(text), text };
}
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

const tick = () =>
  fetch(`${APP}/api/jobs/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.cronSecret}` },
    cache: 'no-store',
  }).then(async (r) => ({ status: r.status, json: parse(await r.text()) }));

async function tickUntil(predicate, budget = 40) {
  for (let i = 0; i < budget; i += 1) {
    const seen = await predicate();
    if (seen) return seen;
    await tick();
  }
  return predicate();
}

// ── the model ──────────────────────────────────────────────────────────────

/**
 * What the stub answers for a scope — PRICED, since ADM-96.
 *
 * Whole rupees, the unit the schema takes; the workflow multiplies by 100 at
 * the write, and B asserts the arithmetic landed. One line at zero on
 * purpose: the corpus prices genuinely-included work at +₹0, and the schema
 * permits it as long as the quotation is not zero THROUGHOUT.
 */
const SCOPE = {
  title: 'Delivery app — customer, driver and admin',
  understanding:
    'A hungry customer browses restaurants, orders and pays online, and tracks the delivery; ' +
    'a driver accepts and delivers; the admin team oversees orders and payouts.',
  items: [
    { description: 'Customer app: signup, browse restaurants, order, track delivery', priceRupees: 40000,
      kind: 'surface',
      features: ['OTP signup and login', 'Restaurant list and search', 'Cart and checkout', 'Live order status'],
      serves: ['Customer'], effortDays: 5 },
    { description: 'Driver app: registration, accept jobs, navigation, mark delivered', priceRupees: 25000,
      kind: 'surface',
      features: ['Driver registration', 'Accept or reject jobs', 'Navigation handoff', 'Mark delivered'],
      serves: ['Driver'], effortDays: 4 },
    { description: 'Admin panel: restaurants, drivers, orders, payouts', priceRupees: 22000,
      kind: 'surface',
      features: ['Order monitor', 'Restaurant records', 'Driver records', 'Payout ledger'],
      serves: ['Admin'], effortDays: 3 },
    { description: 'iOS build via the same Flutter codebase', priceRupees: 0,
      kind: 'foundation',
      features: ['Same codebase build', 'Client-submittable iOS package'], effortDays: 1 },
  ],
  summary:
    'Covers the three apps as discussed. Does not cover marketing, ' +
    'content, or the restaurant-side app, which were not part of the requirements.',
  exclusions: ['Restaurant-side app — not part of these requirements', 'Marketing and content work'],
  assumptions: ['Single city at launch'],
  clientResponsibilities: ['Hosting and server charges', 'Payment gateway account and KYC'],
  // G-173: the fields the prompt now names. Before it did, the model wrote
  // none of them and seven features were dead in production while looking
  // shipped — so the stub exercises every one, and section I asserts they
  // survive the round trip into the row.
  dependencies: ['Payment gateway account approved before checkout can be tested end to end'],
  acceptanceCriteria: ['A customer orders and pays, a driver delivers, and the admin sees the payout on staging'],
  optionalAddons: [{ label: 'Restaurant-side app', priceRupees: 45000 }],
  industryTheme: 'logistics',
  regulatedCategory: null,
  depth: 'standard',
  // G-177. Deliberately OUTSIDE the band the price implies, so this run also
  // proves the approver is told about it. The corpus band for this total is
  // wider and later; 4–5 weeks is a promise somebody has to keep.
  timelineWeeks: { min: 4, max: 5 },
  // G-178 — who uses it, and what it stands on. The client-paid gateway is
  // deliberately in here: whose bill it is is the dispute that shows up at
  // go-live rather than at signature.
  roles: [
    { name: 'Customer', whatTheyDo: 'Orders food, pays, and follows the delivery.' },
    { name: 'Driver', whatTheyDo: 'Accepts jobs, navigates, and marks a delivery done.' },
    { name: 'Admin', whatTheyDo: 'Approves restaurants, sets commission and handles refunds.' },
  ],
  integrations: [
    { name: 'Razorpay', purpose: 'Taking card and UPI payments at checkout.', whoPays: 'client',
      charge: '2% per transaction on the client’s own account.' },
    { name: 'Google Maps', purpose: 'Driver navigation and delivery tracking.', whoPays: 'client' },
    { name: 'Firebase push', purpose: 'Order status on the phone.', whoPays: 'included' },
  ],
  phase: { number: 1, of: 2, deferredTo: [{ item: 'Restaurant-side ordering app', phase: 2 }] },
};
const SCOPE_TOTAL_MINOR = SCOPE.items.reduce((sum, i) => sum + i.priceRupees * 100, 0);

let modelCalls = 0;
const model = createServer((req, res) => {
  modelCalls += 1;
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const asks = (prop) => body.includes(`"${prop}"`);
    const payload = asks('items') && asks('summary')
      ? SCOPE
      : { summary: 'x', scopeItems: [], constraints: [], openQuestions: [] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_stub', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      usage: { input_tokens: 40, output_tokens: 30 },
    }));
  });
});

await new Promise((resolve, reject) => {
  model.once('error', reject);
  model.listen(MODEL_PORT, '127.0.0.1', resolve);
}).catch((e) => fail(`could not bind the model stub on ${MODEL_PORT}: ${e.message}`));

console.log('\n\x1b[1mAgencyOS — the scope and the price are the agent’s; the decision is not\x1b[0m');

const made = { leads: [], contacts: [], conversations: [], opportunities: [], policies: [] };

async function plantLead(title) {
  const contact = one(await rest('POST', 'crm', 'contacts', {
    organization_id: ORG, full_name: `${MARKER} ${title}`,
    phone: `+9199${String(Date.now()).slice(-8)}${made.contacts.length}`,
  }));
  made.contacts.push(contact.id);
  const lead = one(await rest('POST', 'crm', 'leads', {
    organization_id: ORG, contact_id: contact.id, title: `${MARKER} ${title}`,
    source: 'whatsapp', source_ref: `${MARKER}:${title}:${randomUUID().slice(0, 6)}`, status: 'new',
  }));
  made.leads.push(lead.id);
  const conv = one(await rest('POST', 'crm', 'conversations', {
    organization_id: ORG, lead_id: lead.id, contact_id: contact.id,
    channel: 'whatsapp', external_ref: `${MARKER}:conv:${randomUUID().slice(0, 8)}`, status: 'active',
  }));
  made.conversations.push(conv.id);
  return { lead, conv, contact };
}

/**
 * Inserted proposed, then accepted — because acceptance is a TRANSITION.
 *
 * `crm.emit_requirement_accepted` fires `after update of status`, so a row
 * inserted already-accepted emits nothing. That is right: a version born
 * accepted was never decided by anybody. The first draft of this script
 * planted one and then reported that the agent had not drafted a quotation,
 * which was a fact about the harness.
 */
const acceptVersion = async (conv) => {
  const created = one(await rest('POST', 'crm', 'requirement_versions', {
    organization_id: ORG, conversation_id: conv.id, version: 1, source: 'agent',
    status: 'proposed',
    payload: {
      summary: 'A food delivery app with customer, driver and admin sides.',
      scopeItems: [
        { title: 'Customer ordering', detail: 'Browse, order, pay, track' },
        { title: 'Driver app', detail: 'Accept jobs and navigate' },
        { title: 'Admin panel', detail: 'Restaurants, drivers, payouts' },
      ],
      constraints: [], openQuestions: [],
    },
  }));
  // Status alone. `crm.requirement_versions` has no decided_at — the decision
  // lives in the status and in the audit row, and the guard above permits
  // exactly this one column to move.
  return one(await rest('PATCH', 'crm', `requirement_versions?id=eq.${created.id}`, {
    status: 'accepted',
  }));
};

try {
  // G-179 — the cost model's inputs, through the audited setter the owner's
  // own settings form uses. Cleared in the `finally`, so the demo tenant is
  // left exactly as it was found.
  for (const [key, value] of PRICING) {
    await rest('POST', 'core', 'rpc/set_organization_setting', {
      p_organization_id: ORG, p_key: key, p_value: value,
    });
  }

  // The submission half needs an approver to name. Without a policy the job
  // still succeeds — the draft stands and the reason says a person is needed —
  // but this script proves the FULL loop, so it plants the owner rung the
  // production deployment carries (proposal / ₹0 / owner).
  const policy = one(await rest('POST', 'approvals', 'approval_policies', {
    organization_id: ORG, subject_type: 'proposal', min_amount_minor: 0,
    required_role: 'owner', sla_hours: 24, active: true, note: `${MARKER} rung`,
  }));
  made.policies.push(policy.id);

  // ── A, B, C, D ───────────────────────────────────────────────────────────
  console.log('\nA–D. Accepted requirements become a priced draft, submitted, with a name on it');
  const deal = await plantLead('quoted');
  const opp = one(await rest('POST', 'sales', 'opportunities', {
    organization_id: ORG, lead_id: deal.lead.id, name: `${MARKER} deal`, stage: 'discovery',
  }));
  made.opportunities.push(opp.id);

  const version = await acceptVersion(deal.conv);
  check(Boolean(version?.id), 'an accepted requirement version exists', version?.status);

  const proposal = await tickUntil(async () => {
    const row = one(await rest('GET', 'sales',
      `proposals?requirement_version_id=eq.${version.id}&select=id,version,status,title,body,generated_by_run_id,total_minor,valid_until,approval_request_id`));
    return row?.status === 'pending_approval' ? row : null;
  });
  check(Boolean(proposal?.id), 'the agent drafted a quotation from them', proposal ? `v${proposal.version}` : 'none');
  check(
    proposal?.status === 'pending_approval',
    'and SUBMITTED it in the same job — the owner decides, nobody hunts for a draft (ADM-96)',
    String(proposal?.status),
  );
  check(
    typeof proposal?.title === 'string' && proposal.title.length > 3,
    'with a title a person would recognise the deal by',
    String(proposal?.title).slice(0, 50),
  );
  check(
    typeof proposal?.body === 'string' && /does not cover/i.test(proposal.body),
    'and a summary that names what it does NOT cover',
  );

  const items = (await rest('GET', 'sales',
    `proposal_items?proposal_id=eq.${proposal.id}&select=description,unit_price_minor,amount_minor&order=position`)).json ?? [];
  check(items.length === SCOPE.items.length, 'every line of the scope is written', `${items.length} line(s)`);
  check(
    items.every((line, i) => line.unit_price_minor === SCOPE.items[i].priceRupees * 100),
    'each PRICED — the model’s whole rupees became minor units exactly once (×100)',
    items.map((i) => i.unit_price_minor).join(','),
  );
  check(
    items.some((line) => line.unit_price_minor === 0),
    'a genuinely-included ₹0 line survives beside the priced ones',
  );
  check(
    proposal?.total_minor === SCOPE_TOTAL_MINOR,
    'and the total is the arithmetic of the lines, not anybody’s claim',
    `${proposal?.total_minor} vs ${SCOPE_TOTAL_MINOR}`,
  );
  {
    const days = proposal?.valid_until
      ? Math.round((new Date(proposal.valid_until).getTime() - Date.now()) / 86_400_000)
      : null;
    check(
      days !== null && days >= 13 && days <= 15,
      'valid for ~15 days — the corpus modal, stamped by code rather than asked of the model',
      `${proposal?.valid_until} (${days} day(s) out)`,
    );
  }
  check(
    Boolean(proposal?.generated_by_run_id),
    'and it says which agent run drafted it — the column existed for years and nothing wrote it',
    proposal?.generated_by_run_id ? 'stamped' : 'null',
  );

  // G-165: the document around the lines, on the row and frozen with it.
  const storedDoc = one(await rest('GET', 'sales',
    `proposals?id=eq.${proposal.id}&select=document`))?.document;
  check(
    typeof storedDoc?.understanding === 'string' && storedDoc.understanding.length > 20,
    'the document rides the row: the understanding is recorded',
    (storedDoc?.understanding ?? '(none)').slice(0, 50),
  );
  const featureRows = (await rest('GET', 'sales',
    `proposal_items?proposal_id=eq.${proposal.id}&select=features&order=position`)).json ?? [];
  check(
    featureRows.length === items.length &&
      featureRows.every((r) => Array.isArray(r.features) && r.features.length >= 2),
    'and every LINE carries its own bullet-level features — on the row, never positional (review fix)',
    `${featureRows.filter((r) => Array.isArray(r.features)).length}/${items.length} line(s) with bullets`,
  );
  check(
    Array.isArray(storedDoc?.exclusions) && storedDoc.exclusions.length > 0,
    'with the exclusions the model actually named',
  );

  // ── G-173: the fields that were dead until the prompt named them ──────────
  //
  // Proved empirically before it was fixed: a drafted document carried every
  // G-165 field and NONE of these, because the prompt listed only (a)-(e).
  // Seven features looked shipped and never fired. These checks are the ones
  // that would have caught it, so they exist now.
  check(
    Array.isArray(storedDoc?.dependencies) && storedDoc.dependencies.length > 0,
    'the dependencies the model named reach the row',
    (storedDoc?.dependencies ?? ['(none)'])[0]?.slice(0, 46),
  );
  check(
    Array.isArray(storedDoc?.acceptanceCriteria) && storedDoc.acceptanceCriteria.length > 0,
    'and the acceptance criteria — the sentence that settles "is it done?"',
  );
  check(
    Array.isArray(storedDoc?.optionalAddons) &&
      storedDoc.optionalAddons.length > 0 &&
      typeof storedDoc.optionalAddons[0]?.priceRupees === 'number',
    'and an optional add-on carrying ONE price, outside the total',
    `${storedDoc?.optionalAddons?.[0]?.label ?? '(none)'} @ ${storedDoc?.optionalAddons?.[0]?.priceRupees ?? '-'}`,
  );
  check(
    storedDoc?.industryTheme === 'logistics' && storedDoc?.depth === 'standard',
    'the industry theme and the STATED depth are recorded, not inferred',
    `${storedDoc?.industryTheme ?? '(none)'}/${storedDoc?.depth ?? '(none)'}`,
  );
  check(
    storedDoc?.phase?.number === 1 &&
      storedDoc?.phase?.of === 2 &&
      storedDoc?.phase?.deferredTo?.[0]?.phase === 2,
    'the phase and its deferral survive — an exclusion says never, a deferral says which phase',
    `phase ${storedDoc?.phase?.number ?? '-'} of ${storedDoc?.phase?.of ?? '-'}`,
  );
  // ── G-179: what the work costs to make, frozen beside the price ──────────
  check(
    storedDoc?.productionCost?.days === 13 && storedDoc?.productionCost?.costRupees === 130000,
    'the production cost is frozen onto the quotation, from the model’s own day estimates',
    `${storedDoc?.productionCost?.days ?? '-'} days · ₹${storedDoc?.productionCost?.costRupees ?? '-'}`,
  );
  check(
    storedDoc?.productionCost?.minimumRupees === 260000 &&
      storedDoc?.productionCost?.recommendedRupees === 325000 &&
      storedDoc?.productionCost?.premiumRupees === 390000,
    'with the owner’s own ×2 / ×2.5 / ×3 bands above it',
    `${storedDoc?.productionCost?.minimumRupees} / ${storedDoc?.productionCost?.recommendedRupees} / ${storedDoc?.productionCost?.premiumRupees}`,
  );
  check(
    Array.isArray(storedDoc?.productionCost?.basis) && storedDoc.productionCost.basis.length === 3,
    'and the derivation, so the owner can see where the figure came from',
    (storedDoc?.productionCost?.basis ?? [])[1] ?? '(none)',
  );

  // ── G-178: who uses it, what it stands on, and who each line is for ──────
  check(
    Array.isArray(storedDoc?.roles) && storedDoc.roles.length === 3 &&
      storedDoc.roles.every((r) => typeof r?.name === 'string' && typeof r?.whatTheyDo === 'string'),
    'the roles the model named reach the row, each with what they can do',
    (storedDoc?.roles ?? []).map((r) => r?.name).join(', ') || '(none)',
  );
  check(
    Array.isArray(storedDoc?.integrations) && storedDoc.integrations.length === 3,
    'and the third-party services it stands on',
    (storedDoc?.integrations ?? []).map((i) => `${i?.name}:${i?.whoPays}`).join(' · ') || '(none)',
  );
  check(
    (storedDoc?.integrations ?? []).some((i) => i?.whoPays === 'client' && typeof i?.charge === 'string') &&
      (storedDoc?.integrations ?? []).some((i) => i?.whoPays === 'included'),
    'with whose bill each one is — the dispute that shows up at go-live',
  );
  // The audience is a property of the LINE, so it lives on the item row
  // beside its features rather than in the document.
  const served = (await rest('GET', 'sales',
    `proposal_items?proposal_id=eq.${proposal.id}&select=description,serves&order=position`)).json ?? [];
  check(
    served.filter((r) => Array.isArray(r.serves) && r.serves.length > 0).length === 3,
    'three of the four lines say which role they are for',
    served.map((r) => (r.serves ?? []).join('/') || '-').join(' · '),
  );
  check(
    (served[0]?.serves ?? [])[0] === 'Customer' && (served[1]?.serves ?? [])[0] === 'Driver',
    'and each names the role its own description implies, in order',
  );

  // G-177 — the timeline the model proposed, which used to be a function of
  // the price and the one field of a quotation nobody could change.
  check(
    storedDoc?.timelineWeeks?.min === 4 && storedDoc?.timelineWeeks?.max === 5,
    'the timeline the model proposed reaches the row',
    `${storedDoc?.timelineWeeks?.min ?? '-'}–${storedDoc?.timelineWeeks?.max ?? '-'} weeks`,
  );

  // The reason the kinds matter: three surfaces stated, and the reference the
  // owner sees is counted from THEM rather than from the wording.
  check(
    storedDoc?.pricingReference?.surfaces === 3 && storedDoc?.pricingReference?.depth === 'standard',
    'and the pricing reference counted the STATED surfaces, not the prose',
    `${storedDoc?.pricingReference?.surfaces ?? '-'} surface(s), ref ${storedDoc?.pricingReference?.referenceRupees ?? '-'}`,
  );

  const request = one(await rest('GET', 'approvals',
    `approval_requests?id=eq.${proposal.approval_request_id}&select=requested_by_type,requested_by_id,amount_minor,state,payload`));
  check(request?.state === 'pending', 'the approval request is raised and pending', String(request?.state));
  check(
    request?.requested_by_type === 'system' && request?.requested_by_id === null,
    'and honestly names NOBODY as requester — the system submitted, no person is impersonated',
    `${request?.requested_by_type}/${request?.requested_by_id}`,
  );
  check(
    request?.amount_minor === SCOPE_TOTAL_MINOR,
    'carrying the total the owner will decide',
    String(request?.amount_minor),
  );
  check(
    Array.isArray(request?.payload?.items) && request.payload.items.length === SCOPE.items.length,
    'and the lines ride in the payload — the announcement shows the owner the quotation itself',
  );

  // ── E ────────────────────────────────────────────────────────────────────
  console.log('\nE. What a submission freezes, no caller can reprice');
  // The identity guard on agent drafts is RETIRED by ADM-96 (its rule no
  // longer exists to hold); what stands between this number and a client is
  // the freeze and the decision. The freeze, live:
  const smuggled = await rest('POST', 'sales', 'proposal_items', {
    organization_id: ORG, proposal_id: proposal.id, position: 99,
    description: `${MARKER} smuggled`, quantity: 1, unit_price_minor: 250000, amount_minor: 250000,
  });
  check(!smuggled.ok, 'a submitted version takes no new line, from anybody', `status ${smuggled.status}`);
  check(
    /cannot change|draft version/i.test(smuggled.text),
    'and the refusal says to draft the next version instead',
    String(smuggled.json?.message ?? smuggled.text).slice(0, 70),
  );
  const repriced = await rest('PATCH', 'sales',
    `proposal_items?proposal_id=eq.${proposal.id}&position=eq.0`, { unit_price_minor: 1 });
  check(
    !repriced.ok || (Array.isArray(repriced.json) && repriced.json.length === 0),
    'and no line of it can be repriced under the owner’s nose',
    `status ${repriced.status}`,
  );

  // A quotation a person types is as before — the human door did not narrow.
  const typed = await plantLead('typed');
  const oppC = one(await rest('POST', 'sales', 'opportunities', {
    organization_id: ORG, lead_id: typed.lead.id, name: `${MARKER} deal c`, stage: 'discovery',
  }));
  made.opportunities.push(oppC.id);
  const humanDraftRow = one(await rest('POST', 'sales', 'rpc/draft_proposal', {
    p_opportunity_id: oppC.id, p_title: `${MARKER} typed by a person`,
  }));
  const humanPriced = await rest('POST', 'sales', 'proposal_items', {
    organization_id: ORG, proposal_id: humanDraftRow?.proposal_id, position: 0,
    description: `${MARKER} priced`, quantity: 1, unit_price_minor: 250000, amount_minor: 250000,
  });
  check(
    humanDraftRow?.outcome === 'created' && humanPriced.ok,
    'a person’s own draft is priced as before — nothing a person could do has changed',
    `status ${humanPriced.status}`,
  );

  // ── F ────────────────────────────────────────────────────────────────────
  console.log('\nF. Requirements nobody accepted are not quoted from');
  const unconfirmed = await plantLead('unconfirmed');
  const oppB = one(await rest('POST', 'sales', 'opportunities', {
    organization_id: ORG, lead_id: unconfirmed.lead.id, name: `${MARKER} deal b`, stage: 'discovery',
  }));
  made.opportunities.push(oppB.id);
  const proposedOnly = one(await rest('POST', 'crm', 'requirement_versions', {
    organization_id: ORG, conversation_id: unconfirmed.conv.id, version: 1, source: 'agent',
    status: 'proposed', payload: { summary: 'x', scopeItems: [], constraints: [], openQuestions: [] },
  }));
  for (let i = 0; i < 6; i += 1) await tick();
  const fromProposed = (await rest('GET', 'sales',
    `proposals?requirement_version_id=eq.${proposedOnly.id}&select=id`)).json ?? [];
  check(fromProposed.length === 0, 'a proposed version is the agent’s own reading — quoting from it would be quoting itself', `${fromProposed.length} quote(s)`);

  // ── G ────────────────────────────────────────────────────────────────────
  console.log('\nG. A lead with no open deal is GIVEN one — ADM-96, with G-088 refereeing');
  const dealless = await plantLead('dealless');
  const orphanVersion = await acceptVersion(dealless.conv);
  const opened = await tickUntil(async () => {
    const rows = (await rest('GET', 'sales',
      `opportunities?lead_id=eq.${dealless.lead.id}&select=id,name,stage,value_minor`)).json ?? [];
    return rows.length > 0 ? rows : null;
  });
  check(
    Array.isArray(opened) && opened.length === 1,
    'exactly one deal is opened — the one-open-deal index referees the race',
    `${opened?.length ?? 0} deal(s)`,
  );
  if (opened?.[0]?.id) made.opportunities.push(opened[0].id);
  check(
    opened?.[0]?.name === `${MARKER} dealless`,
    'named with the lead’s own name for itself, never invented (ADM-76)',
    String(opened?.[0]?.name),
  );
  check(
    opened?.[0]?.stage === 'discovery' && opened?.[0]?.value_minor === 0,
    'opened plainly: discovery, worth nothing until the quotation says otherwise',
    `${opened?.[0]?.stage}/${opened?.[0]?.value_minor}`,
  );
  const orphanQuote = await tickUntil(async () =>
    one(await rest('GET', 'sales',
      `proposals?requirement_version_id=eq.${orphanVersion.id}&select=id,status`)));
  check(
    Boolean(orphanQuote?.id),
    'and the quotation is drafted against it — acceptance alone now reaches the owner’s phone',
    String(orphanQuote?.status),
  );

  // ── H ────────────────────────────────────────────────────────────────────
  console.log('\nH. The same requirements are not quoted twice');
  const beforeAgain = (await rest('GET', 'sales',
    `proposals?requirement_version_id=eq.${version.id}&select=id`)).json ?? [];
  await rest('POST', 'core', 'jobs', {
    organization_id: ORG, kind: 'quotation.scope', status: 'queued',
    payload: { subjectId: version.id },
    dedupe_key: `${MARKER}-again-${randomUUID().slice(0, 8)}`,
    run_at: new Date().toISOString(), max_attempts: 5,
  });
  for (let i = 0; i < 8; i += 1) await tick();
  const afterAgain = (await rest('GET', 'sales',
    `proposals?requirement_version_id=eq.${version.id}&select=id`)).json ?? [];
  check(
    afterAgain.length === beforeAgain.length,
    'a second draft would supersede one the owner may already be deciding',
    `${beforeAgain.length} → ${afterAgain.length}`,
  );

  check(modelCalls > 0, 'the model was genuinely called', `${modelCalls} call(s)`);
} finally {
  // G-179 — the rates are the organization's, not this script's. Cleared so
  // the demo tenant is left exactly as it was found.
  for (const [key] of PRICING) {
    await rest('POST', 'core', 'rpc/set_organization_setting', {
      p_organization_id: ORG, p_key: key, p_value: null,
    });
  }
  await rest('DELETE', 'core', 'jobs?kind=eq.quotation.scope');
  // The submissions' approval.requested events became announce jobs during
  // this script's own ticks (settled no_group — no channel is linked here);
  // removed so a later script's job assertions read its own work only.
  await rest('DELETE', 'core', 'jobs?kind=eq.approval.announce');
  // The submissions raised real approval requests and real outbox events;
  // requests refuse DELETE by design, so they are cancelled, and the events
  // are removed the way verify-approvals removes its own — later scripts
  // assert an empty outbox and drive the runner against whatever jobs remain.
  // Every pending request, the way verify-approvals does: the agent-raised
  // summaries carry the STUB's title rather than the marker, so a marker
  // filter would miss exactly the requests this script created — and every
  // other script settles its own before it exits.
  const pending = (await rest('GET', 'approvals',
    `approval_requests?state=eq.pending&select=id`)).json ?? [];
  for (const row of pending) {
    await rest('PATCH', 'approvals', `approval_requests?id=eq.${row.id}`, {
      state: 'cancelled', decided_at: new Date().toISOString(), decision_note: `${MARKER} cleanup`,
    });
  }
  await rest('DELETE', 'core', 'outbox_events?subject_type=eq.approval_request');
  for (const id of made.policies) await rest('DELETE', 'approvals', `approval_policies?id=eq.${id}`);
  for (const id of made.opportunities) await rest('DELETE', 'sales', `opportunities?id=eq.${id}`);
  for (const id of made.conversations) await rest('DELETE', 'crm', `conversations?id=eq.${id}`);
  for (const id of made.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  for (const id of made.contacts) await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
  await new Promise((resolve) => model.close(resolve));
}

console.log(`\n${failures === 0 ? '\x1b[32m✔' : '\x1b[31m✖'} ${checks - failures}/${checks} checks passed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
