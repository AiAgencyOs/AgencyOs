// ═══════════════════════════════════════════════════════════════════════════
// A member belongs to a department.
//
// Owner decision 2, migration 20261005100100. Proven against real Postgres:
//   A. the list is fixed in the schema: six names, nothing else, even written
//      directly by an owner
//   B. an owner or an ops admin sets and clears a department through the door;
//      every other role is refused
//   C. a person outside the organisation cannot be given one; the audit names
//      who set it and what it was before
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { startKit } from './verify-kit-r1.mjs';

const k = await startKit('a member belongs to a department', 'zztest-dept');
const { check, rest, one, section } = k;
const rpc = k.rpc('core');

try {
  const owner = await k.makeUser('owner');
  const admin = await k.makeUser('ops_admin');
  const lead = await k.makeUser('delivery_lead');
  const member = await k.makeUser('member');
  const target = await k.makeUser('member');
  const dept = async (id) => one(await rest('GET', 'core', `memberships?user_id=eq.${id}&select=department`))?.department;

  section('A. the list is fixed in the schema');
  check((await dept(target.id)) === null, 'a new member has no department');
  for (const bad of ['Marketing', 'design', '']) {
    const r = await rest('PATCH', 'core', `memberships?user_id=eq.${target.id}`, { department: bad }, owner.token);
    check(!r.ok, `writing "${bad}" directly is refused by the table`, `${r.status}`);
  }
  for (const name of ['Design', 'Development', 'QA', 'Sales', 'Management', 'Operations']) {
    const r = one(await rpc('set_member_department', { p_user_id: target.id, p_department: name }, owner.token));
    check(r?.outcome === 'set' && (await dept(target.id)) === name, `${name} is accepted`, r?.outcome);
  }
  check(one(await rpc('set_member_department', { p_user_id: target.id, p_department: 'Marketing' }, owner.token))?.outcome === 'invalid_department', 'a name outside the list is refused by the door');

  section('B. an owner or an ops admin sets it; nobody else');
  check(one(await rpc('set_member_department', { p_user_id: target.id, p_department: 'QA' }, admin.token))?.outcome === 'set', 'an ops admin sets a department');
  check((await dept(target.id)) === 'QA', 'and it is stored');
  check(one(await rpc('set_member_department', { p_user_id: target.id, p_department: 'QA' }, admin.token))?.outcome === 'unchanged', 'setting the same one again changes nothing');
  for (const [who, u] of [['delivery lead', lead], ['member', member]]) {
    const r = one(await rpc('set_member_department', { p_user_id: target.id, p_department: 'Sales' }, u.token));
    check(r?.outcome === 'forbidden', `a ${who} may not set a department`, r?.outcome);
  }
  const ownDept = one(await rpc('set_member_department', { p_user_id: member.id, p_department: 'Sales' }, member.token));
  check(ownDept?.outcome === 'forbidden', 'nor their own');
  check((await dept(target.id)) === 'QA', 'the refusals left it as it was');
  const cleared = one(await rpc('set_member_department', { p_user_id: target.id, p_department: null }, owner.token));
  check(cleared?.outcome === 'set' && (await dept(target.id)) === null, 'null clears it', cleared?.outcome);

  section('C. only a member of this organisation; every change is audited');
  check(one(await rpc('set_member_department', { p_user_id: randomUUID(), p_department: 'Design' }, owner.token))?.outcome === 'not_a_member', 'a stranger is not a member');
  await rpc('set_member_department', { p_user_id: target.id, p_department: 'Design' }, owner.token);
  await rpc('set_member_department', { p_user_id: target.id, p_department: 'Development' }, admin.token);
  const audit = await rest('GET', 'audit', `audit_log?action=eq.membership.department_set&after->>userId=eq.${target.id}&select=actor_id,before,after&order=id.asc`);
  const rows = Array.isArray(audit.json) ? audit.json : [];
  check(rows.length >= 2, 'each change leaves an audit row', `${rows.length} rows`);
  const last = rows[rows.length - 1];
  check(last?.actor_id === admin.id && last?.before?.department === 'Design' && last?.after?.department === 'Development', 'the last row names the ops admin and what it was before', JSON.stringify(last));
} finally {
  await k.cleanup();
}
k.finish();
