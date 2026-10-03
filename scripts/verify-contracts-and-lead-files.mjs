// ═══════════════════════════════════════════════════════════════════════════
// A won deal has a contract, and a lead keeps its files.
//
// Owner decisions 10, 11 and 14 (2026-10-03). Against real Postgres, the parts
// no TypeScript reading can prove:
//
//   A. a contract exists only on a WON deal — the door refuses an open one and
//      so does the row (a service-role insert on an open deal is refused by the
//      trigger); only an owner or ops admin records one
//   B. draft -> sent -> signed; signing names the signer and the day; a signed
//      contract does not move again; every change is audited
//   C. a lead's files are added and removed through doors, never directly
//   D. the carry to the project is claimed atomically: exactly one of six
//      simultaneous claims wins, a wrong project is refused, a failed copy can
//      be released and claimed again
//   E. "when the lead last wrote" is the newest CLIENT message, not a message
//      the agency sent
//
//   node scripts/verify-contracts-and-lead-files.mjs
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { fixturesFor } from './verify-fixtures.mjs';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'a won deal has a contract, and a lead keeps its files');

const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-contracts-${randomUUID().slice(0, 8)}`;
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

const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const door = (token, schema, fn, args) => fx.call(token, 'POST', schema, `rpc/${fn}`, args);
const created = { contacts: [], leads: [], conversations: [], opportunities: [], projects: [], contracts: [], files: [] };

console.log('\n\x1b[1mAgencyOS — contracts and lead files (decisions 10, 11, 14)\x1b[0m');

try {
  const owner = await fx.bootstrapOwner(MARKER);
  await fx.installProposalPolicy(owner);
  const member = fx.mint(owner.id, 'member');

  const mkLead = async (label) => {
    const contact = one(await rest('POST', 'crm', 'contacts', { organization_id: ORG, full_name: `${MARKER} ${label}`, phone: `+9198${String(Date.now()).slice(-8)}${created.contacts.length}` }));
    created.contacts.push(contact.id);
    const lead = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, contact_id: contact.id, source: 'manual', title: `${MARKER} ${label}`, status: 'new' }));
    created.leads.push(lead.id);
    return { contact, lead };
  };

  // A won deal (through the governed path: a deal is won only on an accepted quotation) ...
  const a = await mkLead('won');
  const wonOpp = one(await rest('POST', 'sales', 'opportunities', { organization_id: ORG, lead_id: a.lead.id, name: `${MARKER} won deal`, stage: 'negotiation', owner_id: owner.id }));
  created.opportunities.push(wonOpp.id);
  await fx.acceptedProposal(wonOpp.id, owner, `${MARKER} quotation`, { contactId: a.contact.id });
  const won = await rest('PATCH', 'sales', `opportunities?id=eq.${wonOpp.id}`, { stage: 'won', closed_at: new Date().toISOString() });
  if (!won.ok) fail(`fixture: the deal could not be won — ${won.text.slice(0, 200)}`);
  // ... an open one ...
  const b = await mkLead('open');
  const openOpp = one(await rest('POST', 'sales', 'opportunities', { organization_id: ORG, lead_id: b.lead.id, name: `${MARKER} open deal`, stage: 'negotiation' }));
  created.opportunities.push(openOpp.id);
  // ... and the project the won deal became.
  const account = one(await rest('GET', 'core', `client_accounts?organization_id=eq.${ORG}&select=id&limit=1`));
  const project = one(await rest('POST', 'projects', 'projects', { organization_id: ORG, client_account_id: account.id, opportunity_id: wonOpp.id, name: `${MARKER} project`, budget_minor: 100000, currency: 'INR' }));
  created.projects.push(project.id);
  const otherProject = one(await rest('POST', 'projects', 'projects', { organization_id: ORG, client_account_id: account.id, name: `${MARKER} unrelated project`, budget_minor: 100000, currency: 'INR' }));
  created.projects.push(otherProject.id);

  // ── A ───────────────────────────────────────────────────────────────────
  console.log('\nA. Only a won deal has a contract, and only an owner or ops admin records it');
  const made = one(await door(owner.token, 'sales', 'create_contract', { p_opportunity_id: wonOpp.id, p_title: `${MARKER} MSA`, p_file_url: 'https://files.example/msa.pdf' }));
  check(made?.outcome === 'created' && made.contract_id, 'the owner records a contract on the won deal', made?.outcome);
  if (made?.contract_id) created.contracts.push(made.contract_id);
  const row = one(await rest('GET', 'sales', `contracts?id=eq.${made?.contract_id}&select=status,client_account_id,opportunity_id,created_by,signed_on`));
  check(row?.status === 'draft' && row?.opportunity_id === wonOpp.id && row?.created_by === owner.id && row?.signed_on === null, 'it is a draft, linked to the deal, by the owner');
  check(one(await door(owner.token, 'sales', 'create_contract', { p_opportunity_id: openOpp.id, p_title: 'x' }))?.outcome === 'not_won', 'the door refuses a deal that is not won');
  const forced = await rest('POST', 'sales', 'contracts', { organization_id: ORG, opportunity_id: openOpp.id, title: `${MARKER} forced` });
  check(!forced.ok, 'and so does the row: an insert on an open deal is refused by the trigger', `${forced.status}`);
  if (forced.ok) created.contracts.push(one(forced).id);
  check(one(await door(member, 'sales', 'create_contract', { p_opportunity_id: wonOpp.id, p_title: 'x' }))?.outcome === 'not_authorized', 'a member may not record one');
  check(one(await door(owner.token, 'sales', 'create_contract', { p_opportunity_id: wonOpp.id, p_title: '   ' }))?.outcome === 'invalid_title', 'a blank title is refused');
  check(one(await door(owner.token, 'sales', 'create_contract', { p_opportunity_id: wonOpp.id, p_title: 'x', p_file_url: 'javascript:alert(1)' }))?.outcome === 'invalid_url', 'a link that is not http(s) is refused');
  check(one(await door(owner.token, 'sales', 'create_contract', { p_opportunity_id: wonOpp.id, p_title: 'x', p_status: 'signed' }))?.outcome === 'invalid_signature', 'a signed contract without a signer and a day is refused');
  check(one(await door(owner.token, 'sales', 'create_contract', { p_opportunity_id: randomUUID(), p_title: 'x' }))?.outcome === 'not_found', 'a deal that does not exist is not found');
  for (const [who, token] of [['owner', owner.token], ['member', member]]) {
    const ins = await fx.call(token, 'POST', 'sales', 'contracts', { organization_id: ORG, opportunity_id: wonOpp.id, title: 'direct' });
    check(!ins.ok, `${who}: a direct insert through PostgREST is refused`, `${ins.status}`);
    const upd = await fx.call(token, 'PATCH', 'sales', `contracts?id=eq.${made?.contract_id}`, { status: 'signed' });
    check(!upd.ok || (Array.isArray(upd.json) && upd.json.length === 0), `${who}: a direct update changes nothing`, `${upd.status}`);
    const del = await fx.call(token, 'DELETE', 'sales', `contracts?id=eq.${made?.contract_id}`);
    check(!del.ok || (Array.isArray(del.json) && del.json.length === 0), `${who}: a direct delete removes nothing`, `${del.status}`);
  }
  check((await rest('GET', 'sales', `contracts?id=eq.${made?.contract_id}&select=id`)).json?.length === 1, 'the contract is still there');

  // ── B ───────────────────────────────────────────────────────────────────
  console.log('\nB. draft to sent to signed, and a signed contract is a record');
  const id = made?.contract_id;
  check(one(await door(owner.token, 'sales', 'update_contract_status', { p_contract_id: id, p_status: 'sent' }))?.outcome === 'updated', 'draft moves to sent');
  check(one(await door(member, 'sales', 'update_contract_status', { p_contract_id: id, p_status: 'signed', p_signer_name: 'A', p_signed_on: YESTERDAY }))?.outcome === 'not_authorized', 'a member may not move it');
  check(one(await door(owner.token, 'sales', 'update_contract_status', { p_contract_id: id, p_status: 'signed' }))?.outcome === 'invalid_signature', 'signing without a signer and a day is refused');
  check(one(await door(owner.token, 'sales', 'update_contract_status', { p_contract_id: id, p_status: 'signed', p_signer_name: 'A. Rao', p_signed_on: '2999-01-01' }))?.outcome === 'invalid_signature', 'a signing day in the future is refused');
  check(one(await door(owner.token, 'sales', 'update_contract_status', { p_contract_id: id, p_status: 'sent', p_signed_on: YESTERDAY }))?.outcome === 'invalid_signature', 'a signed date on an unsigned contract is refused');
  const signed = one(await door(owner.token, 'sales', 'update_contract_status', { p_contract_id: id, p_status: 'signed', p_signer_name: 'A. Rao', p_signed_on: YESTERDAY, p_file_url: 'https://files.example/msa-signed.pdf' }));
  check(signed?.outcome === 'updated', 'sent moves to signed with a signer, a day and the signed file');
  const after = one(await rest('GET', 'sales', `contracts?id=eq.${id}&select=status,signer_name,signed_on,file_url`));
  check(after?.status === 'signed' && after?.signer_name === 'A. Rao' && after?.signed_on === YESTERDAY && after?.file_url.endsWith('msa-signed.pdf'), 'the record holds all four');
  check(one(await door(owner.token, 'sales', 'update_contract_status', { p_contract_id: id, p_status: 'draft' }))?.outcome === 'invalid_transition', 'a signed contract does not go back');
  check(one(await door(owner.token, 'sales', 'update_contract_status', { p_contract_id: randomUUID(), p_status: 'sent' }))?.outcome === 'not_found', 'a contract that does not exist is not found');
  const audit = await rest('GET', 'audit', `audit_log?subject_id=eq.${id}&select=action,actor_id,before,after&order=id.asc`);
  const actions = (audit.json ?? []).map((r) => r.action);
  check(actions.includes('contract.created') && actions.filter((x) => x === 'contract.status_changed').length === 2, 'created and both moves are audited', actions.join(' · '));
  check((audit.json ?? []).every((r) => r.actor_id === owner.id), 'each names who did it');
  const move = (audit.json ?? []).filter((r) => r.action === 'contract.status_changed').pop();
  check(move?.before?.status === 'sent' && move?.after?.status === 'signed', 'with the before and the after');

  // ── C ───────────────────────────────────────────────────────────────────
  console.log('\nC. A lead keeps files through doors');
  const f1 = one(await door(owner.token, 'crm', 'add_lead_file', { p_lead_id: a.lead.id, p_title: `${MARKER} brief`, p_url: 'https://files.example/brief.pdf' }));
  check(f1?.outcome === 'added' && f1.file_id, 'the owner adds a link to the lead', f1?.outcome);
  if (f1?.file_id) created.files.push(f1.file_id);
  const f2 = one(await door(owner.token, 'crm', 'add_lead_file', { p_lead_id: a.lead.id, p_title: `${MARKER} brand`, p_url: 'https://files.example/brand.pdf' }));
  if (f2?.file_id) created.files.push(f2.file_id);
  check(one(await door(owner.token, 'crm', 'add_lead_file', { p_lead_id: a.lead.id, p_title: 'again', p_url: 'HTTPS://files.example/BRIEF.pdf' }))?.outcome === 'duplicate', 'the same link is not kept twice, whatever its case');
  check(one(await door(owner.token, 'crm', 'add_lead_file', { p_lead_id: a.lead.id, p_title: 'x', p_url: 'ftp://x/y' }))?.outcome === 'invalid_url', 'a link that is not http(s) is refused');
  check(one(await door(owner.token, 'crm', 'add_lead_file', { p_lead_id: a.lead.id, p_title: ' ', p_url: 'https://x.example/z' }))?.outcome === 'invalid_title', 'a blank title is refused');
  check(one(await door(member, 'crm', 'add_lead_file', { p_lead_id: a.lead.id, p_title: 'x', p_url: 'https://x.example/z' }))?.outcome === 'not_authorized', 'a member may not add one');
  check(one(await door(owner.token, 'crm', 'add_lead_file', { p_lead_id: randomUUID(), p_title: 'x', p_url: 'https://x.example/z' }))?.outcome === 'not_found', 'a lead that does not exist is not found');
  const listed = await fx.call(owner.token, 'GET', 'crm', `lead_files?lead_id=eq.${a.lead.id}&select=title,url,added_by,added_at,carried_to_project_id&order=added_at.asc`);
  check(listed.json?.length === 2 && listed.json[0].added_by === owner.id && listed.json[0].added_at && listed.json[0].carried_to_project_id === null, 'the owner reads them: title, url, who and when, not yet carried');
  const direct = await fx.call(owner.token, 'POST', 'crm', 'lead_files', { organization_id: ORG, lead_id: a.lead.id, title: 'direct', url: 'https://x.example/direct' });
  check(!direct.ok, 'a direct insert through PostgREST is refused', `${direct.status}`);
  const directDel = await fx.call(owner.token, 'DELETE', 'crm', `lead_files?id=eq.${f2?.file_id}`);
  check(!directDel.ok || (directDel.json ?? []).length === 0, 'and so is a direct delete', `${directDel.status}`);
  const f3 = one(await door(owner.token, 'crm', 'add_lead_file', { p_lead_id: a.lead.id, p_title: `${MARKER} temp`, p_url: 'https://files.example/temp.pdf' }));
  if (f3?.file_id) created.files.push(f3.file_id);
  check(one(await door(member, 'crm', 'remove_lead_file', { p_file_id: f3?.file_id }))?.outcome === 'not_authorized', 'a member may not remove one');
  check(one(await door(owner.token, 'crm', 'remove_lead_file', { p_file_id: f3?.file_id }))?.outcome === 'removed', 'the owner removes it');
  check(one(await door(owner.token, 'crm', 'remove_lead_file', { p_file_id: f3?.file_id }))?.outcome === 'not_found', 'removing it again says not found');
  const fAudit = await rest('GET', 'audit', `audit_log?subject_id=in.(${f1?.file_id},${f3?.file_id})&select=action&order=id.asc`);
  const fActions = (fAudit.json ?? []).map((r) => r.action);
  check(fActions.includes('lead_file.added') && fActions.includes('lead_file.removed'), 'adding and removing are audited', fActions.join(' · '));

  // ── D ───────────────────────────────────────────────────────────────────
  console.log('\nD. The carry to the project is claimed, once');
  check(one(await door(owner.token, 'crm', 'claim_lead_file_carry', { p_file_id: f1.file_id, p_project_id: otherProject.id }))?.outcome === 'wrong_project', 'a project that is not the one this lead\'s won deal became is refused');
  check(one(await door(member, 'crm', 'claim_lead_file_carry', { p_file_id: f1.file_id, p_project_id: project.id }))?.outcome === 'not_authorized', 'a member may not claim');
  const race = await Promise.all(Array.from({ length: 6 }, () => door(owner.token, 'crm', 'claim_lead_file_carry', { p_file_id: f1.file_id, p_project_id: project.id })));
  const outcomes = race.map((r) => one(r)?.outcome);
  check(outcomes.filter((o) => o === 'claimed').length === 1 && outcomes.filter((o) => o === 'already_carried').length === 5, 'six simultaneous claims: exactly one wins', outcomes.join(','));
  const carried = one(await rest('GET', 'crm', `lead_files?id=eq.${f1.file_id}&select=carried_to_project_id,carried_at`));
  check(carried?.carried_to_project_id === project.id && carried?.carried_at, 'the link records the project it was carried to, and when');
  check(one(await door(owner.token, 'crm', 'claim_lead_file_carry', { p_file_id: f1.file_id, p_project_id: project.id }))?.outcome === 'already_carried', 'a repairing re-run finds it already carried');
  check(one(await door(owner.token, 'crm', 'release_lead_file_carry', { p_file_id: f1.file_id, p_project_id: project.id }))?.outcome === 'released', 'a copy that failed hands its claim back');
  check(one(await door(owner.token, 'crm', 'claim_lead_file_carry', { p_file_id: f1.file_id, p_project_id: project.id }))?.outcome === 'claimed', 'and the next conversion claims it again');
  const openFile = one(await door(owner.token, 'crm', 'add_lead_file', { p_lead_id: b.lead.id, p_title: `${MARKER} open`, p_url: 'https://files.example/open.pdf' }));
  if (openFile?.file_id) created.files.push(openFile.file_id);
  check(one(await door(owner.token, 'crm', 'claim_lead_file_carry', { p_file_id: openFile?.file_id, p_project_id: project.id }))?.outcome === 'wrong_project', 'a lead whose deal is not won carries nothing to any project');

  // ── E ───────────────────────────────────────────────────────────────────
  console.log('\nE. When a lead last wrote is the newest CLIENT message');
  const conv = one(await rest('POST', 'crm', 'conversations', { organization_id: ORG, lead_id: a.lead.id, contact_id: a.contact.id, channel: 'whatsapp', external_ref: `${MARKER}:conv`, status: 'active' }));
  created.conversations.push(conv.id);
  const day = 86_400_000;
  const at = (ms) => new Date(Date.now() - ms).toISOString();
  const msgs = [
    { seq: 1, author_type: 'client', body: 'hello', occurred_at: at(5 * day) },
    { seq: 2, author_type: 'client', body: 'are you there?', occurred_at: at(2 * day) },
    { seq: 3, author_type: 'user', body: 'yes, replying', occurred_at: at(1 * day) },
  ];
  for (const m of msgs) {
    const r = await rest('POST', 'crm', 'conversation_messages', { organization_id: ORG, conversation_id: conv.id, ...m });
    if (!r.ok) fail(`fixture: message ${m.seq} refused — ${r.text.slice(0, 200)}`);
  }
  const conv2 = one(await rest('POST', 'crm', 'conversations', { organization_id: ORG, lead_id: b.lead.id, contact_id: b.contact.id, channel: 'whatsapp', external_ref: `${MARKER}:conv2`, status: 'active' }));
  created.conversations.push(conv2.id);
  await rest('POST', 'crm', 'conversation_messages', { organization_id: ORG, conversation_id: conv2.id, seq: 1, author_type: 'user', body: 'we wrote first', occurred_at: at(1 * day) });
  const inbound = (await fx.call(owner.token, 'POST', 'crm', 'rpc/last_inbound_by_lead', {})).json ?? [];
  const mine = inbound.find((r) => r.lead_id === a.lead.id);
  const drift = mine ? Math.abs(new Date(mine.last_inbound_at).getTime() - (Date.now() - 2 * day)) : Infinity;
  check(Boolean(mine) && drift < 5000, 'a lead\'s last inbound is its newest client message, not the agency\'s later reply', mine?.last_inbound_at);
  check(!inbound.some((r) => r.lead_id === b.lead.id), 'a lead who has never written has no inbound time (its silence runs from creation)');
} finally {
  for (const id of created.contracts) await rest('DELETE', 'sales', `contracts?id=eq.${id}`);
  for (const id of created.files) await rest('DELETE', 'crm', `lead_files?id=eq.${id}`);
  for (const id of created.conversations) {
    await rest('DELETE', 'crm', `conversation_messages?conversation_id=eq.${id}`);
    await rest('DELETE', 'crm', `conversations?id=eq.${id}`);
  }
  for (const id of created.projects) {
    await rest('DELETE', 'core', `jobs?kind=eq.phase_two.start&payload->>subjectId=eq.${id}`);
    await rest('DELETE', 'core', `outbox_events?type=eq.project.handoff_bound&subject_id=eq.${id}`);
    await rest('DELETE', 'projects', `projects?id=eq.${id}`);
  }
  for (const id of created.opportunities) {
    await rest('DELETE', 'ai', `handoffs?subject_type=eq.opportunity&subject_id=eq.${id}`);
    await rest('DELETE', 'core', `outbox_events?subject_id=eq.${id}`);
    await rest('DELETE', 'sales', `opportunities?id=eq.${id}`);
  }
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  for (const id of created.contacts) await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
  await fx.cleanup();
}

console.log(
  failures === 0
    ? `\n\x1b[32m✔ ${checks} checks passed — a contract lives on a won deal, and a lead's files carry over once\x1b[0m\n`
    : `\n\x1b[31m✖ ${failures} of ${checks} checks failed\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
