// ═══════════════════════════════════════════════════════════════════════════
// A deal that is handed off — PH1-CLS-002
//
// CRM Doc 09 §33: "Handoff completion should be a real workflow event, not
// simply a note." Until this, the project appearing WAS the note:
// `opportunity.won` is an audit action, nothing is emitted, nothing can
// subscribe. This proves the event exists and carries what Master Plan V3
// §13.4 says the WON packet carries — by reading the handoff row, the outbox
// row and the packet projection, not by trusting an outcome string.
//
// Every quotation walks the governed path through scripts/verify-fixtures.mjs,
// because G-230 means a deal cannot be won any other way.
//
//   node scripts/verify-won-handoff.mjs
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { fixturesFor } from './verify-fixtures.mjs';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: true, anon: false, jwt: true });
await announceTarget(target, 'a handoff is an event, not a note');

const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-handoff-${randomUUID().slice(0, 8)}`;
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
const handoff = async (opp, project) => one(await rpc('sales', 'record_won_handoff', { p_opportunity_id: opp, p_project_id: project }));
const packet = async (opp) => (await rpc('sales', 'won_handoff_packet', { p_opportunity_id: opp })).json;
const handoffRow = async (opp) =>
  one(await rest('GET', 'ai', `handoffs?subject_type=eq.opportunity&subject_id=eq.${opp}&select=*`));

const created = { contacts: [], leads: [], conversations: [], opportunities: [], projects: [], handoffs: [] };

/** One runner invocation — G-250's start job is claimed by it like any other. */
async function tick() {
  const res = await fetch(`${target.app}/api/jobs/run`, { method: 'POST', headers: { Authorization: `Bearer ${target.cronSecret}` }, cache: 'no-store' });
  return res.status;
}

console.log('\n\x1b[1mAgencyOS — a deal that is handed off (PH1-CLS-002)\x1b[0m');

try {
  const owner = await fx.bootstrapOwner(MARKER);
  await fx.installProposalPolicy(owner);

  // ── a lead with the context §33 asks to be carried ─────────────────────
  const contact = one(await rest('POST', 'crm', 'contacts', {
    organization_id: ORG, full_name: `${MARKER} client`, phone: `+9199${String(Date.now()).slice(-8)}`, preferred_language: 'hi',
  }));
  created.contacts.push(contact.id);
  // Born `new`: leads_qualified_at_set refuses 'qualified' without the moment
  // it happened, and a fixture that lies about that is the wrong fixture.
  const lead = one(await rest('POST', 'crm', 'leads', {
    organization_id: ORG, contact_id: contact.id, source: 'manual', title: `${MARKER} lead`, status: 'new',
  }));
  created.leads.push(lead.id);
  const conv = one(await rest('POST', 'crm', 'conversations', {
    organization_id: ORG, lead_id: lead.id, contact_id: contact.id, channel: 'whatsapp', external_ref: `${MARKER}:conv`, status: 'active',
  }));
  created.conversations.push(conv.id);
  await rest('POST', 'crm', 'conversation_summaries', {
    conversation_id: conv.id, organization_id: ORG, summary: `${MARKER}: a tiffin ordering app for two cities.`, through_seq: 7,
  });
  const objection = await rest('POST', 'sales', 'objections', {
    organization_id: ORG, lead_id: lead.id, kind: 'trust', round: 1,
    concern: `${MARKER}: will you disappear after the advance?`,
  });
  if (!objection.ok) fail(`fixture: the trust objection was refused — ${objection.text.slice(0, 200)}`);
  const opp = one(await rest('POST', 'sales', 'opportunities', {
    organization_id: ORG, lead_id: lead.id, name: `${MARKER} deal`, stage: 'negotiation', owner_id: owner.id,
  }));
  created.opportunities.push(opp.id);

  // ── the governed path, then the win ────────────────────────────────────
  const q = await fx.acceptedProposal(opp.id, owner, `${MARKER} quotation`, { contactId: contact.id });
  check(q.trace?.accept?.outcome === 'recorded', 'the quotation is accepted through the governed path', `accept ${q.trace?.accept?.outcome}`);
  const won = await rest('PATCH', 'sales', `opportunities?id=eq.${opp.id}`, { stage: 'won', closed_at: new Date().toISOString() });
  check(won.ok, 'the deal is won', `status ${won.status}`);

  const account = one(await rest('GET', 'core', `client_accounts?organization_id=eq.${ORG}&select=id&limit=1`));
  const project = one(await rest('POST', 'projects', 'projects', {
    organization_id: ORG, client_account_id: account.id, opportunity_id: opp.id, name: `${MARKER} project`,
    budget_minor: 100000, currency: 'INR', proposal_id: q.id,
  }));
  created.projects.push(project.id);

  // ── 1. the event, at the win ────────────────────────────────────────────
  console.log('\n1. The win itself records an event, not a note');
  {
    // Nothing has called record_won_handoff yet. The PATCH to won did this.
    const atWin = await handoffRow(opp.id);
    check(Boolean(atWin?.id), 'the packet exists the moment the deal is won — before any conversion', atWin ? 'present' : 'absent');
    if (atWin?.id) created.handoffs.push(atWin.id);
    check(atWin?.project_id === null, 'with no project yet — there is none', `project ${atWin?.project_id}`);
    check(atWin?.from_agent === 'sales' && atWin?.to_agent === 'project_manager', 'as Sales handing to the Project Manager', `${atWin?.from_agent} → ${atWin?.to_agent}`);
    check(atWin?.status === 'queued', 'born queued — Phase 2 is not activated, and nothing consumes it', `status ${atWin?.status}`);

    const ev = one(await rest('GET', 'core', `outbox_events?type=eq.opportunity.handed_off&subject_id=eq.${opp.id}&select=id,type,payload,correlation_id`));
    check(Boolean(ev?.id), 'opportunity.handed_off is in the outbox', ev ? 'present' : 'absent');
    check(ev?.payload?.handoff_id === atWin?.id && ev?.correlation_id === atWin?.correlation_id, 'names the handoff, on its correlation');

    // Conversion binds its project to the packet the win wrote.
    const r = await handoff(opp.id, project.id);
    check(r?.outcome === 'project_bound' && r?.handoff_id === atWin?.id, 'conversion binds the project to that packet', `outcome ${r?.outcome}`);
    const row = await handoffRow(opp.id);
    check(row?.project_id === project.id && row?.context?.project_id === project.id, 'and the row now names it');
    check(!(row?.unresolved ?? []).includes('project_proposal_differs'), 'the project was raised from the version the packet carries');
  }

  // ── 2. the packet carries §13.4 ─────────────────────────────────────────
  console.log('\n2. The packet carries what §13.4 lists — as references to recorded facts');
  {
    const row = await handoffRow(opp.id);
    const art = (row?.artifacts ?? [])[0];
    check(art?.proposal_id === q.id && art?.version === 1, 'the exact accepted quotation and its version', `v${art?.version}`);
    check(art?.total_minor === 100000, 'with the total the client agreed to');
    const kinds = (row?.decisions ?? []).map((d) => d.kind).sort();
    check(kinds.join(',') === 'acceptance,approval', 'the approval and the acceptance, both', kinds.join(','));
    const acc = (row?.decisions ?? []).find((d) => d.kind === 'acceptance');
    check(Boolean(acc?.decided_at) && acc?.responded_by_contact_id === contact.id, 'the acceptance carries its moment and who gave it');
    check(row?.context?.contact_id === contact.id && row?.context?.language === 'hi', 'the contact and the language they write in');
    check(row?.context?.conversation_id === conv.id && Number(row?.context?.summary_through_seq) === 7, 'the thread and how far its summary reaches');
    const trust = (row?.constraints ?? []).find((c) => c.kind === 'trust_concerns');
    check((trust?.objection_ids ?? []).length === 1, 'the trust concern, by reference, not paraphrased');
    const gate = (row?.constraints ?? []).find((c) => c.kind === 'payment_gate');
    check(gate?.requires_payment_evidence === 'off' && gate?.verdict_at_handoff === undefined, 'the payment-gate reading the deal closed under');
  }

  // ── 3. absence is visible (ADM-72) ─────────────────────────────────────
  console.log('\n3. What the packet does not know, it says by name');
  {
    const row = await handoffRow(opp.id);
    // This quotation was drafted with no requirement version, so the packet
    // must say so rather than invent one.
    check((row?.unresolved ?? []).includes('requirement_version'), 'no requirement version → named in unresolved', JSON.stringify(row?.unresolved));
    check(!(row?.unresolved ?? []).includes('accepted_quotation') && !(row?.unresolved ?? []).includes('approval'), 'and nothing that IS known is listed');
    check((row?.requirements ?? []).length === 0, 'requirements is empty rather than fabricated');
    // The acceptance named the contact, so the actor is not weak here — the
    // twin, an acceptance that names nobody, is §7.
    check(!(row?.unresolved ?? []).includes('acceptance_actor'), 'an acceptance that names the contact is not listed as weak');
  }

  // ── 4. the projection ───────────────────────────────────────────────────
  console.log('\n4. The packet can be read as one thing');
  {
    const p = await packet(opp.id);
    check(p?.opportunity?.id === opp.id && p?.project?.id === project.id, 'deal and project side by side');
    check(p?.client?.language === 'hi', 'the client’s language');
    check(Array.isArray(p?.commercial) && p.commercial[0]?.proposal_id === q.id, 'the commercial baseline');
    check(Array.isArray(p?.unresolved), 'and the list of absences');
  }

  // ── 5. once ─────────────────────────────────────────────────────────────
  console.log('\n5. A deal is handed off once');
  {
    const again = await handoff(opp.id, project.id);
    check(again?.outcome === 'already_recorded', 'a second conversion click finds the first', `outcome ${again?.outcome}`);
    const rows = (await rest('GET', 'ai', `handoffs?subject_type=eq.opportunity&subject_id=eq.${opp.id}&select=id`)).json ?? [];
    check(rows.length === 1, 'one row');
    const events = (await rest('GET', 'core', `outbox_events?type=eq.opportunity.handed_off&subject_id=eq.${opp.id}&select=id`)).json ?? [];
    check(events.length === 1, 'one event');
  }

  // ── 6. refusals ─────────────────────────────────────────────────────────
  console.log('\n6. What cannot be handed off');
  {
    const lead2 = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, source: 'manual', title: `${MARKER} open`, status: 'new' }));
    created.leads.push(lead2.id);
    const open = one(await rest('POST', 'sales', 'opportunities', { organization_id: ORG, lead_id: lead2.id, name: `${MARKER} open deal`, stage: 'negotiation' }));
    created.opportunities.push(open.id);
    check((await handoff(open.id, project.id))?.outcome === 'not_won', 'a deal that is not won');
    check((await handoff(opp.id, randomUUID()))?.outcome === 'project_mismatch', 'a project that is not this deal’s');
    check((await handoff(randomUUID(), project.id))?.outcome === 'not_found', 'a deal that does not exist');
    check((await packet(open.id)) === null, 'and a deal never handed off has no packet');
  }

  // ── 7. an acceptance that names nobody ──────────────────────────────────
  console.log('\n7. An acceptance with no actor is carried, and named as weak');
  {
    const lead3 = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, source: 'manual', title: `${MARKER} unnamed`, status: 'new' }));
    created.leads.push(lead3.id);
    const opp3 = one(await rest('POST', 'sales', 'opportunities', { organization_id: ORG, lead_id: lead3.id, name: `${MARKER} unnamed deal`, stage: 'negotiation' }));
    created.opportunities.push(opp3.id);
    const q3 = await fx.acceptedProposal(opp3.id, owner, `${MARKER} unnamed quotation`);
    check(q3.trace?.accept?.outcome === 'recorded', 'accepted with no contact — the door allows it', `accept ${q3.trace?.accept?.outcome}`);
    const won3 = await rest('PATCH', 'sales', `opportunities?id=eq.${opp3.id}`, { stage: 'won', closed_at: new Date().toISOString() });
    check(won3.ok, 'and the deal is won');
    const project3 = one(await rest('POST', 'projects', 'projects', {
      organization_id: ORG, client_account_id: account.id, opportunity_id: opp3.id, name: `${MARKER} unnamed project`,
      budget_minor: 100000, currency: 'INR', proposal_id: q3.id,
    }));
    created.projects.push(project3.id);
    const r3 = await handoff(opp3.id, project3.id);
    check(r3?.outcome === 'project_bound', 'the win wrote the packet; conversion bound the project', `outcome ${r3?.outcome}`);
    if (r3?.handoff_id) created.handoffs.push(r3.handoff_id);
    const row3 = await handoffRow(opp3.id);
    check((row3?.unresolved ?? []).includes('acceptance_actor'), 'the packet names the missing actor', JSON.stringify(row3?.unresolved));
    const acc3 = (row3?.decisions ?? []).find((d) => d.kind === 'acceptance');
    check(Boolean(acc3?.decided_at) && acc3?.responded_by_contact_id === undefined, 'and still carries the acceptance it has');
  }

  // ── 8. who may call the door ────────────────────────────────────────────
  console.log('\n8. A portal client cannot record a handoff; staff can');
  {
    // Review: DEFINER, granted to authenticated, org check only — a client of
    // the same organization could write the row, the event and the audit line.
    const client = fx.mint(randomUUID(), 'client');
    const r = one(await fx.call(client, 'POST', 'sales', 'rpc/record_won_handoff', { p_opportunity_id: opp.id, p_project_id: project.id }));
    check(r?.outcome === 'forbidden', 'a portal client of the same organization is refused', `outcome ${r?.outcome}`);
    const member = fx.mint(randomUUID(), 'member');
    const m = one(await fx.call(member, 'POST', 'sales', 'rpc/record_won_handoff', { p_opportunity_id: opp.id, p_project_id: project.id }));
    check(m?.outcome === 'already_recorded', 'a member is not — the door is staff', `outcome ${m?.outcome}`);
  }

  // ── 9. a project raised by mistake ──────────────────────────────────────
  console.log('\n9. A project raised by mistake is replaced, and the packet follows');
  {
    const opp3 = created.opportunities[created.opportunities.length - 1];
    const project3 = created.projects[created.projects.length - 1];
    const gone = await rest('PATCH', 'projects', `projects?id=eq.${project3}`, { deleted_at: new Date().toISOString() });
    check(gone.ok, 'the first project is soft-deleted', `status ${gone.status}`);
    const before = await packet(opp3);
    check(before?.project_deleted === true && before?.project === undefined, 'the packet names the project as gone rather than presenting it', JSON.stringify({ project_deleted: before?.project_deleted, project: before?.project }));
    const again = one(await rest('POST', 'projects', 'projects', {
      organization_id: ORG, client_account_id: account.id, opportunity_id: opp3, name: `${MARKER} unnamed project, again`,
      budget_minor: 100000, currency: 'INR',
    }));
    check(Boolean(again?.id), 'a fresh project can be raised — projects_opportunity_key is partial on deleted_at', `${again?.id ? 'created' : JSON.stringify(again).slice(0, 120)}`);
    if (again?.id) created.projects.push(again.id);
    const r = await handoff(opp3, again?.id);
    check(r?.outcome === 'project_bound', 'conversion binds the packet to the live project', `outcome ${r?.outcome}`);
    const row = await handoffRow(opp3);
    check(row?.project_id === again?.id && row?.context?.previous_project_id === project3, 'and remembers which one it replaced');
    check((row?.unresolved ?? []).includes('project_rebound'), 'named in unresolved, not silently swapped', JSON.stringify(row?.unresolved));
    const after = await packet(opp3);
    check(after?.project?.id === again?.id && after?.project_deleted === undefined, 'the packet now presents the live project');
  }

  // ── 8. the binding starts Phase 2 — G-250, Phase 2 Master Flow §5.1 ────
  //
  // The packet sat at `queued` with no receiver for five days by design.
  // This is the receiver, driven through the REAL runner: the binding above
  // emitted an event, the dispatcher turned it into a job, and the runner
  // claimed it. Nothing here calls the door directly — a door driven by hand
  // proves the door, not the chain.
  console.log('\n8. The binding starts Phase 2 (G-250)');
  {
    const opp = created.opportunities[created.opportunities.length - 1];
    const project = created.projects[created.projects.length - 1];

    const emitted = (await rest('GET', 'core',
      `outbox_events?type=eq.project.handoff_bound&subject_id=eq.${project}&select=id,subject_type`)).json ?? [];
    check(emitted.length === 1 && emitted[0]?.subject_type === 'project',
      'binding the packet emitted project.handoff_bound, once, naming the project', `${emitted.length} event(s)`);

    // Up to eight ticks: the shared CI project has other queued work, the
    // dispatch runs before the drains, and the revenue path is ahead of this
    // one on purpose — a Phase 2 that starts a tick later is a minute late.
    let run = null;
    for (let i = 0; i < 8 && !run; i += 1) {
      await tick();
      run = one(await rest('GET', 'projects',
        `phase_two?project_id=eq.${project}&select=id,state,handoff_id,pm_agent_key,started_at,completed_at`));
    }
    check(Boolean(run?.id), 'the runner started Phase 2 from the event — no door was called by hand', run ? 'started' : 'no run after 8 ticks');
    check(run?.state === 'context_loading', 'in context_loading: the phase has loaded nothing and told nobody', `state ${run?.state}`);
    check(run?.pm_agent_key === 'project_manager', 'with the PM that ADM-82 enabled', `pm ${run?.pm_agent_key}`);
    const bound = await handoffRow(opp);
    check(run?.handoff_id === bound?.id, 'pointing at the packet it inherited rather than copying it');
    check(bound?.status === 'accepted', 'and the packet is no longer queued with no receiver', `status ${bound?.status}`);

    // Idempotent through the chain: ticking again must not start a second one.
    await tick();
    const runs = (await rest('GET', 'projects', `phase_two?project_id=eq.${project}&select=id`)).json ?? [];
    check(runs.length === 1, 'a second tick starts no second phase', `${runs.length} run(s)`);

    const started = (await rest('GET', 'audit',
      `audit_log?action=eq.project.phase_two_started&subject_id=eq.${project}&select=id`)).json ?? [];
    check(started.length === 1, 'audited exactly once', `${started.length} row(s)`);
  }

} finally {
  // G-250: the binding now starts a phase and queues a job, so both are this
  // script's to remove. phase_two cascades with the project; the job does not.
  for (const id of created.projects) {
    await rest('DELETE', 'core', `jobs?kind=eq.phase_two.start&payload->>subjectId=eq.${id}`);
    await rest('DELETE', 'core', `outbox_events?type=eq.project.handoff_bound&subject_id=eq.${id}`);
  }
  for (const id of created.handoffs) await rest('DELETE', 'ai', `handoffs?id=eq.${id}`);
  for (const id of created.projects) await rest('DELETE', 'projects', `projects?id=eq.${id}`);
  for (const id of created.opportunities) {
    await rest('DELETE', 'core', `outbox_events?subject_id=eq.${id}`);
    await rest('DELETE', 'sales', `opportunities?id=eq.${id}`);
  }
  for (const id of created.conversations) await rest('DELETE', 'crm', `conversations?id=eq.${id}`);
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  for (const id of created.contacts) await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
  await fx.cleanup();
}

console.log(
  failures === 0
    ? `\n\x1b[32m✔ ${checks} checks passed — a won deal hands off as an event that says what was won\x1b[0m\n`
    : `\n\x1b[31m✖ ${failures} of ${checks} checks failed\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
