// ═══════════════════════════════════════════════════════════════════════════
// A requirement has a priority, an assignee and linked files — after the scope
// is frozen.
//
// Owner decisions 5 and 6, migration 20261005100300. Proven against real
// Postgres:
//   A. priority and assignee are written on a FROZEN scope, and the frozen
//      scope row is byte-for-byte what it was (the wording never changes; the
//      frozen-scope trigger still refuses an edit)
//   B. priority is High/Medium/Low; the assignee is an active member of the
//      organisation; nothing is writable directly by any role
//   C. an attachment is a link to a file of the SAME project, not in the trash;
//      unlinking removes the link and never the file
//   D. every door is audited and refuses a role that cannot write
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { ORG, startKit } from './verify-kit-r1.mjs';

const k = await startKit('a requirement has a priority, an assignee and linked files', 'zztest-reqplan');
const { check, rest, one, section } = k;
const rpc = k.rpc('projects');

try {
  const owner = await k.makeUser('owner');
  const member = await k.makeUser('member');
  const finance = await k.makeUser('finance');
  const project = await k.makeProject('a');
  const other = await k.makeProject('b');

  // A frozen scope: a draft version with one item, then frozen (status active).
  const version = one(await rest('POST', 'projects', 'scope_versions', { organization_id: ORG, project_id: project.id, version: 1, status: 'draft', source: 'onboarding' }));
  const item = one(await rest('POST', 'projects', 'scope_items', { organization_id: ORG, scope_version_id: version.id, title: 'Home screen', detail: 'Hero and carousel', acceptance_criteria: 'Loads in 2s', inclusion: 'included', position: 0 }));
  if (!item?.id) k.fail(`could not create the fixture scope item: ${JSON.stringify(item)}`);
  const freeze = await rest('PATCH', 'projects', `scope_versions?id=eq.${version.id}`, { status: 'active', frozen_at: new Date().toISOString() });
  check(freeze.ok, 'the fixture scope is frozen', `${freeze.status}`);
  const edit = await rest('PATCH', 'projects', `scope_items?id=eq.${item.id}`, { title: 'Changed' });
  check(!edit.ok, 'and the frozen scope row refuses an edit (the rule this feature must never touch)', `${edit.status}`);
  const frozenBefore = JSON.stringify(one(await rest('GET', 'projects', `scope_items?id=eq.${item.id}&select=*`)));

  const file = one(await rest('POST', 'projects', 'project_files', { organization_id: ORG, project_id: project.id, category: 'requirements', title: 'Wireframes.pdf', url: 'https://example.invalid/wireframes.pdf' }));
  const file2 = one(await rest('POST', 'projects', 'project_files', { organization_id: ORG, project_id: project.id, category: 'design', title: 'Brand guide', url: 'https://example.invalid/brand' }));
  const foreignFile = one(await rest('POST', 'projects', 'project_files', { organization_id: ORG, project_id: other.id, category: 'other', title: 'Somebody else', url: 'https://example.invalid/x' }));
  const trashed = one(await rest('POST', 'projects', 'project_files', { organization_id: ORG, project_id: project.id, category: 'other', title: 'Trashed', url: 'https://example.invalid/t', deleted_at: new Date().toISOString(), deleted_by: owner.id }));
  const plan = async () => one(await rest('GET', 'projects', `scope_item_plans?scope_item_id=eq.${item.id}&select=priority,assignee_id,updated_by`));

  section('A. priority and assignee are written after the freeze, beside the frozen row');
  const set = one(await rpc('set_requirement_plan', { p_scope_item_id: item.id, p_priority: 'high', p_assignee_id: member.id }, member.token));
  check(set?.outcome === 'set', 'a writer sets priority and assignee on a frozen requirement', set?.outcome);
  const stored = await plan();
  check(stored?.priority === 'high' && stored?.assignee_id === member.id && stored?.updated_by === member.id, 'both are stored, with who set them', JSON.stringify(stored));
  const changed = one(await rpc('set_requirement_plan', { p_scope_item_id: item.id, p_priority: 'low', p_assignee_id: null }, owner.token));
  check(changed?.outcome === 'set' && (await plan())?.priority === 'low' && (await plan())?.assignee_id === null, 'it can be changed again, and the assignee cleared');
  check(JSON.stringify(one(await rest('GET', 'projects', `scope_items?id=eq.${item.id}&select=*`))) === frozenBefore, 'the frozen scope row is exactly what it was');
  const cleared = one(await rpc('set_requirement_plan', { p_scope_item_id: item.id, p_priority: null, p_assignee_id: null }, owner.token));
  check(cleared?.outcome === 'set' && (await plan())?.priority === null, 'priority can be unset');

  section('B. High, Medium or Low; an active member; no direct write');
  for (const p of ['high', 'medium', 'low', 'High ']) {
    const r = one(await rpc('set_requirement_plan', { p_scope_item_id: item.id, p_priority: p, p_assignee_id: null }, owner.token));
    check(r?.outcome === 'set', `"${p}" is accepted`, r?.outcome);
  }
  check(one(await rpc('set_requirement_plan', { p_scope_item_id: item.id, p_priority: 'urgent', p_assignee_id: null }, owner.token))?.outcome === 'invalid_priority', 'a priority off the list is refused');
  check(one(await rpc('set_requirement_plan', { p_scope_item_id: item.id, p_priority: 'low', p_assignee_id: randomUUID() }, owner.token))?.outcome === 'invalid_assignee', 'an assignee who is not a member is refused');
  check(one(await rpc('set_requirement_plan', { p_scope_item_id: randomUUID(), p_priority: 'low', p_assignee_id: null }, owner.token))?.outcome === 'not_found', 'an unknown requirement is not found');
  for (const [who, token] of [['owner', owner.token], ['member', member.token]]) {
    const w = await rest('POST', 'projects', 'scope_item_plans', { organization_id: ORG, scope_item_id: item.id, priority: 'high' }, token);
    check(!w.ok, `${who}: a direct insert into the plan is refused`, `${w.status}`);
    const l = await rest('POST', 'projects', 'scope_item_files', { organization_id: ORG, scope_item_id: item.id, file_id: file.id }, token);
    check(!l.ok, `${who}: a direct insert of a link is refused`, `${l.status}`);
  }

  section('C. an attachment is a link to a file of the same project');
  const linked = one(await rpc('link_requirement_file', { p_scope_item_id: item.id, p_file_id: file.id }, member.token));
  check(linked?.outcome === 'linked', 'a writer attaches a project file', linked?.outcome);
  check(one(await rpc('link_requirement_file', { p_scope_item_id: item.id, p_file_id: file2.id }, member.token))?.outcome === 'linked', 'and a second one');
  check(one(await rpc('link_requirement_file', { p_scope_item_id: item.id, p_file_id: file.id }, member.token))?.outcome === 'already_linked', 'the same file twice is refused');
  check(one(await rpc('link_requirement_file', { p_scope_item_id: item.id, p_file_id: foreignFile.id }, member.token))?.outcome === 'other_project', 'a file of another project is refused');
  check(one(await rpc('link_requirement_file', { p_scope_item_id: item.id, p_file_id: trashed.id }, member.token))?.outcome === 'file_not_found', 'a file in the trash is refused');
  check(one(await rpc('link_requirement_file', { p_scope_item_id: item.id, p_file_id: randomUUID() }, member.token))?.outcome === 'file_not_found', 'an unknown file is refused');
  const links = await rest('GET', 'projects', `scope_item_files?scope_item_id=eq.${item.id}&select=file_id`, null, owner.token);
  check(Array.isArray(links.json) && links.json.length === 2, 'two links are stored');
  const unlinked = one(await rpc('unlink_requirement_file', { p_scope_item_id: item.id, p_file_id: file.id }, member.token));
  check(unlinked?.outcome === 'unlinked', 'a writer detaches a file', unlinked?.outcome);
  check(one(await rest('GET', 'projects', `project_files?id=eq.${file.id}&select=id,deleted_at`))?.deleted_at === null, 'the file itself is untouched');
  check(one(await rpc('unlink_requirement_file', { p_scope_item_id: item.id, p_file_id: file.id }, member.token))?.outcome === 'not_linked', 'detaching it again says it is not attached');

  section('D. audited, and refused to a role that cannot write');
  check(one(await rpc('set_requirement_plan', { p_scope_item_id: item.id, p_priority: 'high', p_assignee_id: null }, finance.token))?.outcome === 'forbidden', 'finance may not plan a requirement');
  check(one(await rpc('link_requirement_file', { p_scope_item_id: item.id, p_file_id: file.id }, finance.token))?.outcome === 'forbidden', 'finance may not attach a file');
  check(one(await rpc('unlink_requirement_file', { p_scope_item_id: item.id, p_file_id: file2.id }, finance.token))?.outcome === 'forbidden', 'finance may not detach one');
  const audit = await rest('GET', 'audit', `audit_log?action=in.(requirement.plan_set,requirement.file_linked,requirement.file_unlinked)&subject_id=eq.${item.id}&select=action,actor_id`);
  const rows = Array.isArray(audit.json) ? audit.json : [];
  const actions = new Set(rows.map((a) => a.action));
  for (const a of ['requirement.plan_set', 'requirement.file_linked', 'requirement.file_unlinked']) check(actions.has(a), `${a} is recorded`);
  check(rows.length > 0 && rows.every((a) => a.actor_id === owner.id || a.actor_id === member.id), 'every row names a person who did it');
} finally {
  await k.cleanup(async () => {
    for (const id of k.created.projects) {
      await rest('DELETE', 'projects', `project_files?project_id=eq.${id}&parent_file_id=not.is.null`);
      await rest('DELETE', 'projects', `project_files?project_id=eq.${id}`);
      // A frozen scope refuses its items being deleted, so the project cannot be hard-deleted:
      // it is soft-deleted (deleted_at) and drops out of every list instead.
      await rest('PATCH', 'projects', `projects?id=eq.${id}`, { deleted_at: new Date().toISOString() });
    }
  });
}
k.finish();
