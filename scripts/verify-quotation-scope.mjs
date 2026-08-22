/**
 * The scope is the agent's. The price is not — Document 09 §15, ADM-22.
 *
 * The quotation loop has existed since G-011: a person drafts, prices, submits,
 * the owner approves, then it is sent. What is new is §15's other half —
 * *"quote generation is assisted by AI"* — and the only interesting question
 * about it is what the assistance is NOT allowed to do.
 *
 *   A. accepting requirements asks the agent for a scope
 *   B. it writes the lines, and every one of them is worth zero
 *   C. and says who drafted it, which nothing has ever recorded
 *   D. a price from a caller nobody can name is refused at the row
 *   E. …while a person may price the very same line
 *   F. requirements nobody accepted are not quoted from
 *   G. a lead with no open deal is left alone, not given one
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
await announceTarget(target, 'the scope is the agent’s, the price is not');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const APP = target.appUrl ?? 'http://localhost:3000';
const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-quote-${randomUUID().slice(0, 8)}`;
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
 * What the stub answers for a scope.
 *
 * Deliberately contains no number anywhere: the schema has no field for one,
 * so a stub that tried to send a price would be testing the schema rather than
 * the row rule. The row rule is exercised directly in D instead, which is the
 * only way to reach it.
 */
const SCOPE = {
  title: 'Delivery app — customer, driver and admin',
  items: [
    { description: 'Customer app: signup, browse restaurants, order, track delivery' },
    { description: 'Driver app: registration, accept jobs, navigation, mark delivered' },
    { description: 'Admin panel: restaurants, drivers, orders, payouts' },
    { description: 'Payment gateway integration' },
  ],
  summary:
    'Covers the three apps and payments as discussed. Does not cover marketing, ' +
    'content, or the restaurant-side app, which were not part of the requirements.',
};

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

console.log('\n\x1b[1mAgencyOS — the scope is the agent’s, the price is not\x1b[0m');

const made = { leads: [], contacts: [], conversations: [], opportunities: [] };

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
  // ── A, B, C ──────────────────────────────────────────────────────────────
  console.log('\nA–C. Accepted requirements become a scope, at zero, with a name on it');
  const deal = await plantLead('quoted');
  const opp = one(await rest('POST', 'sales', 'opportunities', {
    organization_id: ORG, lead_id: deal.lead.id, name: `${MARKER} deal`, stage: 'discovery',
  }));
  made.opportunities.push(opp.id);

  const version = await acceptVersion(deal.conv);
  check(Boolean(version?.id), 'an accepted requirement version exists', version?.status);

  const proposal = await tickUntil(async () =>
    one(await rest('GET', 'sales',
      `proposals?requirement_version_id=eq.${version.id}&select=id,version,status,title,body,generated_by_run_id,total_minor`)));
  check(Boolean(proposal?.id), 'the agent drafted a quotation from them', proposal ? `v${proposal.version}` : 'none');
  check(proposal?.status === 'draft', 'as a DRAFT — a person prices it, the owner approves it', String(proposal?.status));
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
    items.every((i) => i.unit_price_minor === 0 && i.amount_minor === 0),
    'and every one is worth ZERO — ADM-22 leaves the number to a person',
    items.map((i) => i.unit_price_minor).join(','),
  );
  check(proposal?.total_minor === 0, 'so the quotation totals nothing until somebody prices it', String(proposal?.total_minor));
  check(
    Boolean(proposal?.generated_by_run_id),
    'and it says which agent run drafted it — the column existed for years and nothing wrote it',
    proposal?.generated_by_run_id ? 'stamped' : 'null',
  );

  // ── D ────────────────────────────────────────────────────────────────────
  console.log('\nD. A price from a caller nobody can name is refused at the row');
  const priced = await rest('POST', 'sales', 'proposal_items', {
    organization_id: ORG, proposal_id: proposal.id, position: 99,
    description: `${MARKER} smuggled`, quantity: 1, unit_price_minor: 250000, amount_minor: 250000,
  });
  check(!priced.ok, 'the service role cannot put a number on an agent-drafted quotation', `status ${priced.status}`);
  check(
    /ADM-22|no identity/i.test(priced.text),
    'and is told why, in the words of the rule',
    String(priced.json?.message ?? priced.text).slice(0, 70),
  );

  const zeroLine = await rest('POST', 'sales', 'proposal_items', {
    organization_id: ORG, proposal_id: proposal.id, position: 98,
    description: `${MARKER} unpriced`, quantity: 1, unit_price_minor: 0, amount_minor: 0,
  });
  check(zeroLine.ok, 'while a line at zero is exactly what the agent writes, and passes', `status ${zeroLine.status}`);

  // ── E ────────────────────────────────────────────────────────────────────
  console.log('\nE. …and the rule is about identity, not about quotations');
  // Its own lead and its own deal: `proposals_live_version_key` allows one
  // live version per opportunity, and the agent's is already it. Drafted
  // through `sales.draft_proposal` with no run id, which is exactly what a
  // person typing one produces.
  const typed = await plantLead('typed');
  const oppC = one(await rest('POST', 'sales', 'opportunities', {
    organization_id: ORG, lead_id: typed.lead.id, name: `${MARKER} deal c`, stage: 'discovery',
  }));
  made.opportunities.push(oppC.id);
  const humanDraftRow = one(await rest('POST', 'sales', 'rpc/draft_proposal', {
    p_opportunity_id: oppC.id, p_title: `${MARKER} typed by a person`,
  }));
  check(
    humanDraftRow?.outcome === 'created' && !humanDraftRow?.generated_by_run_id,
    'a person’s draft carries no run id, which is what makes the two distinguishable',
    String(humanDraftRow?.outcome),
  );
  const humanDraft = { id: humanDraftRow?.proposal_id };
  const humanPriced = await rest('POST', 'sales', 'proposal_items', {
    organization_id: ORG, proposal_id: humanDraft.id, position: 0,
    description: `${MARKER} priced`, quantity: 1, unit_price_minor: 250000, amount_minor: 250000,
  });
  check(
    humanPriced.ok,
    'a quotation no agent drafted is priced as before — nothing a person could do has changed',
    `status ${humanPriced.status} ${String(humanPriced.json?.message ?? '').slice(0, 80)}`,
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
  console.log('\nG. A lead with no open deal is left alone, not given one');
  const dealless = await plantLead('dealless');
  const orphanVersion = await acceptVersion(dealless.conv);
  for (let i = 0; i < 8; i += 1) await tick();
  const invented = (await rest('GET', 'sales',
    `opportunities?lead_id=eq.${dealless.lead.id}&select=id`)).json ?? [];
  check(invented.length === 0, 'no deal is opened — that is a sales act with an owner and a pipeline position', `${invented.length} deal(s)`);
  const orphanQuote = (await rest('GET', 'sales',
    `proposals?requirement_version_id=eq.${orphanVersion.id}&select=id`)).json ?? [];
  check(orphanQuote.length === 0, 'and nothing is quoted against nothing');

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
    'a second draft would supersede one somebody may already be pricing',
    `${beforeAgain.length} → ${afterAgain.length}`,
  );

  check(modelCalls > 0, 'the model was genuinely called', `${modelCalls} call(s)`);
} finally {
  await rest('DELETE', 'core', 'jobs?kind=eq.quotation.scope');
  for (const id of made.opportunities) await rest('DELETE', 'sales', `opportunities?id=eq.${id}`);
  for (const id of made.conversations) await rest('DELETE', 'crm', `conversations?id=eq.${id}`);
  for (const id of made.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  for (const id of made.contacts) await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
  await new Promise((resolve) => model.close(resolve));
}

console.log(`\n${failures === 0 ? '\x1b[32m✔' : '\x1b[31m✖'} ${checks - failures}/${checks} checks passed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
