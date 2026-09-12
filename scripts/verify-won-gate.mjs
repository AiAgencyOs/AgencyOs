// ═══════════════════════════════════════════════════════════════════════════
// A deal that is won says what was won — G-230
//
// `setOpportunityStage` checked a legal transition and nothing else, so a deal
// reached `won` — the state that creates a client, a project and an invoice
// schedule — with no accepted quotation behind it. The LOSING path already
// asked for more: `opportunities_lost_says_why` refuses a lost deal with no
// category and no sentence, AT THE ROW.
//
// This drives the row's half against a real Postgres, through raw PostgREST
// rather than through the service, because the service's refusal is a message
// and the trigger's refusal is the guarantee. A control tested only through
// the layer that also holds it is half a check.
//
// SELF-RED-PROVING in the sense the refusal sections below assert a REFUSAL —
// drop `opportunities_won_gate` and those updates succeed instead, turning the
// run red — and the others are their positive twins (an accepted quotation
// passes; a deal already won is left alone). It does NOT probe pg_trigger — an earlier header said it did, and it
// did not; §0 only proves the verdict FUNCTION answers, which is a weaker
// fact and is described as one.
//
// Every quotation here walks the governed path — draft, items, submit, the
// owner approves, send, the client accepts — through scripts/verify-fixtures.mjs.
// The first draft inserted proposals already `accepted`, which
// sales.proposals_guard refuses, so every check downstream of it was passing
// for the wrong reason. Found by review.
//
//   node scripts/verify-won-gate.mjs
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { fixturesFor } from './verify-fixtures.mjs';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'a deal is won on an accepted quotation, not on a button');

const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-won-${randomUUID().slice(0, 8)}`;
const fx = fixturesFor(target, ORG);
const { rest, one } = fx;

let failures = 0;
let checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

const rpc = (schema, fn, args) => rest('POST', schema, `rpc/${fn}`, args);

/** Ask the verdict function directly. */
async function verdict(opportunityId) {
  const r = await rpc('sales', 'won_gate_verdict', { p_opportunity_id: opportunityId });
  return typeof r.json === 'string' ? r.json : (r.json ?? null);
}

/** Try to close a deal through raw PostgREST — the service is not involved. */
const tryWin = (opportunityId) =>
  rest('PATCH', 'sales', `opportunities?id=eq.${opportunityId}`, { stage: 'won', closed_at: new Date().toISOString() });

const stageOf = async (id) => one(await rest('GET', 'sales', `opportunities?id=eq.${id}&select=stage`))?.stage;

const created = { leads: [], opportunities: [], approvals: [] };

async function newDeal(name, stage = 'negotiation') {
  const lead = one(await rest('POST', 'crm', 'leads', {
    organization_id: ORG, source: 'manual', title: `${MARKER} ${name}`, status: 'new',
  }));
  created.leads.push(lead.id);
  const opportunity = one(await rest('POST', 'sales', 'opportunities', {
    organization_id: ORG, lead_id: lead.id, name: `${MARKER} ${name}`, stage, value_minor: 100000, currency: 'INR',
  }));
  created.opportunities.push(opportunity.id);
  return opportunity.id;
}

const setSetting = (key, value) =>
  rpc('core', 'set_organization_setting', { p_organization_id: ORG, p_key: key, p_value: value });

console.log('\n\x1b[1mAgencyOS — a deal that is won says what was won (G-230)\x1b[0m');

let owner;
try {
  owner = await fx.bootstrapOwner(MARKER);
  await fx.installProposalPolicy(owner);

  // ── 0. the verdict function answers ─────────────────────────────────────
  console.log('\n0. The verdict function is installed and answers');
  {
    const v = await verdict(await newDeal('probe', 'discovery'));
    check(v === 'no_accepted_quotation', 'sales.won_gate_verdict answers for a deal with no quotation', `verdict ${JSON.stringify(v)}`);
  }

  // ── 1. the mandatory half ────────────────────────────────────────────────
  console.log('\n1. A deal with no accepted quotation cannot be won');
  {
    const deal = await newDeal('bare');
    const refused = await tryWin(deal);
    check(!refused.ok, 'the row refuses the close — through PostgREST, with no service involved', `status ${refused.status}`);
    check(/won_gate|no_accepted_quotation/.test(refused.text ?? ''), 'and says which gate refused it', (refused.text ?? '').slice(0, 120));
    check((await stageOf(deal)) === 'negotiation', 'the deal is still where it was');
  }

  // ── 2. sent is not accepted ─────────────────────────────────────────────
  console.log('\n2. A quotation that was only SENT does not close the deal');
  {
    const deal = await newDeal('sent-only');
    const q = await fx.proposalAt(deal, owner, `${MARKER} sent`, 'sent');
    check(q.trace?.send?.outcome === 'sent', 'a quotation is sent through the governed path', `send ${q.trace?.send?.outcome}`);
    check((await verdict(deal)) === 'no_accepted_quotation', 'the verdict still refuses — delivery is not acceptance');
    check(!(await tryWin(deal)).ok, 'and so does the row');
  }

  // ── 3. an accepted quotation opens the gate ─────────────────────────────
  console.log('\n3. An accepted quotation is what a won deal is won on');
  {
    const deal = await newDeal('accepted');
    const q = await fx.acceptedProposal(deal, owner, `${MARKER} accepted`);
    check(q.trace?.accept?.outcome === 'recorded', 'the client accepts the exact version', `accept ${q.trace?.accept?.outcome}`);
    check((await verdict(deal)) === null, 'the verdict has nothing standing in the way');
    const won = await tryWin(deal);
    check(won.ok, 'the close lands', `status ${won.status}`);
    check((await stageOf(deal)) === 'won', 'and the deal is won');
  }

  // ── 4. the configured half, off by default ──────────────────────────────
  console.log('\n4. The payment half is a switch, and it starts off');
  {
    const deal = await newDeal('switch-off');
    await fx.acceptedProposal(deal, owner, `${MARKER} switch-off`);
    check((await verdict(deal)) === null, 'with the setting unset, an accepted quotation alone is enough');
    check((await tryWin(deal)).ok, 'and the deal closes');
  }

  // ── 5. the configured half, switched on ─────────────────────────────────
  console.log('\n5. Switched on, a deal also needs payment or an approved exception');
  await setSetting('won_requires_payment_evidence', 'on');
  try {
    const deal = await newDeal('payment-required');
    const q = await fx.acceptedProposal(deal, owner, `${MARKER} payment-required`);

    // The quotation's OWN approval exists and is approved — and must not count.
    check((await verdict(deal)) === 'no_payment_evidence', 'the verdict names the second half — the quotation’s own approval does not satisfy it');
    check(!(await tryWin(deal)).ok, 'and the row refuses the close');

    // Doc 09 §23's authorized exception: an approval naming this exact version
    // AND saying it is a payment exception. Written directly, as the service
    // role, with the table's real columns — nothing yet raises one of these
    // through a door (ADM-72), so the row is the only way to plant one.
    const approval = one(await rest('POST', 'approvals', 'approval_requests', {
      organization_id: ORG,
      subject_type: 'proposal',
      subject_id: q.id,
      required_role: 'owner',
      requested_by_type: 'system',
      state: 'approved',
      decided_at: new Date().toISOString(),
      decided_by: owner.id,
      sla_due_at: new Date(Date.now() + 48 * 3_600_000).toISOString(),
      amount_minor: 100000,
      summary: `${MARKER} no-advance exception`,
      payload: { kind: 'payment_exception' },
    }));
    if (approval?.id) created.approvals.push(approval.id);

    check(Boolean(approval?.id), 'a payment-exception approval can be recorded on the accepted version', approval?.id ? 'recorded' : JSON.stringify(approval).slice(0, 200));
    if (approval?.id) {
      check((await verdict(deal)) === null, 'and it opens the gate');
      check((await tryWin(deal)).ok, 'so the deal closes');
    }
  } finally {
    await setSetting('won_requires_payment_evidence', null);
  }

  // ── 6. the gate binds the transition, not the state ─────────────────────
  console.log('\n6. A deal already won is left alone');
  {
    const settled = await newDeal('already-won');
    const q = await fx.acceptedProposal(settled, owner, `${MARKER} already-won`);
    await tryWin(settled);
    // Make the deal one that would NOT pass the gate today — through a door
    // that exists. The first draft PATCHed the accepted quotation to
    // `superseded`, which proposals_guard refuses (accepted is terminal), so
    // the premise silently never held. Switching the payment half on does it.
    void q;
    await setSetting('won_requires_payment_evidence', 'on');
    check((await verdict(settled)) === 'no_payment_evidence', 'the deal would not pass the gate today', `${await verdict(settled)}`);
    // Then touch the row: an UPDATE that does not move the stage into `won`
    // must not be refused, or every later edit to a historical deal is impossible.
    const touched = await rest('PATCH', 'sales', `opportunities?id=eq.${settled}`, { value_minor: 123456 });
    check(touched.ok, 'and yet it can still be edited — the gate binds the move, not the row', `status ${touched.status}`);
    await setSetting('won_requires_payment_evidence', null);
  }

  // ── 7. a deal cannot be born won ────────────────────────────────────────
  console.log('\n7. A deal cannot be created already won');
  {
    // Found by review: the first draft was UPDATE-only, and a direct POST with
    // stage='won' walked straight past it.
    const lead = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, source: 'manual', title: `${MARKER} born`, status: 'new' }));
    created.leads.push(lead.id);
    const born = await rest('POST', 'sales', 'opportunities', {
      organization_id: ORG, lead_id: lead.id, name: `${MARKER} born won`, stage: 'won', closed_at: new Date().toISOString(),
    });
    if (one(born)?.id) created.opportunities.push(one(born).id);
    check(!born.ok, 'an INSERT with stage=won is refused at the row', `status ${born.status}`);
    check(/won_gate|no_accepted_quotation/.test(born.text ?? ''), 'by the gate, by name', (born.text ?? '').slice(0, 100));
  }
} finally {
  // Approval requests are evidence: approvals.reject_delete refuses every
  // caller, so they are left — named here rather than deleted into a 4xx.
  void created.approvals;
  for (const id of created.opportunities) await rest('DELETE', 'sales', `opportunities?id=eq.${id}`);
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  await setSetting('won_requires_payment_evidence', null);
  await fx.cleanup();
}

console.log(
  failures === 0
    ? `\n\x1b[32m✔ ${checks} checks passed — a deal is won on an accepted quotation, and the row is what says so\x1b[0m\n`
    : `\n\x1b[31m✖ ${failures} of ${checks} checks failed\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
