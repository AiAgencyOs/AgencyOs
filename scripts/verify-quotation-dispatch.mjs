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

const made = { leads: [], contacts: [], conversations: [], opportunities: [], policies: [] };
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
  if (via === 'conversation') {
    await rest('PATCH', 'sales', `proposals?id=eq.${drafted.proposal_id}`, { conversation_id: conv.id });
  }
  const submitted = one(await rest('POST', 'sales', 'rpc/submit_proposal', {
    p_proposal_id: drafted.proposal_id,
  }));
  return { proposalId: drafted.proposal_id, requestId: submitted?.request_id, outcome: submitted?.outcome };
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
  for (let i = 0; i < 4; i += 1) {
    const { json } = await tick();
    for (const row of json?.lessons ?? []) lessonOutcomes.push(row.outcome);
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
  console.log('\n7. A PRICE objection never reworks anything — negotiation is a person’s (ADM-22)');
  const priceAsk = one(await rest('POST', 'sales', 'objections', {
    organization_id: ORG, lead_id: a.lead.id, message_id: pushback?.id,
    round: 2, proposal_id: v2FromAsk?.id, kind: 'price',
    concern: 'Just make the same thing cheaper.',
    raised_by_agent: 'sales',
  }));
  check(Boolean(priceAsk?.id), 'the price push is recorded as an objection', priceAsk?.id ? 'recorded' : 'refused');
  for (let i = 0; i < 6; i += 1) await tick();
  const reworkJobs = (await rest('GET', 'core',
    `jobs?kind=eq.quotation.rework&payload->>subjectId=eq.${priceAsk?.id}&select=id`)).json ?? [];
  check(reworkJobs.length === 0, 'no rework job is even PLANNED — the plan-time filter refuses the kind', `${reworkJobs.length} job(s)`);
  const versionsAfter = (await rest('GET', 'sales',
    `proposals?opportunity_id=eq.${a.opp.id}&select=id`)).json ?? [];
  check(versionsAfter.length === 2, 'and no version moved — the agent does not lower a number under pressure', `${versionsAfter.length} version(s)`);

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
  await rest('PATCH', 'ai', `memory_records?organization_id=eq.${ORG}&kind=eq.pricing_decision&expires_at=is.null`, {
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  });
  for (const kind of ['proposal.dispatch', 'quotation.revise', 'quotation.rework', 'approval.announce', 'quotation.scope', 'quotation.learn']) {
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
