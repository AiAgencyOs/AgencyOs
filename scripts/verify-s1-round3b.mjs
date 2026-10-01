// ═══════════════════════════════════════════════════════════════════════════
// Round 3b owner decisions, stream S1, against real Postgres:
//
//   R1-3  Phase 5 completes only when the M2 invoice is verified paid:
//         `projects.phase_readiness` lists "M2 not verified paid" and
//         `projects.complete_phase` refuses until the invoice is paid on the
//         verified basis (issued, or paid-but-unverified, is not enough);
//         the answer is a boolean (`projects.m2_verified_paid`) that works for a
//         role that cannot read invoices and says false across tenants.
//   R3-2  `finance.generate_period_report` also stores payments received
//         (verified basis, net of refunds) and the profit-and-loss figures
//         (revenue, expenses, net), computed in the database.
//   (R1-2 the client chip and R1-4 the Hot Leads filter are pure derivations,
//    covered by tests/a-client-wears-one-lifecycle-chip.test.ts and
//    tests/a-lead-is-hot-warm-or-cold.test.ts.)
//
// SELF-CONTAINED: creates its own organizations and users through the auth
// admin API and removes them in `finally`; assumes only a fresh database.
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { startKit } from './verify-kit-r3.mjs';

const k = await startKit('M2-gated Phase 5, period report payments and profit-and-loss', 'zzs1');
const { check, rest, one, section } = k;
const projects = k.rpc('projects');
const finance = k.rpc('finance');

const bail = (message) => {
  throw new Error(message);
};

try {
  const orgA = await k.makeOrg('a');
  const orgB = await k.makeOrg('b');
  const A = orgA.id;
  const owner = await k.makeUser('owner', A);
  const lead = await k.makeUser('delivery_lead', A);
  const member = await k.makeUser('member', A);
  const finUser = await k.makeUser('finance', A);
  const otherOwner = await k.makeUser('owner', orgB.id);

  const client = one(await rest('POST', 'core', 'client_accounts', { organization_id: A, name: 'zzs1 client' }));
  const project = one(await rest('POST', 'projects', 'projects', { organization_id: A, client_account_id: client?.id, name: `zzs1 ${randomUUID().slice(0, 6)}`, status: 'planning' }));
  if (!client?.id || !project?.id) bail(`could not create the fixtures: ${JSON.stringify([client, project])}`);
  const P = project.id;

  // ═══ R1-3 ═════════════════════════════════════════════════════════════════
  section('R1-3. Phase 5 needs the M2 invoice verified paid');
  const mod = one(await rest('POST', 'projects', 'modules', { organization_id: A, project_id: P, name: 'zzs1 module' }));
  const done = one(await rest('POST', 'projects', 'tasks', { organization_id: A, project_id: P, module_id: mod?.id, title: 'zzs1 built', status: 'done', completed_at: new Date().toISOString() }));
  if (!mod?.id || !done?.id) bail('could not create the development task fixtures');

  const readiness = async (token) => one(await projects('phase_readiness', { p_project_id: P, p_phase: 5 }, token));
  const complete = (token) => projects('complete_phase', { p_project_id: P, p_phase: 5 }, token);
  const m2Missing = (r) => (r?.missing ?? []).includes('M2 not verified paid');

  const noMilestone = await readiness(owner.token);
  check(noMilestone?.outcome === 'not_ready' && m2Missing(noMilestone), 'every task done but no M2 on the project: not ready, "M2 not verified paid"', JSON.stringify(noMilestone?.missing));
  const m1 = one(await rest('POST', 'projects', 'milestones', { organization_id: A, project_id: P, name: 'zzs1 M1', position: 1, amount_minor: 50000, currency: 'INR' }));
  const m2 = one(await rest('POST', 'projects', 'milestones', { organization_id: A, project_id: P, name: 'zzs1 M2', position: 2, amount_minor: 100000, currency: 'INR' }));
  if (!m1?.id || !m2?.id) bail('could not create the milestone fixtures');
  const invoice = async (n, milestoneId, status, total, extra = {}) => {
    const inv = one(await rest('POST', 'finance', 'invoices', { organization_id: A, client_account_id: client.id, project_id: P, milestone_id: milestoneId, number: `ZZS1-${randomUUID().slice(0, 6)}-${n}`, status, currency: 'INR', subtotal_minor: total, total_minor: total, issued_at: '2026-09-10T10:00:00Z', ...extra }));
    if (!inv?.id) bail(`could not create invoice ${n}: ${JSON.stringify(inv)}`);
    return inv;
  };
  // A paid M1 does not stand in for M2.
  await invoice('m1', m1.id, 'paid', 50000, { paid_minor: 50000, verified_minor: 50000, paid_at: '2026-09-11T10:00:00Z' });
  check(m2Missing(await readiness(owner.token)), 'a verified-paid M1 does not stand in for M2');
  const m2inv = await invoice('m2', m2.id, 'issued', 100000);
  check(m2Missing(await readiness(owner.token)), 'an issued M2 invoice is not verified paid');
  const refusedIssued = one(await complete(owner.token));
  check(refusedIssued?.outcome === 'not_ready' && (refusedIssued.missing ?? []).includes('M2 not verified paid'), 'complete_phase refuses, and says why', JSON.stringify(refusedIssued));
  await rest('PATCH', 'finance', `invoices?id=eq.${m2inv.id}`, { paid_minor: 100000 });
  check(m2Missing(await readiness(owner.token)), 'money recorded on M2 but not verified is not enough');
  check(one(await complete(owner.token))?.outcome === 'not_ready', 'and the door still refuses');
  const paid = await rest('PATCH', 'finance', `invoices?id=eq.${m2inv.id}`, { verified_minor: 40000, status: 'partially_paid' });
  check(paid.ok && m2Missing(await readiness(owner.token)), 'partly verified is not verified paid');
  check((await rest('GET', 'projects', `phase_completions?project_id=eq.${P}&select=id`)).json?.length === 0, 'nothing was completed by any refusal');

  // The readiness read works for a role that cannot read invoices, and does not leak across tenants.
  const memberRead = await rest('GET', 'finance', `invoices?project_id=eq.${P}&select=id`, undefined, member.token);
  check(memberRead.ok && memberRead.json.length === 0, 'a member cannot read the invoice itself');
  check(m2Missing(await readiness(member.token)), 'yet the readiness read gives a member the same honest answer (a boolean, not the invoice)');
  check((await projects('m2_verified_paid', { p_project_id: P }, otherOwner.token)).json === false, 'another tenant is answered false for this project');
  check((await projects('m2_verified_paid', { p_project_id: randomUUID() }, owner.token)).json === false, 'and so is an unknown project');

  const paidInFull = await rest('PATCH', 'finance', `invoices?id=eq.${m2inv.id}`, { verified_minor: 100000, status: 'paid', paid_at: new Date().toISOString() });
  check(paidInFull.ok, 'M2 is verified paid in full');
  check((await readiness(member.token))?.outcome === 'ready', 'now Phase 5 is ready');
  check((await projects('m2_verified_paid', { p_project_id: P }, owner.token)).json === true, 'm2_verified_paid answers true to the owner');
  check(one(await complete(member.token))?.outcome === 'forbidden', 'a member still cannot complete it (project.write)');
  check(one(await complete(otherOwner.token))?.outcome === 'forbidden', 'nor another tenant');
  const done5 = one(await complete(lead.token));
  check(done5?.outcome === 'completed', 'a delivery lead completes Phase 5', JSON.stringify(done5));
  const rec = one(await rest('GET', 'projects', `phase_completions?project_id=eq.${P}&phase=eq.5&select=basis`));
  check(rec?.basis?.m2VerifiedPaid === true, 'the completion records M2 verified paid as its evidence', JSON.stringify(rec?.basis));
  check(one(await complete(owner.token))?.outcome === 'already_completed', 'a replay is already_completed');

  // ═══ R3-2 ═════════════════════════════════════════════════════════════════
  section('R3-2. the period report holds payments received and the profit and loss');
  const day = (d) => `2026-09-${String(d).padStart(2, '0')}T10:00:00Z`;
  const invA = await invoice('p1', null, 'paid', 200000, { paid_minor: 200000, verified_minor: 200000, paid_at: day(12), issued_at: day(2) });
  const pay = async (invoiceId, amount, over) => {
    const r = await rest('POST', 'finance', 'payments', { organization_id: A, invoice_id: invoiceId, provider: 'manual', provider_payment_id: `zzs1-${randomUUID()}`, amount_minor: amount, currency: 'INR', status: 'captured', captured_at: day(10), verified_at: day(12), verified_by: finUser.id, ...over });
    if (!r.ok) bail(`could not create a payment: ${JSON.stringify(r.json)}`);
  };
  await pay(invA.id, 120000);
  await pay(invA.id, 80000, { verified_at: day(20) });
  await pay(invA.id, 55500, { verified_at: null, verified_by: null });
  await pay(invA.id, 33300, { verified_at: '2026-08-30T10:00:00Z' });
  await pay(invA.id, 22200, { verified_at: '2026-10-01T00:00:00Z' });
  await pay(invA.id, 11100, { status: 'failed', captured_at: null });
  const refund = await rest('POST', 'finance', 'refunds', { organization_id: A, invoice_id: invA.id, amount_minor: 20000, reason: 'zzs1 goodwill', status: 'recorded', provider: 'manual', provider_refund_id: `zzs1-${randomUUID()}`, recorded_at: day(25) });
  if (!refund.ok) bail(`could not create a refund: ${JSON.stringify(refund.json)}`);
  const exp = await rest('POST', 'finance', 'expenses', { organization_id: A, category: 'tooling', description: 'zzs1 expense', amount_minor: 30000, incurred_on: '2026-09-15', currency: 'INR' });
  if (!exp.ok) bail(`could not create an expense: ${JSON.stringify(exp.json)}`);

  const rep = one(await finance('generate_period_report', { p_period_start: '2026-09-01', p_period_end: '2026-10-01', p_label: 'zzs1 September' }, finUser.token));
  check(rep?.outcome === 'generated' && rep?.id, 'finance generates the report', rep?.outcome);
  const stored = one(await rest('GET', 'finance', `period_reports?id=eq.${rep.id}&select=snapshot`, undefined, finUser.token));
  const inr = (stored?.snapshot ?? []).find((c) => c.currency === 'INR');
  check(inr?.payments?.count === 2 && inr?.payments?.received_minor === 200000, 'payments received: only verified payments verified inside the period (120000 + 80000)', JSON.stringify(inr?.payments));
  check(inr?.payments?.refunded_minor === 20000 && inr?.payments?.net_received_minor === 180000, 'less the refund recorded in the period: net 180000', JSON.stringify(inr?.payments));
  check(inr?.profit_and_loss?.revenue_minor === 180000 && inr?.profit_and_loss?.expenses_minor === 30000 && inr?.profit_and_loss?.net_minor === 150000, 'profit and loss: revenue 180000, expenses 30000, net 150000', JSON.stringify(inr?.profit_and_loss));
  check(inr?.invoices?.count === 3 && inr?.invoices?.total_minor === 350000 && inr?.expenses?.amount_minor === 30000, 'the invoice and expense figures are still held beside them', JSON.stringify([inr?.invoices, inr?.expenses]));

  const empty = one(await finance('generate_period_report', { p_period_start: '2026-01-01', p_period_end: '2026-02-01' }, finUser.token));
  const emptyRow = one(await rest('GET', 'finance', `period_reports?id=eq.${empty.id}&select=snapshot`, undefined, finUser.token));
  check(empty?.outcome === 'generated' && Array.isArray(emptyRow?.snapshot) && emptyRow.snapshot.length === 0, 'an empty period is a real, empty report');
  check(one(await finance('generate_period_report', { p_period_start: '2026-09-01', p_period_end: '2026-10-01' }, member.token))?.outcome === 'forbidden', 'a member may not generate one');
  check(one(await finance('generate_period_report', { p_period_start: '2026-09-01', p_period_end: '2026-10-01' }, otherOwner.token))?.id !== rep.id, 'another tenant\'s report is its own');
  const otherSees = await rest('GET', 'finance', `period_reports?id=eq.${rep.id}&select=id`, undefined, otherOwner.token);
  check(otherSees.ok && otherSees.json.length === 0, 'and another tenant cannot read this one');
} finally {
  await k.cleanup(async () => {
    for (const org of k.created.orgs) {
      await rest('DELETE', 'finance', `period_reports?organization_id=eq.${org}`);
      await rest('DELETE', 'finance', `refunds?organization_id=eq.${org}`);
      await rest('DELETE', 'finance', `payments?organization_id=eq.${org}`);
      await rest('DELETE', 'finance', `expenses?organization_id=eq.${org}`);
      await rest('DELETE', 'finance', `invoices?organization_id=eq.${org}`);
      await rest('DELETE', 'core', `outbox_events?organization_id=eq.${org}`);
    }
  });
}
k.finish();
