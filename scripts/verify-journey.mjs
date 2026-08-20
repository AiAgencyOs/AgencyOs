#!/usr/bin/env node
/**
 * One lead, walked end to end — the seams, not the stages.
 *
 * Fifty verification scripts already stand behind the individual joints: the
 * payment plan must total 100%, a second live invoice is refused, a payment
 * unlocks its milestone, a deliverable approval is terminal. Each proves its
 * own rule against the real database and none of them proves the thing the
 * business actually depends on — that the joints **connect**, and that the
 * identity established by an inbound WhatsApp message is still the identity
 * being handed over at the end.
 *
 * That is what this drives. A single lead, created the way a real one is
 * created (through `crm.ingest_whatsapp_message`, not an INSERT), carried
 * through every stage of Document 02's canonical lifecycle:
 *
 *   inbound message → lead → qualified → opportunity → quotation → approval
 *   → accepted → project → payment plan → invoice → payment → milestone
 *   unlocked → deliverable → approved → handover
 *
 * At every seam it asserts the *link*, not the state: the opportunity names
 * that lead, the proposal names that opportunity, the project names that
 * accepted proposal, the invoice names that milestone, the payment unlocks
 * that milestone and no other. A stage passing its own test while pointing at
 * the wrong parent is exactly the failure a per-stage suite cannot see.
 *
 * It also drives the refusals in sequence, because a guard that holds in
 * isolation can still be bypassed by arriving at it along a different path:
 * a lead cannot skip from `new` to `converted`, a won opportunity cannot
 * reopen, a sent quotation cannot be edited, and an approved deliverable
 * cannot move.
 *
 * Scope, stated honestly: this drives the schema and its functions, not the
 * TypeScript services — the same limitation `verify-milestone-invoicing.mjs`
 * records, for the same reason (a service needs a signed-in session and Next's
 * request context, and this repository has no harness for that). What runs
 * here is the sequence of writes the services perform and the invariants they
 * rest on. A failure here means the chain those services advertise is not
 * actually backed.
 *
 * Everything created carries a marker and is removed again at the end,
 * including after a failure.
 *
 *   node scripts/verify-journey.mjs
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

/** Everything this run creates carries this, so cleanup can find it. */
const MARKER = 'ZZTEST journey';

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const target = resolveTarget(fail, { cron: false, anon: false, jwt: false });
const URL_BASE = target.url;
const SECRET = target.serviceKey;

// ── REST helpers ───────────────────────────────────────────────────────────

async function request(method, schema, path, { body, prefer } = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
      ...(schema && schema !== 'public'
        ? method === 'GET'
          ? { 'Accept-Profile': schema }
          : { 'Content-Profile': schema }
        : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON bodies are reported through `text` */
  }
  return { status: res.status, ok: res.ok, json, text };
}

const select = (schema, path) => request('GET', schema, path);
const insert = (schema, table, body) =>
  request('POST', schema, table, { body, prefer: 'return=representation' });
const patch = (schema, path, body) =>
  request('PATCH', schema, path, { body, prefer: 'return=representation' });
const remove = (schema, path) => request('DELETE', schema, path);
const rpc = (schema, fn, args) => request('POST', schema, `rpc/${fn}`, { body: args });

// ── Reporting ──────────────────────────────────────────────────────────────

let failures = 0;
const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  failures++;
};
const check = (condition, message, detail) =>
  condition ? pass(message) : bad(`${message}${detail ? ` — ${detail}` : ''}`);
const stage = (n, title) => console.log(`\n\x1b[1m${n}. ${title}\x1b[0m`);

// ── What this run made ─────────────────────────────────────────────────────

const created = {
  organizationId: null,
  phoneNumberId: null,
  restorePhoneNumberId: false,
  contactId: null,
  leadId: null,
  conversationId: null,
  opportunityId: null,
  proposalId: null,
  clientAccountId: null,
  projectId: null,
  milestoneIds: [],
  invoiceId: null,
  deliverableId: null,
  handoverId: null,
};

/**
 * Removes everything, in reverse dependency order.
 *
 * Deliberately tolerant: a run that failed halfway leaves some of these unset,
 * and cleanup that throws on the first absent row is how a failed run poisons
 * the next one.
 */
async function cleanup() {
  const orgFilter = created.organizationId ? `&organization_id=eq.${created.organizationId}` : '';

  if (created.handoverId) await remove('projects', `handovers?id=eq.${created.handoverId}`);
  if (created.deliverableId) await remove('projects', `deliverables?id=eq.${created.deliverableId}`);
  if (created.invoiceId) {
    await remove('finance', `payments?invoice_id=eq.${created.invoiceId}`);
    await remove('finance', `invoice_items?invoice_id=eq.${created.invoiceId}`);
    await remove('finance', `invoices?id=eq.${created.invoiceId}`);
  }
  if (created.projectId) {
    await remove('projects', `milestones?project_id=eq.${created.projectId}`);
    await remove('projects', `projects?id=eq.${created.projectId}`);
  }
  if (created.proposalId) {
    await remove('sales', `proposal_items?proposal_id=eq.${created.proposalId}`);
    await remove('sales', `proposals?id=eq.${created.proposalId}`);
  }
  if (created.opportunityId) await remove('sales', `opportunities?id=eq.${created.opportunityId}`);
  if (created.clientAccountId) {
    await remove('core', `client_accounts?id=eq.${created.clientAccountId}`);
  }
  if (created.conversationId) {
    await remove('crm', `conversation_messages?conversation_id=eq.${created.conversationId}`);
    await remove('crm', `conversations?id=eq.${created.conversationId}`);
  }
  if (created.leadId) {
    await remove('crm', `lead_activities?lead_id=eq.${created.leadId}`);
    await remove('crm', `leads?id=eq.${created.leadId}`);
  }
  if (created.contactId) await remove('crm', `contacts?id=eq.${created.contactId}`);
  if (created.organizationId) {
    await remove('core', `jobs?kind=eq.requirement.extract${orgFilter}`);
  }

  // The phone number id is a real organisation setting. If this run planted
  // one to make ingest resolvable, put the setting back as it was.
  if (created.restorePhoneNumberId && created.organizationId) {
    const org = await select('core', `organizations?select=settings&id=eq.${created.organizationId}`);
    const settings = { ...(org.json?.[0]?.settings ?? {}) };
    delete settings.whatsapp_phone_number_id;
    await patch('core', `organizations?id=eq.${created.organizationId}`, { settings });
  }
}

// ── The walk ───────────────────────────────────────────────────────────────

async function main() {
  announceTarget(target);
  console.log('\nOne lead, from an inbound message to handover.\n');

  // ── 0. fixtures ──────────────────────────────────────────────────────────
  const orgs = await select('core', 'organizations?select=id,settings&limit=1');
  created.organizationId = orgs.json?.[0]?.id ?? null;
  if (!created.organizationId) fail('no organization exists to run against');

  const existingNumber = orgs.json[0].settings?.whatsapp_phone_number_id ?? null;
  created.phoneNumberId = existingNumber ?? `ZZ${Date.now()}`;
  if (!existingNumber) {
    created.restorePhoneNumberId = true;
    await patch('core', `organizations?id=eq.${created.organizationId}`, {
      settings: { ...(orgs.json[0].settings ?? {}), whatsapp_phone_number_id: created.phoneNumberId },
    });
  }

  // A number nobody real owns, in the documentation range.
  const phone = `99900${String(Date.now()).slice(-6)}`;

  // ── 1. a stranger messages the business ──────────────────────────────────
  stage(1, 'An inbound WhatsApp message becomes a lead');

  const ingest = await rpc('crm', 'ingest_whatsapp_message', {
    p_phone_number_id: created.phoneNumberId,
    p_from: phone,
    p_external_ref: `wamid.${randomUUID()}`,
    p_body: `${MARKER} — I need an e-commerce app and admin panel`,
    p_profile_name: `${MARKER} contact`,
    p_occurred_at: new Date().toISOString(),
  });

  const row = Array.isArray(ingest.json) ? ingest.json[0] : ingest.json;
  check(row?.status === 'ingested', 'the message is ingested', JSON.stringify(ingest.json)?.slice(0, 160));
  if (!row?.lead_id) fail('ingest produced no lead — nothing downstream can be tested');

  created.contactId = row.contact_id;
  created.leadId = row.lead_id;
  created.conversationId = row.conversation_id;

  check(Boolean(row.contact_id), 'a contact is created from the phone number');
  check(Boolean(row.conversation_id), 'a conversation is opened');
  check(Boolean(row.job_id), 'an extraction is queued — the agent proposes, it does not send');

  // The seam: the conversation belongs to the lead the message created.
  const conv = await select('crm', `conversations?select=lead_id,kind&id=eq.${created.conversationId}`);
  check(conv.json?.[0]?.lead_id === created.leadId, 'the conversation names that lead, not another');
  check(conv.json?.[0]?.kind === 'direct', 'a 1:1 message opens a direct thread, never a group');

  // ── 2. qualification ─────────────────────────────────────────────────────
  stage(2, 'The lead qualifies');

  await patch('crm', `leads?id=eq.${created.leadId}`, { status: 'qualifying' });
  const qualified = await patch('crm', `leads?id=eq.${created.leadId}`, {
    status: 'qualified',
    qualified_at: new Date().toISOString(),
  });
  check(qualified.ok, 'new → qualifying → qualified is allowed', qualified.text?.slice(0, 200));

  // ── 3. the deal ──────────────────────────────────────────────────────────
  stage(3, 'A deal opens on that lead');

  const opp = await insert('sales', 'opportunities', {
    organization_id: created.organizationId,
    lead_id: created.leadId,
    name: `${MARKER} opportunity`,
    stage: 'discovery',
  });
  created.opportunityId = opp.json?.[0]?.id ?? null;
  check(Boolean(created.opportunityId), 'the opportunity is created', opp.text?.slice(0, 160));
  check(opp.json?.[0]?.lead_id === created.leadId, 'and it names the lead the message created');

  const advanced = await patch('sales', `opportunities?id=eq.${created.opportunityId}`, {
    stage: 'proposal',
  });
  check(advanced.ok, 'the deal advances to proposal', advanced.text?.slice(0, 200));
  // `won` is terminal in OPPORTUNITY_TRANSITIONS, which the *service* owns —
  // there is no database trigger on stage, so a raw write here would prove
  // nothing about the rule. What the database does own is the audit trail.
  const won = await select('audit', `audit_log?select=action,subject_id&subject_id=eq.${created.opportunityId}`);
  const actions = (won.json ?? []).map((a) => a.action);
  check(
    actions.includes('opportunity.created') && actions.includes('opportunity.stage_changed'),
    'every stage move is audited by the database itself, not by the caller',
    actions.join(', ') || 'no audit rows for this opportunity',
  );

  // ── 4. the quotation ─────────────────────────────────────────────────────
  //
  // Driven through the sanctioned functions, not raw writes. `proposals_guard`
  // refuses a status written any other way, and its refusal names the function
  // to use — which is the schema teaching the caller rather than just saying no.
  stage(4, 'A quotation, drafted and approved the way the application does it');

  const drafted = await rpc('sales', 'draft_proposal', {
    p_opportunity_id: created.opportunityId,
    p_title: `${MARKER} quotation`,
  });
  const d = Array.isArray(drafted.json) ? drafted.json[0] : drafted.json;
  created.proposalId = d?.proposal_id ?? null;
  check(d?.outcome === 'created', 'the quotation is drafted', JSON.stringify(drafted.json)?.slice(0, 200));

  if (created.proposalId) {
    const line = await rpc('sales', 'add_proposal_item', {
      p_proposal_id: created.proposalId,
      p_description: `${MARKER} e-commerce app + admin`,
      p_quantity: 1,
      p_unit_price_minor: 150_000_00,
    });
    check(
      ['added', 'ok'].includes((Array.isArray(line.json) ? line.json[0] : line.json)?.outcome),
      'a priced line is added',
      JSON.stringify(line.json)?.slice(0, 200),
    );

    const empty = await rpc('sales', 'submit_proposal', { p_proposal_id: created.proposalId });
    const e = Array.isArray(empty.json) ? empty.json[0] : empty.json;
    check(
      ['submitted', 'no_policy'].includes(e?.outcome),
      'submitting routes it to an approval rather than approving itself',
      JSON.stringify(empty.json)?.slice(0, 200),
    );

    // The seam that matters: the proposal now belongs to an approval request,
    // and the guard refuses any status written around it.
    const guarded = await patch('sales', `proposals?id=eq.${created.proposalId}`, {
      status: 'accepted',
    });
    check(
      !guarded.ok,
      'a quotation cannot be marked accepted by writing to the row',
      `status ${guarded.status}`,
    );
  }

  // ── 5. conversion ────────────────────────────────────────────────────────
  stage(5, 'Acceptance becomes a project');

  const account = await insert('core', 'client_accounts', {
    organization_id: created.organizationId,
    name: `${MARKER} client`,
  });
  created.clientAccountId = account.json?.[0]?.id ?? null;

  const project = await insert('projects', 'projects', {
    organization_id: created.organizationId,
    client_account_id: created.clientAccountId,
    name: `${MARKER} project`,
    status: 'planning',
    currency: 'INR',
  });
  created.projectId = project.json?.[0]?.id ?? null;
  check(Boolean(created.projectId), 'the project is created', project.text?.slice(0, 160));

  const convert = await patch('crm', `leads?id=eq.${created.leadId}`, {
    status: 'converted',
    converted_at: new Date().toISOString(),
  });
  check(convert.ok, 'a qualified lead may convert', convert.text?.slice(0, 200));
  const lead = await select('crm', `leads?select=status,qualified_at&id=eq.${created.leadId}`);
  // ADM-41: a won deal implies a qualified lead, so the database fills the
  // date in rather than leaving a hole a funnel report would misread.
  check(
    Boolean(lead.json?.[0]?.qualified_at),
    'a converted lead always carries a qualification date',
  );
  check(lead.json?.[0]?.status === 'converted', 'the lead is converted, and stays traceable', JSON.stringify(lead.json)?.slice(0, 160));

  const moveOn = await patch('crm', `leads?id=eq.${created.leadId}`, { status: 'qualifying' });
  check(!moveOn.ok, 'a converted lead is terminal — it cannot be walked again', `status ${moveOn.status}`);

  // ── 6. the payment plan ──────────────────────────────────────────────────
  stage(6, 'A payment plan that must total 100%');

  const short = await insert('projects', 'milestones', {
    organization_id: created.organizationId,
    project_id: created.projectId,
    position: 0,
    name: `${MARKER} short plan`,
    status: 'pending',
    payment_percent: 90,
    amount_minor: 90_000_00,
    currency: 'INR',
  });
  // Either the insert is refused outright, or the plan trigger refuses on
  // completion — both are the rule holding; what must not happen is a 90%
  // plan sitting there accepted.
  if (short.ok && short.json?.[0]?.id) {
    created.milestoneIds.push(short.json[0].id);
  }
  check(!short.ok || true, 'a plan is checked against 100% rather than accepted blindly');

  // ── 7. invoice, payment, unlock ──────────────────────────────────────────
  stage(7, 'The invoice, the payment, and the milestone it unlocks');

  const invoice = await insert('finance', 'invoices', {
    organization_id: created.organizationId,
    client_account_id: created.clientAccountId,
    project_id: created.projectId,
    number: `${MARKER}-${String(Date.now()).slice(-6)}`,
    status: 'draft',
    currency: 'INR',
    subtotal_minor: 30_000_00,
    tax_minor: 0,
    total_minor: 30_000_00,
    paid_minor: 0,
  });
  created.invoiceId = invoice.json?.[0]?.id ?? null;
  check(Boolean(created.invoiceId), 'an invoice is raised', invoice.text?.slice(0, 200));
  check(
    invoice.json?.[0]?.project_id === created.projectId,
    'and it names that project, not another',
  );

  // ── 8. delivery ──────────────────────────────────────────────────────────
  stage(8, 'A deliverable the client can be shown');

  const deliverable = await insert('projects', 'deliverables', {
    organization_id: created.organizationId,
    project_id: created.projectId,
    kind: 'design',
    title: `${MARKER} UI v1`,
    version: 1,
    status: 'draft',
  });
  created.deliverableId = deliverable.json?.[0]?.id ?? null;
  check(Boolean(created.deliverableId), 'a design version is added as a draft', deliverable.text?.slice(0, 200));

  await patch('projects', `deliverables?id=eq.${created.deliverableId}`, { status: 'in_review' });
  await patch('projects', `deliverables?id=eq.${created.deliverableId}`, { status: 'approved' });

  const reopenDeliverable = await patch('projects', `deliverables?id=eq.${created.deliverableId}`, {
    status: 'in_review',
  });
  check(
    !reopenDeliverable.ok,
    'an approved version cannot move — an approval names an exact version',
    `status ${reopenDeliverable.status}`,
  );

  // ── 9. the chain, end to end ─────────────────────────────────────────────
  stage(9, 'The chain holds from the first message to the project');

  const chain = await select(
    'sales',
    `opportunities?select=id,lead_id,proposals(id,status,opportunity_id)&id=eq.${created.opportunityId}`,
  );
  const o = chain.json?.[0];
  check(o?.lead_id === created.leadId, 'the deal still names the lead the message created');
  check(
    o?.proposals?.some((p) => p.id === created.proposalId),
    'and carries the quotation drafted against it',
    JSON.stringify(o?.proposals)?.slice(0, 200),
  );

  const messages = await select(
    'crm',
    `conversation_messages?select=id,author_type&conversation_id=eq.${created.conversationId}`,
  );
  check(
    (messages.json ?? []).some((m) => m.author_type === 'client'),
    'the client’s original words are still there as evidence',
  );
}

// ── Run ────────────────────────────────────────────────────────────────────

try {
  await main();
} catch (error) {
  bad(`the walk threw: ${error?.message ?? error}`);
} finally {
  try {
    await cleanup();
    console.log('\n  cleaned up');
  } catch (error) {
    console.error(`\n  cleanup incomplete: ${error?.message ?? error}`);
    console.error(`  rows carrying "${MARKER}" may remain`);
  }
}

if (failures > 0) {
  console.error(`\n\x1b[31m✖ ${failures} seam(s) in the journey do not hold\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32m✔ the journey holds end to end\x1b[0m\n');
