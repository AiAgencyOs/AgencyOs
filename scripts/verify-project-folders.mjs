// ═══════════════════════════════════════════════════════════════════════════
// A project has folders that exist before a file is in them.
//
// Owner decision 7, migration 20261005100400. Proven against real Postgres:
//   A. a folder is a record: an EMPTY folder exists, in one category of one
//      project; a nested path makes its ancestors; a repeat (any case) is refused
//   B. a file is filed into an existing folder of its own category — never into
//      one that does not exist or belongs to another category — and back to root
//   C. a folder a file already names (any write path) is a real folder too, so
//      the tree never disagrees with the files
//   D. no direct write path for any role; every door is audited; a role that
//      cannot write is refused
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { ORG, startKit } from './verify-kit-r1.mjs';

const k = await startKit('a project has folders that exist before a file is in them', 'zztest-folders');
const { check, rest, one, section } = k;
const rpc = k.rpc('projects');

try {
  const owner = await k.makeUser('owner');
  const member = await k.makeUser('member');
  const finance = await k.makeUser('finance');
  const project = await k.makeProject('a');
  const other = await k.makeProject('b');
  const folders = async (id = project.id) => {
    const r = await rest('GET', 'projects', `project_folders?project_id=eq.${id}&select=category,path&order=category.asc,path.asc`, null, owner.token);
    return (Array.isArray(r.json) ? r.json : []).map((f) => `${f.category}:${f.path}`);
  };
  const mkFile = async (category, title, extra = {}, projectId = project.id) => one(await rest('POST', 'projects', 'project_files', { organization_id: ORG, project_id: projectId, category, title, url: `https://example.invalid/${title}`, ...extra }));

  section('A. an empty folder is a record');
  const created = one(await rpc('create_project_folder', { p_project_id: project.id, p_category: 'design', p_path: 'mockups' }, member.token));
  check(created?.outcome === 'created' && created?.folder_id, 'a writer creates an empty folder', created?.outcome);
  check(JSON.stringify(await folders()) === JSON.stringify(['design:mockups']), 'it exists with no file in it', JSON.stringify(await folders()));
  const nested = one(await rpc('create_project_folder', { p_project_id: project.id, p_category: 'design', p_path: 'mockups/mobile/ios' }, member.token));
  check(nested?.outcome === 'created', 'a nested path is accepted', nested?.outcome);
  check(JSON.stringify(await folders()) === JSON.stringify(['design:mockups', 'design:mockups/mobile', 'design:mockups/mobile/ios']), 'and its ancestors exist too', JSON.stringify(await folders()));
  check(one(await rpc('create_project_folder', { p_project_id: project.id, p_category: 'design', p_path: 'Mockups' }, member.token))?.outcome === 'exists', 'the same name in another case is refused');
  check(one(await rpc('create_project_folder', { p_project_id: project.id, p_category: 'documents', p_path: 'mockups' }, member.token))?.outcome === 'created', 'the same name in another category is a different folder');
  for (const bad of ['', '/x', 'x/', 'a//b', '../x', 'a/../b', 'x'.repeat(201)]) {
    const r = one(await rpc('create_project_folder', { p_project_id: project.id, p_category: 'design', p_path: bad }, member.token));
    check(r?.outcome === 'invalid_path', `"${bad.slice(0, 20)}" is not a folder name`, r?.outcome);
  }
  check(one(await rpc('create_project_folder', { p_project_id: project.id, p_category: 'photos', p_path: 'x' }, member.token))?.outcome === 'invalid_category', 'an unknown category is refused');
  check(one(await rpc('create_project_folder', { p_project_id: randomUUID(), p_category: 'design', p_path: 'x' }, member.token))?.outcome === 'not_found', 'an unknown project is not found');
  check(JSON.stringify(await folders(other.id)) === '[]', 'another project has none of them');

  section('B. a file is filed into an existing folder of its own category');
  const f = await mkFile('design', 'Home.png');
  const filed = one(await rpc('file_into_folder', { p_file_id: f.id, p_path: 'mockups/mobile' }, member.token));
  check(filed?.outcome === 'filed', 'a writer files a file into a folder', filed?.outcome);
  check(one(await rest('GET', 'projects', `project_files?id=eq.${f.id}&select=folder`))?.folder === 'mockups/mobile', 'the file carries the folder');
  check(one(await rpc('file_into_folder', { p_file_id: f.id, p_path: 'mockups/mobile' }, member.token))?.outcome === 'unchanged', 'filing it where it is changes nothing');
  check(one(await rpc('file_into_folder', { p_file_id: f.id, p_path: 'nowhere' }, member.token))?.outcome === 'no_such_folder', 'a folder that does not exist is refused');
  const doc = await mkFile('documents', 'Spec.pdf');
  check(one(await rpc('file_into_folder', { p_file_id: doc.id, p_path: 'mockups/mobile' }, member.token))?.outcome === 'no_such_folder', 'a folder of another category is refused');
  check(one(await rpc('file_into_folder', { p_file_id: randomUUID(), p_path: '' }, member.token))?.outcome === 'not_found', 'an unknown file is not found');
  const root = one(await rpc('file_into_folder', { p_file_id: f.id, p_path: '' }, member.token));
  check(root?.outcome === 'filed' && one(await rest('GET', 'projects', `project_files?id=eq.${f.id}&select=folder`))?.folder === '', 'an empty path takes it back to the category root', root?.outcome);
  check(JSON.stringify(await folders()).includes('design:mockups/mobile/ios'), 'and the folder it left is still there (folders outlive their files)');

  section('C. a folder a file names is a real folder');
  await mkFile('assets', 'Logo.svg', { folder: 'brand/logos/v2' });
  const all = await folders();
  check(['assets:brand', 'assets:brand/logos', 'assets:brand/logos/v2'].every((p) => all.includes(p)), 'a file created inside a folder path makes it and its ancestors', JSON.stringify(all));
  const moved = await mkFile('assets', 'Icon.svg');
  await rest('PATCH', 'projects', `project_files?id=eq.${moved.id}`, { folder: 'icons' }, owner.token);
  check((await folders()).includes('assets:icons'), 'and so does a file edited into one');

  section('D. no direct write; audited; role-checked');
  for (const [who, token] of [['owner', owner.token], ['member', member.token]]) {
    const w = await rest('POST', 'projects', 'project_folders', { organization_id: ORG, project_id: project.id, category: 'qa', path: 'direct' }, token);
    check(!w.ok, `${who}: a direct insert is refused`, `${w.status}`);
    const d = await rest('DELETE', 'projects', `project_folders?project_id=eq.${project.id}&path=eq.mockups`, null, token);
    check(!d.ok || (Array.isArray(d.json) && d.json.length === 0), `${who}: a direct delete removes nothing`, `${d.status}`);
  }
  check(one(await rpc('create_project_folder', { p_project_id: project.id, p_category: 'qa', p_path: 'x' }, finance.token))?.outcome === 'forbidden', 'finance may not create a folder');
  check(one(await rpc('file_into_folder', { p_file_id: f.id, p_path: 'mockups' }, finance.token))?.outcome === 'forbidden', 'finance may not file a file');
  const audit = await rest('GET', 'audit', `audit_log?action=in.(project.folder_created,file.filed)&or=(after->>projectId.eq.${project.id})&select=action,actor_id`);
  const rows = Array.isArray(audit.json) ? audit.json : [];
  const actions = new Set(rows.map((a) => a.action));
  for (const a of ['project.folder_created', 'file.filed']) check(actions.has(a), `${a} is recorded`);
  check(rows.length > 0 && rows.every((a) => a.actor_id === member.id), 'every row names the person who did it');
} finally {
  await k.cleanup(async () => {
    for (const id of k.created.projects) {
      await rest('DELETE', 'projects', `project_files?project_id=eq.${id}&parent_file_id=not.is.null`);
      await rest('DELETE', 'projects', `project_files?project_id=eq.${id}`);
      await rest('DELETE', 'projects', `project_folders?project_id=eq.${id}`);
    }
  });
}
k.finish();
