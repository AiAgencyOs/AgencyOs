/**
 * The decision is the last human act — ADM-96, G-162.
 *
 * "agent sab kuch kre mai bs pdf approve changes karo": the owner decides in
 * AgencyOS (ADM-74 stands whole), and everything after the decision is the
 * system's. `approvals.decide_approval` emits `approval.decided`; the
 * dispatcher carries an approved quotation to the CLIENT — text and PDF,
 * authored with the approver — and the reviser turns a changes-request note
 * into the next version, priced and resubmitted.
 *
 *   1. approve → the client receives the quotation, and the row is stamped
 *   2. deciding twice, dispatching twice — one send, not two
 *   3. changes + note → the agent drafts v2 from the note and resubmits
 *   4. reject → carried to draft, nothing sent, nothing invented
 *   5. no consent → ADM-70 wins; the quotation stays approved for a person
 *   6. the CLIENT asks for a change → the agent reworks, prices, resubmits (G-163)
 *   7. a PRICE objection never reworks anything — negotiation is a person's (ADM-22)
 *   7b. a feature ask naming no quotation plans nothing
 *   8. the resume guard's three readings, each EXECUTED (review finding)
 *
 *   node scripts/verify-quotation-dispatch.mjs
 */

import { Buffer } from 'node:buffer';
import { randomUUID, createHmac } from 'node:crypto';
import { createServer } from 'node:http';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: true, anon: false, jwt: true });
await announceTarget(target, 'the decision is the last human act');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const APP = target.appUrl ?? 'http://localhost:3000';
const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-dispatch-${randomUUID().slice(0, 8)}`;
const GRAPH_PORT = 54398;
const MODEL_PORT = 54399;

let failures = 0;
let checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return t; } };

async function call(token, method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: token, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema, Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: parse(text), text };
}
const rest = (m, s, p, b) => call(KEY, m, s, p, b);
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

function mint(userId, role, organizationId = ORG) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub: userId,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { organization_id: organizationId, role },
    iat: now,
    exp: now + 900,
  });
  return `${header}.${body}.${createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url')}`;
}

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

// ── the Graph stub: uploads answer the upload shape, sends the send shape ──
const graphSends = [];
const graphUploads = [];
const graph = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url.endsWith('/media')) {
      graphUploads.push({ url: req.url, bytes: body.length });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `MEDIA.STUB.${graphUploads.length}` }));
      return;
    }
    graphSends.push({ url: req.url, body: parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages: [{ id: `wamid.STUB.${graphSends.length}` }] }));
  });
});
await new Promise((resolve, reject) => { graph.once('error', reject); graph.listen(GRAPH_PORT, '127.0.0.1', resolve); })
  .catch((e) => fail(`could not bind the graph stub on ${GRAPH_PORT}: ${e.message}`));

// ── the model stub: answers ONLY the revision — nothing else calls it here ──
const REVISED = {
  title: 'Delivery app — customer, driver and admin (revised)',
  understanding:
    'The client wants the delivery platform with the driver app repriced and onboarding support added, ' +
    'keeping the customer flow exactly as agreed.',
  items: [
    { description: 'Customer app: signup, browse restaurants, order, track delivery', priceRupees: 40000,
      features: ['OTP signup and login', 'Restaurant list and search', 'Cart and checkout', 'Live order status'] },
    { description: 'Driver app: registration, accept jobs, navigation, mark delivered', priceRupees: 20000,
      features: ['Driver registration', 'Accept or reject jobs', 'Mark delivered'] },
    { description: 'Client onboarding and launch support', priceRupees: 5000,
      features: ['Launch-week handholding', 'One training session'] },
  ],
  summary: 'Covers the two apps and onboarding as revised. Does not cover marketing.',
  exclusions: ['Marketing work'],
  assumptions: [],
  clientResponsibilities: ['Hosting and server charges'],
  // G-177, and the sentence a zero-trust audit traced: the owner's note says
  // three weeks, so the revision comes back at three weeks. Before this field
  // existed there was nowhere for the reviser to put it, and the instruction
  // was applied to the price and silently dropped for the time.
  timelineWeeks: { min: 3, max: 3 },
};
let modelCalls = 0;
let sawTheNote = false;
let sawTheAsk = false;
// The marker is the NOTE's own words, not the prompt's: REVISION_PROMPT
// itself says "asked for changes", so matching that phrase would be a
// tautology satisfied by the system prompt on every call.
const NOTE = 'Price the driver app at 20000, add onboarding support, aur timeline 3 weeks kar do.';
const model = createServer((req, res) => {
  modelCalls += 1;
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (body.includes('Price the driver app at 20000')) sawTheNote = true;
    if (body.includes('Remove the driver app and add onboarding support')) sawTheAsk = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_stub', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(REVISED) }],
      usage: { input_tokens: 60, output_tokens: 40 },
    }));
  });
});
await new Promise((resolve, reject) => { model.once('error', reject); model.listen(MODEL_PORT, '127.0.0.1', resolve); })
  .catch((e) => fail(`could not bind the model stub on ${MODEL_PORT}: ${e.message}`));

console.log('\n\x1b[1mAgencyOS — the decision is the last human act (ADM-96)\x1b[0m');

const made = { leads: [], contacts: [], conversations: [], opportunities: [], policies: [], organizations: [] };
let owner = null;
let ownerId = null;

const savedSettings = (one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings`)) ?? {}).settings ?? {};
await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, {
  settings: { ...savedSettings, whatsapp_phone_number_id: 'PN.STUB.DISPATCH' },
});

/** A client with a lead, a WhatsApp thread, and (usually) consent. */
async function plantClient(title, { consent = true } = {}) {
  const contact = one(await rest('POST', 'crm', 'contacts', {
    organization_id: ORG, full_name: `${MARKER} ${title}`,
    phone: `+9198${String(Date.now()).slice(-8)}${made.contacts.length}`,
  }));
  made.contacts.push(contact.id);
  if (consent) {
    await rest('POST', 'crm', 'communication_consent', {
      organization_id: ORG, contact_id: contact.id, channel: 'whatsapp', status: 'granted',
    });
  }
  const lead = one(await rest('POST', 'crm', 'leads', {
    organization_id: ORG, contact_id: contact.id, title: `${MARKER} ${title}`,
    source: 'whatsapp', source_ref: `${MARKER}:${title}`, status: 'new',
  }));
  made.leads.push(lead.id);
  const conv = one(await rest('POST', 'crm', 'conversations', {
    organization_id: ORG, lead_id: lead.id, contact_id: contact.id, kind: 'direct',
    channel: 'whatsapp', external_ref: `${MARKER}:conv:${randomUUID().slice(0, 8)}`, status: 'active',
  }));
  made.conversations.push(conv.id);
  const opp = one(await rest('POST', 'sales', 'opportunities', {
    organization_id: ORG, lead_id: lead.id, name: `${MARKER} ${title} deal`, stage: 'discovery',
  }));
  made.opportunities.push(opp.id);
  return { contact, lead, conv, opp };
}

/**
 * Draft → line → submit (as the system, the way the agent's job does).
 *
 * `via` picks how the dispatcher will find the client: 'requirement' leaves
 * the proposal's own conversation_id NULL and lets the dispatcher walk to
 * the requirement version's thread — the shape every agent-drafted quotation
 * has in production — while 'conversation' stamps the column directly, the
 * shape a person's own send leaves behind.
 */
async function submitQuotation(opp, conv, { priceMinor = 4000000, via = 'conversation' } = {}) {
  let requirementVersionId;
  if (via === 'requirement') {
    const version = one(await rest('POST', 'crm', 'requirement_versions', {
      organization_id: ORG, conversation_id: conv.id, version: 1, source: 'agent',
      status: 'proposed',
      payload: { summary: 'A delivery app.', scopeItems: [], constraints: [], openQuestions: [] },
    }));
    requirementVersionId = version?.id;
  }
  const drafted = one(await rest('POST', 'sales', 'rpc/draft_proposal', {
    p_opportunity_id: opp.id,
    p_title: `${MARKER} delivery app quotation`,
    p_body: 'Covers the apps as discussed. Does not cover marketing.',
    ...(requirementVersionId ? { p_requirement_version_id: requirementVersionId } : {}),
  }));
  await rest('POST', 'sales', 'rpc/add_proposal_item', {
    p_proposal_id: drafted.proposal_id, p_description: 'Customer app', p_unit_price_minor: priceMinor,
  });
  // G-182 — the words the client reads above the figures. Written into the
  // document at DRAFT time, which is the only time it can be: the document is
  // frozen the moment the quotation leaves draft, and the point of the field
  // is that the owner approves the words along with the price.
  await rest('PATCH', 'sales', `proposals?id=eq.${drafted.proposal_id}`, {
    document: {
      understanding: 'The client wants a delivery platform for their own city.',
      coveringNote: `${MARKER} — yeh aapke delivery business ke liye hai: customer app aur driver app. Aage kya hoga woh neeche likha hai.`,
    },
    ...(via === 'conversation' ? { conversation_id: conv.id } : {}),
  });
  const submitted = one(await rest('POST', 'sales', 'rpc/submit_proposal', {
    p_proposal_id: drafted.proposal_id,
  }));
  return { proposalId: drafted.proposal_id, requestId: submitted?.request_id, outcome: submitted?.outcome };
}

/**
 * A quotation left as a DRAFT — G-184 needs one, because that is the only
 * state `apply_approved_offer` will touch. `submitQuotation` above submits.
 */
async function draftQuotation(opp, conv, { priceMinor = 4000000 } = {}) {
  const drafted = one(await rest('POST', 'sales', 'rpc/draft_proposal', {
    p_opportunity_id: opp.id,
    p_title: `${MARKER} offer quotation`,
    p_body: 'Covers the apps as discussed.',
  }));
  await rest('POST', 'sales', 'rpc/add_proposal_item', {
    p_proposal_id: drafted.proposal_id, p_description: 'Customer app', p_unit_price_minor: priceMinor,
  });
  await rest('PATCH', 'sales', `proposals?id=eq.${drafted.proposal_id}`, {
    conversation_id: conv.id,
    document: {
      understanding: 'The client wants a delivery platform.',
      coveringNote: `${MARKER} — yeh raha revised quotation, neeche details hain.`,
    },
  });
  return drafted.proposal_id;
}

const decide = (requestId, decision, note) =>
  call(owner, 'POST', 'approvals', 'rpc/decide_approval', {
    p_request_id: requestId, p_decision: decision, ...(note ? { p_note: note } : {}),
  });

try {
  // ── the approver, and the rung their approval resolves from ─────────────
  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      email: `zzdispatch-${randomUUID().slice(0, 8)}@example.invalid`,
      password: randomUUID(),
      email_confirm: true,
    }),
  }).then((r) => r.json()).catch(() => ({}));
  ownerId = authUser?.id ?? null;
  if (!ownerId) fail('could not create the approver');
  await rest('POST', 'core', 'memberships', {
    organization_id: ORG, user_id: ownerId, role: 'owner', status: 'active',
  });
  owner = mint(ownerId, 'owner');

  const policy = one(await rest('POST', 'approvals', 'approval_policies', {
    organization_id: ORG, subject_type: 'proposal', min_amount_minor: 0,
    required_role: 'owner', sla_hours: 24, audience: 'internal', note: `${MARKER} rung`,
  }));
  made.policies.push(policy.id);

  // ── 1 ────────────────────────────────────────────────────────────────────
  console.log('\n1. Approve → the client receives the quotation, and the row is stamped');
  const a = await plantClient('approved');
  // The agent-drafted shape: no conversation stamped, the requirement
  // version remembers where the client said yes.
  const quoteA = await submitQuotation(a.opp, a.conv, { via: 'requirement' });
  check(quoteA.outcome === 'submitted', 'the system submits the quotation with no person named', String(quoteA.outcome));

  const decided = one(await decide(quoteA.requestId, 'approved'));
  check(decided?.outcome === 'decided', 'the owner approves it in AgencyOS (ADM-74)', String(decided?.outcome));

  const sentRow = await tickUntil(async () => {
    const row = one(await rest('GET', 'sales',
      `proposals?id=eq.${quoteA.proposalId}&select=status,sent_at,conversation_id,sent_message_ref`));
    return row?.status === 'sent' ? row : null;
  });
  check(Boolean(sentRow), 'the quotation is stamped SENT — nobody pressed a send button', sentRow ? `sent_at ${sentRow.sent_at?.slice(0, 19)}` : 'never stamped');
  check(sentRow?.conversation_id === a.conv.id, 'into the conversation the client said yes in');

  // ── G-182: the client reads the agent's words before the figures ─────────
  const sentBody = one(await rest('GET', 'crm',
    `conversation_messages?conversation_id=eq.${a.conv.id}&external_ref=eq.${encodeURIComponent(`proposal:${quoteA.proposalId}:v1`)}&select=body`))?.body ?? '';
  check(
    sentBody.startsWith(`${MARKER} — yeh aapke delivery business ke liye hai`),
    'the message OPENS with the agent’s covering note, not with a price list',
    sentBody.split('\n')[0]?.slice(0, 52),
  );
  check(
    sentBody.includes('Total:') && sentBody.indexOf('Total:') > sentBody.indexOf('delivery business'),
    'and every figure is still beneath it, printed from the priced fields',
  );

  // ── G-180: the approved decision teaches the next quotation ──────────────
  //
  // The one thing this system could not do before: the owner could correct the
  // same mistake on fifty quotations and the fifty-first would make it again.
  const lesson = await tickUntil(async () => {
    const rows = (await rest('GET', 'ai',
      `memory_records?organization_id=eq.${ORG}&kind=eq.pricing_decision&source_id=eq.${quoteA.proposalId}&select=fact,scope,scope_id,confidence,source_kind,authored_by_agent,created_by`)).json ?? [];
    return rows.length > 0 ? rows[0] : null;
  });
  check(Boolean(lesson), 'the approved decision is recorded as something the agency has learned', lesson ? 'recorded' : 'nothing recorded');
  check(
    lesson?.scope === 'organization' && lesson?.scope_id === null,
    'scoped to the agency, not to the client who happened to pay',
    `${lesson?.scope}/${lesson?.scope_id}`,
  );
  check(
    lesson?.confidence === 'explicit' && lesson?.source_kind === 'sales.proposal',
    'stated by a person and pointing at the quotation itself, so it can be checked',
    `${lesson?.confidence} · ${lesson?.source_kind}`,
  );
  check(
    lesson?.authored_by_agent === null && lesson?.created_by === ownerId,
    'written by NO agent, and credited to the person who decided',
    `agent ${lesson?.authored_by_agent} · by ${String(lesson?.created_by).slice(0, 8)}`,
  );
  check(
    typeof lesson?.fact === 'string' && /approved|raised|reduced/.test(lesson.fact),
    'and it says what the owner actually did',
    String(lesson?.fact ?? '').slice(0, 70),
  );

  // Twice through the same decision must not double its weight.
  for (let i = 0; i < 3; i += 1) await tick();
  const once = (await rest('GET', 'ai',
    `memory_records?organization_id=eq.${ORG}&kind=eq.pricing_decision&source_id=eq.${quoteA.proposalId}&select=id`)).json ?? [];
  check(once.length === 1, 'recorded once, however many times the event is redelivered', `${once.length} row(s)`);

  const clientRows = (await rest('GET', 'crm',
    `conversation_messages?conversation_id=eq.${a.conv.id}&select=body,author_id,external_ref,metadata&order=seq`)).json ?? [];
  const textRow = clientRows.find((r) => r.external_ref === `proposal:${quoteA.proposalId}:v1`);
  const pdfRow = clientRows.find((r) => r.external_ref === `proposal:${quoteA.proposalId}:v1:pdf`);
  check(Boolean(textRow) && /₹/.test(textRow?.body ?? ''), 'the priced text is recorded on the client thread', (textRow?.body ?? '').split('\n')[0]);
  check(
    textRow?.author_id === ownerId,
    'authored by the APPROVER — the human whose decision this executes (ADM-22’s core)',
    String(textRow?.author_id).slice(0, 8),
  );
  check(Boolean(pdfRow) && pdfRow?.metadata?.media_type === 'document', 'and the PDF row beside it', pdfRow?.metadata?.media_filename ?? '(none)');
  check(pdfRow?.author_id === ownerId, 'authored the same way');
  check(textRow?.metadata?.delivery === 'sent' && pdfRow?.metadata?.delivery === 'sent', 'both settled sent — the wire, not just the record (G-161)');

  const clientText = graphSends.find((g) => (g.body?.type === 'text' || g.body?.text) && g.body?.to === a.contact.phone);
  check(Boolean(clientText), 'the text genuinely left for the CLIENT’s number', clientText?.body?.to ?? '(none)');
  const clientDoc = graphSends.find((g) => g.body?.type === 'document');
  check(Boolean(clientDoc) && (graphUploads[0]?.bytes ?? 0) > 10000, 'and the document left as real bytes', `${graphUploads[0]?.bytes ?? 0} byte(s)`);

  // ── 2 ────────────────────────────────────────────────────────────────────
  console.log('\n2. Deciding twice, dispatching twice — one send, not two');
  const again = one(await decide(quoteA.requestId, 'approved'));
  check(again?.outcome === 'already_decided', 'a second decision answers already_decided', String(again?.outcome));

  const sendsBefore = graphSends.length;
  await rest('POST', 'core', 'jobs', {
    organization_id: ORG, kind: 'proposal.dispatch', status: 'queued',
    payload: {
      subjectId: quoteA.requestId,
      event: { subjectType: 'proposal', subjectId: quoteA.proposalId, decision: 'approved', decidedBy: ownerId },
    },
    dedupe_key: `${MARKER}-dup-${randomUUID().slice(0, 8)}`,
    run_at: new Date().toISOString(), max_attempts: 5,
  });
  for (let i = 0; i < 6; i += 1) await tick();
  check(
    graphSends.length === sendsBefore,
    'a duplicate dispatch job sends NOTHING — the stamped row short-circuits it',
    `${graphSends.length - sendsBefore} extra send(s)`,
  );

  // The MANUAL door, after the automatic one: `sales.send_proposal` is what a
  // person's Send button stamps through, and against the already-stamped row
  // it answers already_sent rather than pretending a second send happened.
  const manualDoor = one(await rest('POST', 'sales', 'rpc/send_proposal', {
    p_proposal_id: quoteA.proposalId,
  }));
  check(
    manualDoor?.outcome === 'already_sent',
    'the manual Send door answers already_sent — two doors, one delivery',
    String(manualDoor?.outcome),
  );

  // And the transcript agrees: exactly one text and one document reached the
  // client's thread, whatever combination of doors and retries ran. This is
  // the idempotency-KEY half — a duplicate would be a third row, since the
  // dedupe lives on external_ref, not on the job.
  const aRows = (await rest('GET', 'crm',
    `conversation_messages?conversation_id=eq.${a.conv.id}&select=id`)).json ?? [];
  check(aRows.length === 2, 'the client thread holds exactly two rows: the text and the PDF', `${aRows.length} row(s)`);

  // ── 3 ────────────────────────────────────────────────────────────────────
  console.log('\n3. Changes + note → the agent drafts v2 from the note and resubmits');
  const b = await plantClient('revised');
  const quoteB = await submitQuotation(b.opp, b.conv);
  const changed = one(await decide(quoteB.requestId, 'changes_requested', NOTE));
  check(changed?.outcome === 'decided', 'the owner asks for changes, with a note', String(changed?.outcome));

  /**
   * The lesson job for THIS decision, caught while it runs — G-180.
   *
   * Collected here rather than after the revision, because the ticks that wait
   * for v2 drain it and a later tick finds nothing to report. That is not a
   * detail: the first version of this check ran afterwards, found no outcome
   * at all, and would have passed for the wrong reason if it had been written
   * the other way round.
   */
  // `tick()` here already returns a parsed body — the first version of this
  // called JSON.parse on the object it returns, threw into an empty catch, and
  // collected nothing while reporting "no lesson job reported an outcome". A
  // check that cannot see what it is measuring fails for the wrong reason.
  const lessonOutcomes = [];
  const revisionOutcomesOnV1 = [];
  for (let i = 0; i < 4; i += 1) {
    const { json } = await tick();
    for (const row of json?.lessons ?? []) lessonOutcomes.push(row.outcome);
    // G-185's learner sees the same decision. On v1 it must answer that there
    // is nothing to compare — collected here for the same reason the line
    // above is: a later tick finds the job already drained.
    for (const row of json?.revisionLessons ?? []) revisionOutcomesOnV1.push(row.outcome);
  }

  const v2 = await tickUntil(async () => {
    const row = one(await rest('GET', 'sales',
      `proposals?opportunity_id=eq.${b.opp.id}&version=eq.2&select=id,status,title,total_minor,generated_by_run_id`));
    return row?.status === 'pending_approval' ? row : null;
  });
  check(Boolean(v2), 'v2 exists and is already SUBMITTED — the loop closes without a person drafting', v2 ? v2.status : 'no v2');
  check(sawTheNote && modelCalls > 0, 'the model was given the owner’s note as the instruction', `${modelCalls} call(s)`);
  const v1After = one(await rest('GET', 'sales',
    `proposals?id=eq.${quoteB.proposalId}&select=status`));
  check(v1After?.status === 'superseded', 'v1 is superseded by the revision — history, not an edit', String(v1After?.status));
  check(
    v2?.total_minor === REVISED.items.reduce((s, i) => s + i.priceRupees * 100, 0),
    'v2’s total is the revised arithmetic, rupees ×100',
    String(v2?.total_minor),
  );
  check(Boolean(v2?.generated_by_run_id), 'and v2 names the run that drafted it');

  // ── G-180: what the owner's decision teaches the next quotation ──────────
  //
  // The changes_requested decision just above must teach NOTHING. A price the
  // owner sent back is not a price they endorsed, and recording it would train
  // the agency to repeat exactly what it had been corrected on.
  const fromChanges = (await rest('GET', 'ai',
    `memory_records?organization_id=eq.${ORG}&kind=eq.pricing_decision&source_id=eq.${quoteB.proposalId}&select=id`)).json ?? [];
  check(
    fromChanges.length === 0,
    'a changes_requested decision teaches nothing — a price sent back is not one endorsed',
    `${fromChanges.length} memory row(s)`,
  );

  /**
   * WHICH guard refused it, and this distinction cost a red-proof to find.
   *
   * The check above passed with the approved-only guard REMOVED from the live
   * handler: by the time the job runs, the reviser has superseded v1, so the
   * separate `not_standing` rule catches it. The outcome check above is a true
   * statement about the system and a FALSE test of the rule it was written
   * for — the guard-ownership mistake this repository has a name for.
   *
   * The runner reports each lesson job's outcome, so this asks the handler
   * directly. Only the state guard can answer `not_approved`.
   */
  check(
    lessonOutcomes.includes('not_approved'),
    'and it is the APPROVED-ONLY rule that refuses it, not a later one — asked of the handler itself',
    lessonOutcomes.length > 0 ? lessonOutcomes.join(', ') : 'no lesson job reported an outcome',
  );
  // G-185. The revision learner refuses the same decision, and the APPROVED-
  // ONLY rule is what refuses it: the version check behind it would answer
  // `not_a_revision` instead, so naming the outcome is what distinguishes the
  // two — the guard-ownership mistake G-180 has a name for.
  check(
    revisionOutcomesOnV1.includes('not_approved'),
    'and the revision learner refuses it by the APPROVED-ONLY rule, named rather than inferred',
    revisionOutcomesOnV1.length > 0 ? revisionOutcomesOnV1.join(', ') : 'no revision lesson job reported an outcome',
  );

  const v2Doc = one(await rest('GET', 'sales', `proposals?id=eq.${v2?.id}&select=document`))?.document;
  check(
    typeof v2Doc?.understanding === 'string',
    'and the revision carries its own document (G-165)',
    v2Doc ? 'stored' : 'missing',
  );
  // G-177 — the half of the owner's note that used to be dropped in silence.
  check(
    v2Doc?.timelineWeeks?.min === 3 && v2Doc?.timelineWeeks?.max === 3,
    'and the TIMELINE the owner asked for is on the revision, not just the price',
    `${v2Doc?.timelineWeeks?.min ?? '-'}–${v2Doc?.timelineWeeks?.max ?? '-'} weeks`,
  );

  const v2Features = (await rest('GET', 'sales',
    `proposal_items?proposal_id=eq.${v2?.id}&select=features&order=position`)).json ?? [];
  check(
    v2Features.length > 0 && v2Features.every((r) => Array.isArray(r.features) && r.features.length >= 2),
    'with the bullets on the revision’s own LINE rows (review fix)',
    `${v2Features.filter((r) => Array.isArray(r.features)).length}/${v2Features.length} line(s)`,
  );

  const revisedAgain = (await rest('GET', 'sales',
    `proposals?opportunity_id=eq.${b.opp.id}&select=id`)).json ?? [];
  check(revisedAgain.length === 2, 'exactly two versions — the retry guard does not burn version numbers', `${revisedAgain.length} version(s)`);

  // ── 4 ────────────────────────────────────────────────────────────────────
  console.log('\n4. Reject → carried to draft, nothing sent, nothing invented');
  const c = await plantClient('rejected');
  const quoteC = await submitQuotation(c.opp, c.conv);
  const rejected = one(await decide(quoteC.requestId, 'rejected'));
  check(rejected?.outcome === 'decided', 'the owner rejects it', String(rejected?.outcome));

  const backToDraft = await tickUntil(async () => {
    const row = one(await rest('GET', 'sales', `proposals?id=eq.${quoteC.proposalId}&select=status`));
    return row?.status === 'draft' ? row : null;
  });
  check(Boolean(backToDraft), 'the rejection is carried to the quotation by the EVENT — no UI ran here', backToDraft?.status ?? 'not carried');
  const cRows = (await rest('GET', 'crm',
    `conversation_messages?conversation_id=eq.${c.conv.id}&select=id`)).json ?? [];
  check(cRows.length === 0, 'the client heard nothing', `${cRows.length} message(s)`);
  const cVersions = (await rest('GET', 'sales',
    `proposals?opportunity_id=eq.${c.opp.id}&select=id`)).json ?? [];
  check(cVersions.length === 1, 'and no revision was invented from a decision that asked for none', `${cVersions.length} version(s)`);

  // ── 5 ────────────────────────────────────────────────────────────────────
  console.log('\n5. No consent → ADM-70 wins; the quotation stays approved for a person');
  const d = await plantClient('unconsented', { consent: false });
  const quoteD = await submitQuotation(d.opp, d.conv);
  const sendsBeforeD = graphSends.length;
  await decide(quoteD.requestId, 'approved');
  const settledD = await tickUntil(async () => {
    const job = one(await rest('GET', 'core',
      `jobs?kind=eq.proposal.dispatch&payload->>subjectId=eq.${quoteD.requestId}&select=status,last_error`));
    return job && job.status !== 'queued' && job.status !== 'running' ? job : null;
  });
  check(settledD?.status === 'succeeded', 'the dispatch job SUCCEEDS — a refusal of the rule is not a failure of the wiring', `${settledD?.status}`);
  const dRow = one(await rest('GET', 'sales', `proposals?id=eq.${quoteD.proposalId}&select=status`));
  check(dRow?.status === 'approved', 'the quotation stays approved, sendable by a person who knows the client', String(dRow?.status));
  const dRows = (await rest('GET', 'crm',
    `conversation_messages?conversation_id=eq.${d.conv.id}&select=id`)).json ?? [];
  check(dRows.length === 0 && graphSends.length === sendsBeforeD, 'and nothing reached the client or the wire', `${dRows.length} row(s), ${graphSends.length - sendsBeforeD} send(s)`);

  // ── 6 ────────────────────────────────────────────────────────────────────
  console.log('\n6. The CLIENT asks for a change → the agent reworks, prices, resubmits (G-163)');
  // Deal `a` ended section 1 SENT and consented — exactly the state a client
  // change-ask arrives in. The ask becomes an objection row the way the read
  // job writes one; the row's insert emits objection.recorded; the rework job
  // drafts v2 from the client's own words and submits it to the owner.
  const pushback = one(await rest('POST', 'crm', 'conversation_messages', {
    organization_id: ORG, conversation_id: a.conv.id, seq: 2, author_type: 'client',
    body: 'Driver app hata do aur onboarding support add karo, iOS baad me dekhenge.',
  }));
  check(Boolean(pushback?.id), 'the client wrote back', pushback?.id ? 'recorded' : 'no row');

  const ask = one(await rest('POST', 'sales', 'objections', {
    organization_id: ORG, lead_id: a.lead.id, message_id: pushback?.id,
    round: 1, proposal_id: quoteA.proposalId, kind: 'feature',
    concern: 'Remove the driver app and add onboarding support; iOS later.',
    raised_by_agent: 'sales',
  }));
  check(Boolean(ask?.id), 'the ask is an objection row, as the read job records one', ask?.id ? 'recorded' : 'refused');

  const v2FromAsk = await tickUntil(async () => {
    const row = one(await rest('GET', 'sales',
      `proposals?opportunity_id=eq.${a.opp.id}&version=eq.2&select=id,status,total_minor,generated_by_run_id`));
    return row?.status === 'pending_approval' ? row : null;
  });
  check(Boolean(v2FromAsk), 'v2 exists and is SUBMITTED — the client asked, and the owner has a decision, not a task', v2FromAsk?.status ?? 'no v2');
  check(sawTheAsk, 'the model was given the client’s own words, never a paraphrase');
  const v1AfterAsk = one(await rest('GET', 'sales', `proposals?id=eq.${quoteA.proposalId}&select=status`));
  check(
    v1AfterAsk?.status === 'superseded',
    'the SENT v1 is superseded — the number the client is holding is no longer on the table (§16)',
    String(v1AfterAsk?.status),
  );
  check(Boolean(v2FromAsk?.generated_by_run_id), 'and v2 names the run that reworked it');
  const reworkDoc = one(await rest('GET', 'sales', `proposals?id=eq.${v2FromAsk?.id}&select=document`))?.document;
  check(
    typeof reworkDoc?.understanding === 'string',
    'and the REWORK door writes its document too — all three drafting doors live-covered (review finding)',
    reworkDoc ? 'stored' : 'missing',
  );
  const askAfter = one(await rest('GET', 'sales', `objections?id=eq.${ask?.id}&select=response`));
  check(askAfter?.response === null, 'the objection’s answer stays NULL — a response is what a PERSON says (ADM-76)');

  // ── 7 ────────────────────────────────────────────────────────────────────
  //
  // G-183 INVERTED THIS SECTION, and the inversion is the point.
  //
  // A price objection used to plan nothing: the reason given was ADM-22's
  // posture, that the agent may not move a number under client pressure. That
  // conflated two things. What ADM-22 forbids is a number reaching a CLIENT
  // without a person deciding it — and a rework decides nothing: it drafts and
  // submits for approval, and the owner sees it first. Refusing to draft did
  // not protect the price; it left the whole response to a person while the
  // ask sat in a queue.
  //
  // So the checks below moved from "nothing happened" to "a version was
  // drafted AND the client was told nothing" — which is the property that
  // actually matters, and the one the old shape could not distinguish from
  // doing nothing at all.
  console.log('\n7. A PRICE objection now redrafts — for the OWNER, never for the client (G-183)');

  /**
   * Its OWN client, and the fixture matters.
   *
   * The first version of this section raised the price objection against `a`'s
   * v2, and the agent refused with a reason worth keeping: *"v2 is
   * pending_approval; the client is not holding it."* You cannot rework a
   * quotation the client has never seen, and by that point in this script
   * `a`'s only SENT version had been superseded.
   *
   * That was the fixture being wrong rather than the code, and it is the kind
   * of thing a check that could not explain itself would have been "fixed"
   * around. So this section plants a client, gets a quotation approved and
   * actually SENT to them, and then argues about the price — which is the only
   * order in which a price objection means anything.
   */
  const e = await plantClient('price-objection');
  const quoteE = await submitQuotation(e.opp, e.conv);
  await decide(quoteE.requestId, 'approved');
  const sentE = await tickUntil(async () => {
    const row = one(await rest('GET', 'sales', `proposals?id=eq.${quoteE.proposalId}&select=status`));
    return row?.status === 'sent' ? row : null;
  });
  check(sentE?.status === 'sent', 'a quotation the client is actually holding', String(sentE?.status));

  const clientMessagesBefore = ((await rest('GET', 'crm',
    `conversation_messages?conversation_id=eq.${e.conv.id}&author_type=eq.user&select=id`)).json ?? []).length;

  const priceAsk = one(await rest('POST', 'sales', 'objections', {
    organization_id: ORG, lead_id: e.lead.id,
    round: 1, proposal_id: quoteE.proposalId, kind: 'price',
    concern: 'Just make the same thing cheaper.',
    raised_by_agent: 'sales',
  }));
  check(Boolean(priceAsk?.id), 'the price push is recorded as an objection', priceAsk?.id ? 'recorded' : 'refused');

  /**
   * One loop, ticking and collecting the agent's own reasons as it goes.
   *
   * It was two: a `tickUntil` waiting for the job row, then a second loop
   * waiting for the new version. The first loop's ticks RAN the rework, so by
   * the time the second started there was nothing left to report and a failure
   * said only "no v2". A check that consumes the thing it is about to measure
   * cannot explain itself — and this section's real defect was only findable
   * once it could.
   */
  const reworkReasons = [];
  let priceRework = null;
  let reworked = null;
  for (let i = 0; i < 30; i += 1) {
    priceRework ??= ((await rest('GET', 'core',
      `jobs?kind=eq.quotation.rework&payload->>subjectId=eq.${priceAsk?.id}&select=id,status`)).json ?? [])[0] ?? null;
    const row = one(await rest('GET', 'sales',
      `proposals?opportunity_id=eq.${e.opp.id}&version=eq.2&select=id,status,total_minor`));
    if (row?.status === 'pending_approval') { reworked = row; break; }
    const { json } = await tick();
    for (const r of json?.agentRuns ?? []) if (r?.reason) reworkReasons.push(r.reason);
  }
  check(Boolean(priceRework), 'a rework job IS planned for it now', priceRework ? 'planned' : 'nothing planned');
  check(
    Boolean(reworked),
    'and a new version is drafted and submitted',
    reworked ? `v2 ${reworked.status}` : `no v2 — the agent said: ${[...new Set(reworkReasons)].join(' | ') || '(nothing)'}`,
  );

  // The line that makes widening the gate safe: the client has been told
  // nothing. Every number still waits on the owner.
  const clientMessagesAfter = ((await rest('GET', 'crm',
    `conversation_messages?conversation_id=eq.${e.conv.id}&author_type=eq.user&select=id`)).json ?? []).length;
  check(
    clientMessagesAfter === clientMessagesBefore,
    'and the CLIENT was sent nothing — the redraft is for the owner’s decision (ADM-22, ADM-07)',
    `${clientMessagesBefore} → ${clientMessagesAfter} message(s)`,
  );
  check(
    reworked?.status === 'pending_approval',
    'the new price is pending a person, not on its way to anybody',
    String(reworked?.status),
  );

  // ── 7b ───────────────────────────────────────────────────────────────────
  console.log('\n7b. A feature ask that names NO quotation plans nothing either');
  const noQuote = one(await rest('POST', 'sales', 'objections', {
    organization_id: ORG, lead_id: a.lead.id, message_id: pushback?.id,
    round: 3, kind: 'feature',
    concern: 'Pre-quote pushback with nothing to rework.',
    raised_by_agent: 'sales',
  }));
  check(Boolean(noQuote?.id), 'a pre-quote feature ask is recorded', noQuote?.id ? 'recorded' : 'refused');
  for (let i = 0; i < 4; i += 1) await tick();
  const noQuoteJobs = (await rest('GET', 'core',
    `jobs?kind=eq.quotation.rework&payload->>subjectId=eq.${noQuote?.id}&select=id`)).json ?? [];
  check(noQuoteJobs.length === 0, 'the filter’s second conjunct is LIVE: no proposalId, no job', `${noQuoteJobs.length} job(s)`);

  // ── 8 ────────────────────────────────────────────────────────────────────
  // The review red-proved that the resume guard's branches were pinned by
  // prose alone and never executed anywhere. Each of its three readings runs
  // for real here.
  console.log('\n8. The resume guard’s three readings, each EXECUTED');

  // 8a — a person's newer draft wins; the ask waits for them.
  const f = await plantClient('humanheld');
  const quoteF = await submitQuotation(f.opp, f.conv);
  await decide(quoteF.requestId, 'approved');
  const sentF = await tickUntil(async () => {
    const row = one(await rest('GET', 'sales', `proposals?id=eq.${quoteF.proposalId}&select=status`));
    return row?.status === 'sent' ? row : null;
  });
  check(Boolean(sentF), 'deal f: v1 reached the client', sentF ? 'sent' : 'never sent');
  const humanDraft = one(await rest('POST', 'sales', 'rpc/draft_proposal', {
    p_opportunity_id: f.opp.id, p_title: `${MARKER} a persons own v2`,
  }));
  check(humanDraft?.outcome === 'created', 'a person hand-drafts v2 over it (no run id)', String(humanDraft?.outcome));
  const askF = one(await rest('POST', 'sales', 'objections', {
    organization_id: ORG, lead_id: f.lead.id, round: 1, proposal_id: quoteF.proposalId,
    kind: 'feature', concern: 'Please add reports.', raised_by_agent: 'sales',
  }));
  const jobF = await tickUntil(async () => {
    const j = one(await rest('GET', 'core',
      `jobs?kind=eq.quotation.rework&payload->>subjectId=eq.${askF?.id}&select=status`));
    return j && j.status !== 'queued' && j.status !== 'running' ? j : null;
  });
  check(jobF?.status === 'succeeded', 'the rework settles without touching anything', String(jobF?.status));
  const fVersions = (await rest('GET', 'sales',
    `proposals?opportunity_id=eq.${f.opp.id}&select=version,status,title&order=version`)).json ?? [];
  check(fVersions.length === 2, 'no v3 was drafted — THEIRS WINS executed', `${fVersions.length} version(s)`);
  check(
    fVersions[1]?.status === 'draft' && /persons own v2/.test(fVersions[1]?.title ?? ''),
    'and the person’s draft is untouched, word for word',
    fVersions[1]?.status,
  );

  // 8b — a newer version already past draft is the answer in flight.
  const askInFlight = one(await rest('POST', 'sales', 'objections', {
    organization_id: ORG, lead_id: a.lead.id, round: 4, proposal_id: quoteA.proposalId,
    kind: 'feature', concern: 'One more thing on top.', raised_by_agent: 'sales',
  }));
  const jobInFlight = await tickUntil(async () => {
    const j = one(await rest('GET', 'core',
      `jobs?kind=eq.quotation.rework&payload->>subjectId=eq.${askInFlight?.id}&select=status`));
    return j && j.status !== 'queued' && j.status !== 'running' ? j : null;
  });
  check(jobInFlight?.status === 'succeeded', 'an ask behind a pending decision settles honestly', String(jobInFlight?.status));
  const aVersions = (await rest('GET', 'sales',
    `proposals?opportunity_id=eq.${a.opp.id}&select=id`)).json ?? [];
  check(aVersions.length === 2, 'ALREADY IN FLIGHT executed — v2 pending, no v3', `${aVersions.length} version(s)`);

  // 8c — the agent's OWN failed half is superseded by a complete redraft.
  const g = await plantClient('crashedhalf');
  const quoteG = await submitQuotation(g.opp, g.conv);
  await decide(quoteG.requestId, 'approved');
  await tickUntil(async () => {
    const row = one(await rest('GET', 'sales', `proposals?id=eq.${quoteG.proposalId}&select=status`));
    return row?.status === 'sent' ? row : null;
  });
  // The crashed attempt, fabricated exactly as a died job leaves it: the
  // objection recorded (job queued, not yet run), a FAILED run whose subject
  // is that objection, and a half-drafted v2 bearing the run's id.
  const askG = one(await rest('POST', 'sales', 'objections', {
    organization_id: ORG, lead_id: g.lead.id, round: 1, proposal_id: quoteG.proposalId,
    kind: 'feature', concern: 'Add a reports module please.', raised_by_agent: 'sales',
  }));
  const crashedRun = one(await rest('POST', 'ai', 'agent_runs', {
    organization_id: ORG, agent_key: 'sales', trigger: `${MARKER}:fabricated`,
    subject_type: 'sales.objection', subject_id: askG?.id, status: 'failed',
    work_class: 'draft', model: 'claude-sonnet-5', input: {},
    started_at: new Date().toISOString(),
  }));
  check(Boolean(crashedRun?.id), 'a failed run for that very objection exists', crashedRun?.id ? 'planted' : JSON.stringify(crashedRun)?.slice(0, 80));
  const halfDraft = one(await rest('POST', 'sales', 'rpc/draft_proposal', {
    p_opportunity_id: g.opp.id, p_title: `${MARKER} half-written v2`,
    p_generated_by_run_id: crashedRun?.id,
  }));
  check(halfDraft?.outcome === 'created', 'and its half-written v2 supersedes the sent v1', String(halfDraft?.outcome));
  const jobG = await tickUntil(async () => {
    const j = one(await rest('GET', 'core',
      `jobs?kind=eq.quotation.rework&payload->>subjectId=eq.${askG?.id}&select=status`));
    return j && j.status !== 'queued' && j.status !== 'running' ? j : null;
  });
  check(jobG?.status === 'succeeded', 'the retry recognises ITS OWN half', String(jobG?.status));
  const gVersions = (await rest('GET', 'sales',
    `proposals?opportunity_id=eq.${g.opp.id}&select=version,status&order=version`)).json ?? [];
  check(
    gVersions.length === 3 && gVersions[1]?.status === 'superseded' && gVersions[2]?.status === 'pending_approval',
    'OWN FAILED HALF executed: v2 superseded, a complete v3 submitted',
    gVersions.map((v) => `v${v.version}:${v.status}`).join(' '),
  );
  // ── 10 ───────────────────────────────────────────────────────────────────
  //
  // ADM-98, G-184. The one path in this system where a price reaches a client
  // without a fresh decision — so it is the one that most needs proving, and
  // every guard below is proved by being HIT rather than by being read.
  console.log('\n10. An offer the owner made in advance (ADM-98 — overrides ADM-22)');

  const authored = one(await rest('POST', 'sales', 'rpc/set_approved_offer', {
    p_organization_id: ORG, p_label: `${MARKER} sign this week`,
    p_condition: 'they confirm within 7 days', p_discount_pct: 10, p_valid_until: null,
  }));
  check(authored?.outcome === 'set', 'the owner authorises one concession', String(authored?.outcome));

  const expired = one(await rest('POST', 'sales', 'rpc/set_approved_offer', {
    p_organization_id: ORG, p_label: `${MARKER} stale`,
    p_condition: 'was valid once', p_discount_pct: 10, p_valid_until: '2020-01-01',
  }));
  check(expired?.outcome === 'already_expired', 'an already-expired date is refused as the mistake it is', String(expired?.outcome));

  const live = (await rest('GET', 'sales', `approved_offers?organization_id=eq.${ORG}&active=is.true&select=id,label`)).json ?? [];
  check(live.length === 1, 'exactly ONE offer is live — several would make the agent choose', `${live.length}`);

  // Over the cap, refused by the column rather than by a form.
  const overCap = await rest('POST', 'sales', 'approved_offers', {
    organization_id: ORG, label: `${MARKER} half off`, condition: 'any reason at all',
    discount_pct: 80, created_by: ownerId,
  });
  check(!overCap.ok, 'a discount above the cap cannot even be inserted', `HTTP ${overCap.status}`);

  /**
   * AS THE OWNER, through their own session — the settings form's actual path.
   *
   * `db:verify:invokerrls` refused the first version of this migration for
   * exactly this reason: the function is INVOKER, the table had no INSERT
   * policy, and everything here passed as the service role while the form
   * would have been dead. Proving the service-role path proves the wrong
   * caller, so this one runs signed in.
   */
  const asOwner = one(await call(owner, 'POST', 'sales', 'rpc/set_approved_offer', {
    p_organization_id: ORG, p_label: `${MARKER} owner authored`,
    p_condition: 'they confirm within 7 days', p_discount_pct: 10, p_valid_until: null,
  }));
  check(asOwner?.outcome === 'set', 'the OWNER can author one through their own session', String(asOwner?.outcome));

  // And the door that policy opened is only wide enough for that function.
  const forged = await call(owner, 'POST', 'sales', 'approved_offers', {
    organization_id: ORG, label: `${MARKER} forged`, condition: 'no reason at all',
    discount_pct: 50, created_by: ownerId,
  });
  check(
    !forged.ok && /not by a direct write/.test(forged.text),
    'and cannot write one directly, past the cap and the audit',
    `HTTP ${forged.status}`,
  );

  /**
   * And the concession does not cross a tenant.
   *
   * `approved_offers` holds what this agency is willing to give away and on
   * what condition — a competitor's favourite page. Every other check in this
   * script runs as the service role, which bypasses RLS, so a leak here would
   * look exactly like a pass.
   */
  const stranger = one(await rest('POST', 'core', 'organizations', {
    name: `${MARKER} other agency`, slug: `${MARKER}-other`,
  }));
  check(Boolean(stranger?.id), 'a second agency exists to ask from', String(stranger?.id).slice(0, 8));
  made.organizations.push(stranger?.id);
  const strangerToken = mint(randomUUID(), 'owner', stranger?.id);
  const peeked = await call(strangerToken, 'GET', 'sales', 'approved_offers?select=label,discount_pct');
  check(
    peeked.ok && (peeked.json ?? []).length === 0,
    'another agency sees none of this one’s offers — not the cap, not the condition',
    `HTTP ${peeked.status}, ${(peeked.json ?? []).length} row(s)`,
  );
  const ours = await call(owner, 'GET', 'sales', 'approved_offers?select=label');
  check(
    ours.ok && (ours.json ?? []).length > 0,
    'while this agency’s owner sees their own — the refusal is about the tenant, not about everybody',
    `${(ours.json ?? []).length} row(s)`,
  );

  // The agent's own function is reachable by nobody who is signed in: it
  // settles an approval, and an end user calling it decides their own price.
  const reached = await call(owner, 'POST', 'sales', 'rpc/apply_approved_offer', {
    p_proposal_id: '00000000-0000-4000-8000-00000000dead',
  });
  check(!reached.ok, 'and no signed-in caller may apply one at all', `HTTP ${reached.status}`);

  // The owner's own WhatsApp, which is what "the owner is told" means here
  // (ADM-95 — Meta refused this WABA the Groups API, #131215).
  const channel = one(await rest('POST', 'crm', 'rpc/link_internal_recipient', {
    p_organization_id: ORG, p_phone: '+91 83606 91641', p_title: `${MARKER} owner`,
  }));
  check(Boolean(channel?.conversation_id), 'the owner has a channel to be told on', String(channel?.outcome));

  const offerClient = await plantClient('offer');
  const offerProposal = await draftQuotation(offerClient.opp, offerClient.conv);

  const applied = one(await rest('POST', 'sales', 'rpc/apply_approved_offer', { p_proposal_id: offerProposal }));
  check(applied?.outcome === 'applied', 'the agent applies it to a draft quotation', String(applied?.outcome));
  check(
    Number(applied?.discount_minor) === 400000 && Number(applied?.total_minor) === 3600000,
    'ten per cent, through discount_minor — the column the arithmetic has always checked',
    `−${applied?.discount_minor} → ${applied?.total_minor}`,
  );

  // ONE per opportunity, ever. Without it a client who pushes twice is given
  // the discount twice, which is a negotiation the agent is having on its own.
  //
  // Two different refusals, and both are named rather than merely "not
  // applied" — a guard proved by `outcome !== 'applied'` is also satisfied by
  // the function erroring, which is how G-180's false test read green.
  const offerAgain = one(await rest('POST', 'sales', 'rpc/apply_approved_offer', { p_proposal_id: offerProposal }));
  check(offerAgain?.outcome === 'not_draft', 'the same quotation cannot be discounted twice', String(offerAgain?.outcome));

  // The approval it settled is REAL, and names a real decider.
  const offerRow = one(await rest('GET', 'sales',
    `proposals?id=eq.${offerProposal}&select=status,applied_offer_id,approval_request_id,discount_minor`));
  check(Boolean(offerRow?.applied_offer_id), 'the quotation records which offer it carries');
  const offerRequest = one(await rest('GET', 'approvals',
    `approval_requests?id=eq.${offerRow?.approval_request_id}&select=state,decided_by,decision_note`));
  check(offerRequest?.state === 'approved', 'a real approval request was raised AND settled', String(offerRequest?.state));
  check(
    offerRequest?.decided_by === ownerId,
    'in the name of the human who authored the offer — the decision is real and so is the decider',
    String(offerRequest?.decided_by).slice(0, 8),
  );
  check(
    String(offerRequest?.decision_note ?? '').includes('Pre-authorised offer applied'),
    'and the note says how it was decided, so nobody has to guess',
    String(offerRequest?.decision_note ?? '').slice(0, 46),
  );

  // End to end: the client gets it, with the condition, and the owner is told.
  const offerSent = await tickUntil(async () => {
    const row = one(await rest('GET', 'sales', `proposals?id=eq.${offerProposal}&select=status`));
    return row?.status === 'sent' ? row : null;
  });
  check(offerSent?.status === 'sent', 'it reaches the client with no further decision — the whole of ADM-98', String(offerSent?.status));

  const offerBody = one(await rest('GET', 'crm',
    `conversation_messages?conversation_id=eq.${offerClient.conv.id}&external_ref=like.proposal:${offerProposal}*&select=body`))?.body ?? '';
  check(
    // The label of the offer that is actually STANDING — the owner's own,
    // which retired the first one above. Naming the retired label here would
    // be asserting against a row nothing can apply any more.
    offerBody.includes('owner authored') && offerBody.includes('they confirm within 7 days'),
    'and the client is told WHAT they got and WHY — a silent discount is one they expect again',
    offerBody.split('\n').find((l) => l.includes('applies because'))?.slice(0, 54) ?? '(no condition line)',
  );

  const told = await tickUntil(async () => {
    const rows = (await rest('GET', 'crm',
      `conversation_messages?organization_id=eq.${ORG}&external_ref=eq.${encodeURIComponent(`offer:${offerProposal}`)}&select=body`)).json ?? [];
    return rows.length > 0 ? rows[0] : null;
  });
  check(Boolean(told), 'the OWNER is told afterwards — the half of ADM-98 they asked for by name', told ? 'told' : 'never told');
  check(
    String(told?.body ?? '').includes('has already gone to the client'),
    'in words that say it is done rather than pending',
    String(told?.body ?? '').split('\n')[0]?.slice(0, 52),
  );

  // A NEW version of the same deal, and it is refused too — one concession per
  // client, ever. Left until here deliberately: drafting v2 supersedes v1, so
  // asking this question earlier would have taken the sent quotation above out
  // from under its own assertions.
  const nextVersion = await draftQuotation(offerClient.opp, offerClient.conv);
  const onNext = one(await rest('POST', 'sales', 'rpc/apply_approved_offer', { p_proposal_id: nextVersion }));
  check(
    onNext?.outcome === 'already_offered',
    'and neither can a NEW version of the same deal — one concession per client, ever',
    String(onNext?.outcome),
  );

  // The owner's own floor (G-179) outranks the owner's own offer. A cap says
  // how much they are willing to give away; the floor says what they cannot
  // afford to — and a concession authorised in advance is exactly the path
  // where nobody is present to notice the difference.
  const floorClient = await plantClient('offer-floor');
  const floorProposal = await draftQuotation(floorClient.opp, floorClient.conv);
  await rest('PATCH', 'sales', `proposals?id=eq.${floorProposal}`, {
    document: {
      understanding: 'The client wants a delivery platform.',
      coveringNote: `${MARKER} — yeh raha quotation, neeche details hain.`,
      // ₹38,000 to build; ten per cent off ₹40,000 lands at ₹36,000.
      productionCost: { minimumRupees: 38000 },
    },
  });
  const belowFloor = one(await rest('POST', 'sales', 'rpc/apply_approved_offer', { p_proposal_id: floorProposal }));
  check(
    belowFloor?.outcome === 'below_floor',
    'an offer that would sell below the cost of building is refused',
    String(belowFloor?.outcome),
  );
  const untouched = one(await rest('GET', 'sales',
    `proposals?id=eq.${floorProposal}&select=status,discount_minor,applied_offer_id`));
  check(
    untouched?.status === 'draft' && Number(untouched?.discount_minor) === 0 && !untouched?.applied_offer_id,
    'and the refusal leaves the quotation exactly as it was — no half-applied discount',
    `${untouched?.status}, −${untouched?.discount_minor}`,
  );

  // Withdrawn, and the authority goes with it.
  const cleared = one(await rest('POST', 'sales', 'rpc/clear_approved_offer', { p_organization_id: ORG }));
  check(cleared?.outcome === 'cleared', 'the owner withdraws it', String(cleared?.outcome));
  const afterClient = await plantClient('offer-after');
  const afterProposal = await draftQuotation(afterClient.opp, afterClient.conv);
  const afterClear = one(await rest('POST', 'sales', 'rpc/apply_approved_offer', { p_proposal_id: afterProposal }));
  check(afterClear?.outcome === 'no_offer', 'and nothing is applied from that moment on', String(afterClear?.outcome));

  // ── 11 ───────────────────────────────────────────────────────────────────
  //
  // G-185, the audit's LM-B. The owner's corrections were never captured as
  // anything a next draft could read: G-180 records what they decided about a
  // PRICE, and nothing recorded what they DID to the quotation.
  console.log('\n11. What the owner changed, kept for the next quotation (G-185)');

  // Section 3 left v2 pending_approval, drafted from the owner's own note.
  // Approving it is the moment the correction becomes something to learn.
  const v2Request = one(await rest('GET', 'sales',
    `proposals?id=eq.${v2?.id}&select=approval_request_id`))?.approval_request_id;
  const approvedV2 = one(await decide(v2Request, 'approved', 'Yes, send this one.'));
  check(approvedV2?.outcome === 'decided', 'the owner approves the revision they asked for', String(approvedV2?.outcome));

  const learned = await tickUntil(async () => {
    const rows = (await rest('GET', 'ai',
      `memory_records?organization_id=eq.${ORG}&kind=eq.revision_decision&source_id=eq.${v2?.id}&select=fact,confidence,scope,scope_id,authored_by_agent,created_by`)).json ?? [];
    return rows.length > 0 ? rows[0] : null;
  });
  check(Boolean(learned), 'what the owner changed is recorded', learned ? 'recorded' : 'nothing recorded');
  check(
    String(learned?.fact ?? '').includes('after sending a quotation back'),
    'and the sentence says it came from a correction, not from a first draft',
    String(learned?.fact ?? '').slice(0, 60),
  );
  check(
    String(learned?.fact ?? '').includes('onboarding'),
    'naming the line the owner’s note actually added',
    String(learned?.fact ?? '').slice(0, 110),
  );
  check(
    !String(learned?.fact ?? '').includes(NOTE.slice(0, 24)),
    'and NOT their note — one client’s words must not ride into every future draft',
    'note absent',
  );
  check(
    learned?.scope === 'organization' && learned?.scope_id === null &&
      learned?.confidence === 'explicit' && learned?.authored_by_agent === null,
    'organization-scoped, explicit, and written by no agent — a record of a person’s decision',
    `${learned?.scope}/${learned?.confidence}`,
  );
  check(learned?.created_by === ownerId, 'credited to the person who decided it', String(learned?.created_by).slice(0, 8));

  // Both lessons, and they are different sentences about the same approval.
  const priced = one(await rest('GET', 'ai',
    `memory_records?organization_id=eq.${ORG}&kind=eq.pricing_decision&source_id=eq.${v2?.id}&select=fact`));
  check(Boolean(priced), 'the pricing lesson is written too — they are separate lessons', priced ? 'both' : 'only one');

  // Once. The event can be re-dispatched and the job retried; neither should
  // double the weight of one correction in what the agency believes.
  await tick(); await tick();
  const copies = (await rest('GET', 'ai',
    `memory_records?organization_id=eq.${ORG}&kind=eq.revision_decision&source_id=eq.${v2?.id}&select=id`)).json ?? [];
  check(copies.length === 1, 'exactly once, however many times the event arrives', `${copies.length} row(s)`);

  /**
   * And a v2 the owner NEVER sent back teaches nothing.
   *
   * The condition the whole handler turns on. Without it every second version
   * would be filed as the owner's correction — including the ones a CLIENT
   * asked for — and the agency would learn to pre-empt requests its owner
   * never made. Asked of the handler itself rather than of the row count,
   * because "no memory" is also what a broken handler produces.
   */
  const straight = await plantClient('straight-v2');
  const quoteS = await submitQuotation(straight.opp, straight.conv);
  check(one(await decide(quoteS.requestId, 'approved', 'Fine.'))?.outcome === 'decided', 'a first version is approved outright');

  // Drained BEFORE the second version is drafted, deliberately: drafting v2
  // supersedes v1, and a job that runs afterwards answers `not_standing` — a
  // true statement about a different rule, and the reason this fixture reports
  // its outcomes in two halves rather than one.
  const firstVersionOutcomes = [];
  for (let i = 0; i < 4; i += 1) {
    const { json } = await tick();
    for (const row of json?.revisionLessons ?? []) firstVersionOutcomes.push(row.outcome);
  }
  check(
    firstVersionOutcomes.includes('not_a_revision'),
    'a first version approved outright teaches no correction — nothing to compare it with',
    firstVersionOutcomes.length > 0 ? firstVersionOutcomes.join(', ') : 'no revision lesson job reported an outcome',
  );

  const handV2 = one(await rest('POST', 'sales', 'rpc/draft_proposal', {
    p_opportunity_id: straight.opp.id, p_title: `${MARKER} a second version nobody asked for`,
  }));
  await rest('POST', 'sales', 'rpc/add_proposal_item', {
    p_proposal_id: handV2.proposal_id, p_description: 'Customer app', p_unit_price_minor: 4000000,
  });
  const submittedV2 = one(await rest('POST', 'sales', 'rpc/submit_proposal', { p_proposal_id: handV2.proposal_id }));
  check(submittedV2?.outcome === 'submitted', 'and a second version is drafted for another reason entirely', String(submittedV2?.outcome));
  await decide(submittedV2.request_id, 'approved', 'Send it.');

  const revisionOutcomes = [];
  for (let i = 0; i < 5; i += 1) {
    const { json } = await tick();
    for (const row of json?.revisionLessons ?? []) revisionOutcomes.push(row.outcome);
  }
  check(
    revisionOutcomes.includes('not_sent_back'),
    'the SENT-BACK rule is what refuses it — asked of the handler, not inferred from an empty table',
    revisionOutcomes.length > 0 ? revisionOutcomes.join(', ') : 'no revision lesson job reported an outcome',
  );
  const nothing = (await rest('GET', 'ai',
    `memory_records?organization_id=eq.${ORG}&kind=eq.revision_decision&source_id=eq.${handV2.proposal_id}&select=id`)).json ?? [];
  check(nothing.length === 0, 'and nothing was recorded from it', `${nothing.length} row(s)`);

} finally {
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: savedSettings });
  /**
   * G-180 — the lessons this run taught the agency are this run's fixtures.
   *
   * EXPIRED, not deleted, and the database is what settled that: a memory
   * refuses DELETE outright — *"a memory is superseded, never deleted (Doc 05
   * §32)"* — so the first version of this cleanup answered 23514 on every run
   * and left every row behind. That matters more here than tidiness: a
   * leftover pricing decision is recalled into the NEXT script's drafting
   * prompt, which is the one place a stray fixture can change what a model
   * writes.
   *
   * `ai.recall` drops anything past its `expires_at`, so an expiry is the
   * sanctioned way to retire a memory — and it keeps the history the table
   * exists to keep.
   */
  await rest('PATCH', 'ai', `memory_records?organization_id=eq.${ORG}&kind=in.(pricing_decision,revision_decision)&expires_at=is.null`, {
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  });
  for (const kind of ['proposal.dispatch', 'quotation.revise', 'quotation.rework', 'approval.announce', 'quotation.scope', 'quotation.learn', 'quotation.learnrevision', 'offer.announce']) {
    await rest('DELETE', 'core', `jobs?kind=eq.${kind}`);
  }
  const pending = (await rest('GET', 'approvals', `approval_requests?state=eq.pending&select=id`)).json ?? [];
  for (const row of pending) {
    await rest('PATCH', 'approvals', `approval_requests?id=eq.${row.id}`, {
      state: 'cancelled', decided_at: new Date().toISOString(), decision_note: `${MARKER} cleanup`,
    });
  }
  await rest('DELETE', 'core', 'outbox_events?subject_type=eq.approval_request');
  await rest('DELETE', 'core', 'outbox_events?subject_type=eq.proposal');
  await rest('DELETE', 'core', 'outbox_events?subject_type=eq.objection');
  await rest('DELETE', 'sales', `approved_offers?organization_id=eq.${ORG}&label=like.${MARKER}*`);
  await rest('DELETE', 'crm', `conversations?organization_id=eq.${ORG}&kind=eq.internal_direct&title=like.${MARKER}*`);
  for (const id of made.organizations.filter(Boolean)) {
    await rest('DELETE', 'core', `organizations?id=eq.${id}`);
  }
  for (const id of made.policies) await rest('DELETE', 'approvals', `approval_policies?id=eq.${id}`);
  for (const id of made.opportunities) await rest('DELETE', 'sales', `opportunities?id=eq.${id}`);
  for (const id of made.conversations) await rest('DELETE', 'crm', `conversations?id=eq.${id}`);
  for (const id of made.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  for (const id of made.contacts) await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
  if (ownerId) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${ownerId}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${ownerId}`, {
      method: 'DELETE',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      cache: 'no-store',
    }).catch(() => {});
  }
  await new Promise((resolve) => graph.close(resolve));
  await new Promise((resolve) => model.close(resolve));
}

console.log(`\n${failures === 0 ? '\x1b[32m✔' : '\x1b[31m✖'} ${checks - failures}/${checks} checks passed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
