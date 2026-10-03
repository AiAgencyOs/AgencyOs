// ═══════════════════════════════════════════════════════════════════════════
// A project has a type, a technology and tags.
//
// Owner decision 4, migration 20261005100200. Proven against real Postgres:
//   A. the type is from a fixed list of seven, written directly or through the
//      door; technology and tags are chips
//   B. a chip is trimmed, lower-cased, unique, 1–30 characters; at most 12
//      technology chips and 10 tags — the CHECKs hold even for a direct write
//   C. a writer sets all three at once; a refusal changes nothing; a role that
//      cannot write is forbidden; the change is audited with what it was
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { startKit } from './verify-kit-r1.mjs';

const k = await startKit('a project has a type, a technology and tags', 'zztest-classify');
const { check, rest, one, section } = k;
const rpc = k.rpc('projects');

try {
  const owner = await k.makeUser('owner');
  const member = await k.makeUser('member');
  const finance = await k.makeUser('finance');
  const project = await k.makeProject();
  const read = async () => one(await rest('GET', 'projects', `projects?id=eq.${project.id}&select=project_type,technology,tags`));
  const set = (type, technology, tags, token = owner.token) => rpc('set_project_classification', { p_project_id: project.id, p_type: type, p_technology: technology, p_tags: tags }, token);

  section('A. the type is from a fixed list');
  const initial = await read();
  check(initial.project_type === null && initial.technology.length === 0 && initial.tags.length === 0, 'a new project has none of the three');
  for (const t of ['Website', 'Web app', 'Mobile app', 'SaaS', 'E-commerce', 'Branding', 'Other']) {
    const r = one(await set(t, [], []));
    check(r?.outcome === 'set' && (await read()).project_type === t, `${t} is accepted`, r?.outcome);
  }
  check(one(await set('Game', [], []))?.outcome === 'invalid_type', 'a type outside the list is refused by the door');
  check((await read()).project_type === 'Other', 'and the project keeps the type it had');
  const direct = await rest('PATCH', 'projects', `projects?id=eq.${project.id}`, { project_type: 'Game' }, owner.token);
  check(!direct.ok, 'the table refuses it even written directly', `${direct.status}`);
  check(one(await set(null, [], []))?.outcome === 'set' && (await read()).project_type === null, 'null clears the type');

  section('B. a chip is trimmed, lower-cased and unique; the counts are bounded');
  const chips = one(await set('SaaS', ['  React ', 'react', 'Node.JS', '', 'POSTGRES'], [' OTT ', 'ott', 'AI']));
  const stored = await read();
  check(chips?.outcome === 'set' && JSON.stringify(stored.technology) === JSON.stringify(['react', 'node.js', 'postgres']), 'technology: trimmed, lower-cased, blanks and repeats dropped, order kept', JSON.stringify(stored.technology));
  check(JSON.stringify(stored.tags) === JSON.stringify(['ott', 'ai']), 'tags: the same', JSON.stringify(stored.tags));
  const twelve = Array.from({ length: 12 }, (_, i) => `t${i}`);
  check(one(await set('SaaS', twelve, []))?.outcome === 'set', 'twelve technologies are accepted');
  check(one(await set('SaaS', [...twelve, 't12'], []))?.outcome === 'too_many_technology', 'thirteen are refused');
  const ten = Array.from({ length: 10 }, (_, i) => `g${i}`);
  check(one(await set('SaaS', [], ten))?.outcome === 'set', 'ten tags are accepted');
  check(one(await set('SaaS', [], [...ten, 'g10']))?.outcome === 'too_many_tags', 'eleven are refused');
  check(one(await set('SaaS', ['x'.repeat(31)], []))?.outcome === 'chip_too_long', 'a 31-character chip is refused');
  check(one(await set('SaaS', ['x'.repeat(30)], []))?.outcome === 'set', 'a 30-character chip is accepted');
  const bigDirect = await rest('PATCH', 'projects', `projects?id=eq.${project.id}`, { tags: [...ten, 'g10'] }, owner.token);
  check(!bigDirect.ok, 'eleven tags written directly are refused by the table', `${bigDirect.status}`);

  section('C. who may write, and the audit');
  await set('Website', ['next.js'], ['agency']);
  const before = await read();
  check(one(await set('Branding', ['x'], ['y'], finance.token))?.outcome === 'forbidden', 'a role that cannot write is forbidden');
  check(JSON.stringify(await read()) === JSON.stringify(before), 'and nothing changed');
  check(one(await set('Branding', [], [], member.token))?.outcome === 'set', 'a member may write');
  check(one(await rpc('set_project_classification', { p_project_id: randomUUID(), p_type: 'Other', p_technology: [], p_tags: [] }, owner.token))?.outcome === 'not_found', 'an unknown project is not found');
  const audit = await rest('GET', 'audit', `audit_log?action=eq.project.classification_set&after->>projectId=eq.${project.id}&select=actor_id,before,after&order=id.desc&limit=1`);
  const last = one(audit);
  check(last?.actor_id === member.id && last?.before?.type === 'Website' && last?.after?.type === 'Branding', 'the audit row names the person and what it was before', JSON.stringify(last));
} finally {
  await k.cleanup();
}
k.finish();
