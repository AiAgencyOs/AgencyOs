// ═══════════════════════════════════════════════════════════════════════════
// The clauses a quotation prints are the owner's, and are kept.
//
// Configurability audit B-6. Clauses 2-5 of a quotation's commercial terms are
// versioned rows the owner publishes (sales.quotation_clauses), and a
// quotation keeps the versions it printed (sales.proposals.clauses_printed).
// This proves, against real Postgres, the rules that make that safe — none of
// which can be checked by reading TypeScript:
//
//   1. only an owner or ops admin publishes, and only through the door
//   2. every publish is a NEW version: nothing is edited or deleted, and a
//      publish that says what is already in force is 'unchanged'
//   3. the wording is bounded: 10-1200 characters, no markup, one line
//   4. every internal role reads; nobody writes the table directly
//   5. a draft is answered with today's clauses and stores nothing
//   6. the first ask on an issued quotation freezes what was in force, and
//      publishing afterwards never changes that quotation — only the next one
//   7. the snapshot itself cannot be rewritten, and a draft cannot be given one
//   8. the audit names the key, the version and who
//
//   node scripts/verify-quotation-clauses.mjs
// ═══════════════════════════════════════════════════════════════════════════

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
announceTarget(target, 'the clauses a quotation prints are the owner\'s, and are kept');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-clauses';
const ORG = '00000000-0000-4000-8000-000000000001';

const mint = (userId, role) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub: userId, aud: 'authenticated', role: 'authenticated', app_metadata: { organization_id: ORG, role }, iat: now, exp: now + 900 });
  return `${header}.${body}.${createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url')}`;
};

let failures = 0;
function check(condition, description, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${description}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

const parse = (t) => {
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return t;
  }
};

async function rest(method, schema, path, body, token) {
  const key = token ?? KEY;
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Profile': schema, 'Accept-Profile': schema, Prefer: 'return=representation' },
    cache: 'no-store',
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ok: res.ok, status: res.status, json: parse(await res.text()) };
}
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const rpc = (schema, fn, args, token) => rest('POST', schema, `rpc/${fn}`, args, token);
const publish = (key, body, token) => rpc('core', 'publish_quotation_clause', { p_key: key, p_body: body }, token).then(one);

const created = { users: [], leads: [], opportunities: [], policy: null };

async function makeUser(role) {
  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${MARKER}-${role}-${randomUUID().slice(0, 8)}@example.invalid`, password: randomUUID(), email_confirm: true }),
  }).then((r) => r.json());
  created.users.push(authUser.id);
  await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email, full_name: `${MARKER} ${role}` });
  await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: authUser.id, role, status: 'active' });
  return { id: authUser.id, token: mint(authUser.id, role) };
}

async function newDeal(name) {
  const lead = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, source: 'manual', title: `${MARKER} ${name}`, status: 'new' }));
  created.leads.push(lead.id);
  const opportunity = one(
    await rest('POST', 'sales', 'opportunities', { organization_id: ORG, lead_id: lead.id, name: `${MARKER} ${name}`, stage: 'discovery', value_minor: 0, currency: 'INR' }),
  );
  created.opportunities.push(opportunity.id);
  return opportunity.id;
}

const KEYS = ['acceptance_window', 'cancellation', 'liability_cap', 'jurisdiction'];
const V1 = 'Zztest wording one: a milestone is accepted after 3 working days.';
const V2 = 'Zztest wording two: a milestone is accepted after 7 working days.';
const V3 = 'Zztest wording three: a milestone is accepted after 10 working days.';

try {
  const owner = await makeUser('owner');
  const admin = await makeUser('ops_admin');
  const member = await makeUser('member');
  const contractor = await makeUser('contractor');
  const lead = await makeUser('delivery_lead');

  // ── A. who may publish ───────────────────────────────────────────────────
  console.log('\n  A. only an owner or ops admin publishes');
  const first = await publish('acceptance_window', V1, owner.token);
  check(first?.outcome === 'published' && first?.version === 1, 'the owner publishes version 1', `${first?.outcome} v${first?.version}`);
  const second = await publish('acceptance_window', V2, admin.token);
  check(second?.outcome === 'published' && second?.version === 2, 'an ops admin publishes version 2 — appended, not edited', `${second?.outcome} v${second?.version}`);
  for (const [who, u] of [['member', member], ['contractor', contractor], ['delivery lead', lead]]) {
    const r = await publish('acceptance_window', V3, u.token);
    check(r?.outcome === 'not_authorized', `a ${who} may not publish`, r?.outcome);
  }
  const anon = await rpc('core', 'publish_quotation_clause', { p_key: 'acceptance_window', p_body: V3 });
  check(one(anon)?.outcome === 'no_actor' || !anon.ok, 'no session cannot publish', `${anon.status}`);
  const same = await publish('acceptance_window', V2, owner.token);
  check(same?.outcome === 'unchanged' && same?.version === 2, 'saying what is already in force publishes nothing new', `${same?.outcome} v${same?.version}`);

  // ── B. the refusals ──────────────────────────────────────────────────────
  console.log('\n  B. the wording is bounded');
  const badKey = await publish('payment_terms', V3, owner.token);
  check(badKey?.outcome === 'invalid_key', 'a key that is not one of the four is refused', badKey?.outcome);
  for (const [why, body] of [
    ['too short', 'too short'],
    ['too long', 'x'.repeat(1201)],
    ['markup', 'Payable within <b>7 days</b> of the invoice date.'],
    ['a line break', 'Line one is fine.\nLine two is not fine.'],
    ['blank', '          '],
  ]) {
    const r = await publish('cancellation', body, owner.token);
    check(r?.outcome === 'invalid_body', `wording that is ${why} is refused`, r?.outcome);
  }
  const edge = await publish('cancellation', 'x'.repeat(1200), owner.token);
  check(edge?.outcome === 'published', 'exactly 1200 characters is accepted', edge?.outcome);
  const listedAfterRefusals = (await rest('GET', 'sales', `quotation_clauses?clause_key=eq.cancellation&select=version`, null, owner.token)).json ?? [];
  check(listedAfterRefusals.length === 1, 'and none of the refusals wrote a row', `${listedAfterRefusals.length} rows`);

  // ── C. reading, and no path but the door ────────────────────────────────
  console.log('\n  C. every internal role reads; nobody writes the table directly');
  for (const [who, u] of [['owner', owner], ['ops admin', admin], ['member', member], ['contractor', contractor]]) {
    const listed = await rpc('core', 'list_quotation_clauses', {}, u.token);
    const rows = Array.isArray(listed.json) ? listed.json : [];
    check(rows.filter((r) => r.clause_key === 'acceptance_window').length === 2, `${who}: the list shows both versions`, `${rows.length} rows`);
    const top = rows.find((r) => r.clause_key === 'acceptance_window');
    check(top?.version === 2 && top?.body === V2, `${who}: newest first`);
    check(typeof top?.created_by_name === 'string' && /ops.?admin/i.test(top.created_by_name), `${who}: it names who published`, top?.created_by_name);
  }
  for (const [who, u] of [['owner', owner], ['ops admin', admin], ['member', member]]) {
    const write = await rest('POST', 'sales', 'quotation_clauses', { organization_id: ORG, clause_key: 'liability_cap', version: 1, body: 'A directly inserted clause body.', created_by: u.id }, u.token);
    check(!write.ok, `${who}: a direct insert is refused`, `${write.status}`);
    const patch = await rest('PATCH', 'sales', 'quotation_clauses?clause_key=eq.acceptance_window', { body: 'Tampered with in place, ten characters.' }, u.token);
    check(!patch.ok || (Array.isArray(patch.json) && patch.json.length === 0), `${who}: a direct update changes nothing`, `${patch.status}`);
    const del = await rest('DELETE', 'sales', 'quotation_clauses?clause_key=eq.acceptance_window', null, u.token);
    check(!del.ok || (Array.isArray(del.json) && del.json.length === 0), `${who}: a direct delete removes nothing`, `${del.status}`);
  }
  const tamperService = await rest('PATCH', 'sales', `quotation_clauses?clause_key=eq.acceptance_window&version=eq.1`, { body: 'Even the service role cannot edit one.' });
  check(!tamperService.ok, 'and even the service role cannot edit a published clause in place', `${tamperService.status}`);
  const v1 = one(await rest('GET', 'sales', 'quotation_clauses?clause_key=eq.acceptance_window&version=eq.1&select=body'));
  check(v1?.body === V1, 'version 1 still says exactly what the owner published');

  // ── D. what a quotation printed ──────────────────────────────────────────
  console.log('\n  D. a quotation keeps the clause it printed');
  const existingPolicy = (await rest('GET', 'approvals', `approval_policies?organization_id=eq.${ORG}&subject_type=eq.proposal&min_amount_minor=eq.0&select=id`)).json ?? [];
  if (existingPolicy.length === 0) {
    const policy = one(await rest('POST', 'approvals', 'approval_policies', { organization_id: ORG, subject_type: 'proposal', min_amount_minor: 0, required_role: 'owner', sla_hours: 48, audience: 'internal' }));
    created.policy = policy?.id ?? null;
  }

  const approvedQuote = async (name) => {
    const deal = await newDeal(name);
    const drafted = one(await rpc('sales', 'draft_proposal', { p_opportunity_id: deal, p_title: `${MARKER} ${name}` }));
    await rpc('sales', 'add_proposal_item', { p_proposal_id: drafted.proposal_id, p_description: 'Work', p_quantity: 1, p_unit_price_minor: 100000 });
    return { id: drafted.proposal_id, deal };
  };
  const approve = async (id) => {
    const sub = one(await rpc('sales', 'submit_proposal', { p_proposal_id: id, p_requested_by: owner.id }));
    await rpc('approvals', 'decide_approval', { p_request_id: sub?.request_id, p_decision: 'approved' }, owner.token);
    const synced = await rpc('sales', 'sync_proposal_decision', { p_proposal_id: id });
    return String(synced.json);
  };

  const q1 = await approvedQuote('first');
  const draftRead = one(await rpc('sales', 'clauses_for_proposal', { p_proposal_id: q1.id }, member.token));
  check(draftRead?.outcome === 'live' && draftRead?.clauses?.acceptance_window?.version === 2, 'a draft is answered with the clauses in force now', draftRead?.outcome);
  check(draftRead?.clauses?.jurisdiction === undefined, 'a clause nobody published is absent, so the code constant prints');
  const draftRow = one(await rest('GET', 'sales', `proposals?id=eq.${q1.id}&select=clauses_printed`));
  check(draftRow?.clauses_printed === null, 'and a draft stores nothing');

  const draftForge = await rest('PATCH', 'sales', `proposals?id=eq.${q1.id}`, { clauses_printed: { jurisdiction: { version: 9, body: 'Forged onto a draft.' } } });
  check(!draftForge.ok, 'a draft cannot be handed a snapshot directly', `${draftForge.status}`);

  check((await approve(q1.id)) === 'approved', 'the quotation is approved');
  const frozen = one(await rpc('sales', 'clauses_for_proposal', { p_proposal_id: q1.id }, member.token));
  check(frozen?.outcome === 'frozen' && frozen?.clauses?.acceptance_window?.body === V2, 'the first ask after approval freezes what was in force (version 2)', frozen?.outcome);

  const v3 = await publish('acceptance_window', V3, owner.token);
  check(v3?.outcome === 'published' && v3?.version === 3, 'the owner then publishes version 3', `v${v3?.version}`);
  const jur = await publish('jurisdiction', 'Zztest: the courts at Pune have jurisdiction over this quotation.', owner.token);
  check(jur?.outcome === 'published', 'and puts a jurisdiction of their own', jur?.outcome);

  const again = one(await rpc('sales', 'clauses_for_proposal', { p_proposal_id: q1.id }, owner.token));
  check(again?.outcome === 'frozen' && again?.clauses?.acceptance_window?.version === 2 && again?.clauses?.acceptance_window?.body === V2, 're-rendering the issued quotation still reads version 2, never today\'s', `v${again?.clauses?.acceptance_window?.version}`);
  check(again?.clauses?.jurisdiction === undefined, 'and does not pick up a clause published after it was issued');
  const service = one(await rpc('sales', 'clauses_for_proposal', { p_proposal_id: q1.id }));
  check(service?.outcome === 'frozen' && service?.clauses?.acceptance_window?.version === 2, 'the worker (service role) reads the same snapshot');

  const q2 = await approvedQuote('second');
  check((await approve(q2.id)) === 'approved', 'a second quotation is approved after the change');
  const next = one(await rpc('sales', 'clauses_for_proposal', { p_proposal_id: q2.id }, owner.token));
  check(next?.clauses?.acceptance_window?.version === 3 && next?.clauses?.jurisdiction?.body?.includes('Pune'), 'and it takes version 3 and the new jurisdiction', `v${next?.clauses?.acceptance_window?.version}`);
  const first2 = one(await rpc('sales', 'clauses_for_proposal', { p_proposal_id: q1.id }, owner.token));
  check(first2?.clauses?.acceptance_window?.version === 2, 'while the first is unmoved');

  console.log('\n  E. the snapshot cannot be rewritten');
  const rewrite = await rest('PATCH', 'sales', `proposals?id=eq.${q1.id}`, { clauses_printed: { acceptance_window: { version: 3, body: 'Rewritten after it was issued.' } } });
  check(!rewrite.ok, 'a snapshot cannot be replaced, even by the service role', `${rewrite.status}`);
  const clear = await rest('PATCH', 'sales', `proposals?id=eq.${q1.id}`, { clauses_printed: null });
  check(!clear.ok, 'or cleared', `${clear.status}`);
  const stillFrozen = one(await rest('GET', 'sales', `proposals?id=eq.${q1.id}&select=clauses_printed`));
  check(stillFrozen?.clauses_printed?.acceptance_window?.version === 2, 'and it still says version 2');
  const outsider = one(await rpc('sales', 'clauses_for_proposal', { p_proposal_id: randomUUID() }, owner.token));
  check(outsider?.outcome === 'not_found', 'a quotation that does not exist is not_found', outsider?.outcome);

  // ── F. the audit ─────────────────────────────────────────────────────────
  console.log('\n  F. the audit names the key, the version and who');
  const audit = await rest('GET', 'audit', 'audit_log?action=eq.quotation_clause.published&select=actor_id,before,after&order=id.asc');
  const rows = (Array.isArray(audit.json) ? audit.json : []).filter((a) => String(a.after?.body ?? '').startsWith('Zztest'));
  check(rows.length >= 4, 'every publish is recorded', `${rows.length} rows`);
  // audit rows outlive a run, so a rerun sees the earlier runs' version 2 too: look for THIS run's actor
  const v2row = rows.find((a) => a.after?.key === 'acceptance_window' && a.after?.version === 2 && a.actor_id === admin.id);
  check(v2row?.actor_id === admin.id && v2row?.after?.by === admin.id, 'version 2 names the ops admin who published it');
  check(v2row?.before?.version === 1 && v2row?.before?.body === V1, 'and carries the version it replaced');
} finally {
  for (const id of created.opportunities) {
    const quotes = (await rest('GET', 'sales', `proposals?opportunity_id=eq.${id}&select=id`)).json ?? [];
    for (const q of quotes) {
      await rest('DELETE', 'core', `outbox_events?subject_id=eq.${q.id}`);
      await rest('DELETE', 'sales', `proposal_items?proposal_id=eq.${q.id}`);
    }
    await rest('DELETE', 'sales', `proposals?opportunity_id=eq.${id}`);
    await rest('DELETE', 'sales', `opportunities?id=eq.${id}`);
  }
  await rest('DELETE', 'core', 'outbox_events?subject_type=eq.approval_request');
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  const pending = await rest('GET', 'approvals', 'approval_requests?state=eq.pending&select=id');
  for (const row of pending.json ?? []) {
    await rest('PATCH', 'approvals', `approval_requests?id=eq.${row.id}`, { state: 'cancelled', decided_at: new Date().toISOString() });
  }
  if (created.policy) await rest('DELETE', 'approvals', `approval_policies?id=eq.${created.policy}`);
  // What this script published, and only that: the service role may delete.
  for (const key of KEYS) await rest('DELETE', 'sales', `quotation_clauses?clause_key=eq.${key}&body=like.Zztest*`);
  await rest('DELETE', 'sales', `quotation_clauses?clause_key=eq.cancellation&body=like.xxxxxxxxxx*`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  }
}

if (failures > 0) {
  console.error(`\n  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
