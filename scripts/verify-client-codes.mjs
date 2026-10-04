#!/usr/bin/env node
/**
 * Client and project identifiers for life, against the real database.
 *
 *   node scripts/verify-client-codes.mjs
 *
 *   1. a client gets CL-nnnnnn from the database; a value the caller supplies is ignored
 *   2. twelve clients created at the same instant get twelve different codes
 *   3. the code never changes - not by an edit, not by a rename, not by archiving - and is never given to anybody else
 *   4. a project's code is its client's code plus the client's own next number (CL-nnnnnn-Pnn), also under concurrency
 *   5. a project's code never changes, and survives its project being removed without being reissued
 *   6. numbering is per organization, and nothing about it can be read or written by a signed-in user directly
 *   7. everything that existed before the migration was numbered, once
 */

import { randomUUID } from 'node:crypto';

import { fixturesFor } from './verify-fixtures.mjs';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'client and project codes');

const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zzcode${randomUUID().slice(0, 6)}`;
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
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const made = { clients: [], projects: [], orgs: [] };
const newClient = async (org = ORG, extra = {}) => {
  const r = await rest('POST', 'core', 'client_accounts', { organization_id: org, name: `${MARKER} client ${randomUUID().slice(0, 4)}`, ...extra });
  const row = one(r);
  if (row?.id) made.clients.push(row.id);
  return { row, ok: r.ok, status: r.status };
};
const newProject = async (clientId, org = ORG, extra = {}) => {
  const r = await rest('POST', 'projects', 'projects', { organization_id: org, client_account_id: clientId, name: `${MARKER} project`, ...extra });
  const row = one(r);
  if (row?.id) made.projects.push(row.id);
  return { row, ok: r.ok, status: r.status };
};
const num = (code) => Number(code.replace(/^CL-/, '').replace(/-P.*$/, ''));

let owner;
try {
  owner = await fx.bootstrapOwner(MARKER);

  section('1. A client gets a code from the database');
  const before = (await rest('GET', 'core', `client_accounts?organization_id=eq.${ORG}&select=client_code&order=client_code.desc&limit=1`)).json?.[0]?.client_code;
  const a = (await newClient(ORG, { client_code: 'CL-999999' })).row;
  check(/^CL-\d{6,}$/.test(a?.client_code ?? ''), 'it is CL-nnnnnn', a?.client_code);
  check(a?.client_code !== 'CL-999999', 'a code the caller supplies is ignored');
  check(num(a?.client_code) > num(before), 'and it is higher than every code issued before', `${before} -> ${a?.client_code}`);
  const b = (await newClient()).row;
  check(num(b?.client_code) === num(a?.client_code) + 1, 'the next client is the next number', `${a?.client_code} -> ${b?.client_code}`);

  section('2. Twelve clients at the same instant');
  const parallel = await Promise.all(Array.from({ length: 12 }, () => newClient()));
  const codes = parallel.map((p) => p.row?.client_code);
  check(parallel.every((p) => p.ok) && new Set(codes).size === 12, 'twelve different codes, none lost to a race', `${new Set(codes).size} distinct`);

  section('3. The code is for life');
  const edit = await rest('PATCH', 'core', `client_accounts?id=eq.${a.id}`, { client_code: 'CL-000001' });
  check(!edit.ok, 'editing it is refused', `HTTP ${edit.status}`);
  const rename = await rest('PATCH', 'core', `client_accounts?id=eq.${a.id}`, { name: `${MARKER} renamed`, status: 'archived' });
  const afterRename = one(await rest('GET', 'core', `client_accounts?id=eq.${a.id}&select=client_code,name,status`));
  check(rename.ok && afterRename?.client_code === a.client_code && afterRename?.status === 'archived', 'a rename and an archive leave it as it was', afterRename?.client_code);
  const doomed = (await newClient()).row;
  await rest('DELETE', 'core', `client_accounts?id=eq.${doomed.id}`);
  const next = (await newClient()).row;
  check(num(next.client_code) > num(doomed.client_code), 'a deleted client\'s code is never given to anybody else', `${doomed.client_code} deleted, next is ${next.client_code}`);

  section('4. A project\'s code is its client\'s code plus the client\'s own next number');
  const c = (await newClient()).row;
  const p1 = (await newProject(c.id)).row;
  const p2 = (await newProject(c.id, ORG, { code: 'MY-REF-7' })).row;
  check(p1?.project_code === `${c.client_code}-P01` && p2?.project_code === `${c.client_code}-P02`, 'P01, P02 - prefixed with the client\'s code', `${p1?.project_code}, ${p2?.project_code}`);
  check(p2?.code === 'MY-REF-7', 'the hand-typed reference is untouched and separate');
  const other = (await newClient()).row;
  const o1 = (await newProject(other.id)).row;
  check(o1?.project_code === `${other.client_code}-P01`, 'another client counts from P01 on its own', o1?.project_code);
  const burst = await Promise.all(Array.from({ length: 8 }, () => newProject(c.id)));
  const bc = burst.map((x) => x.row?.project_code);
  check(burst.every((x) => x.ok) && new Set(bc).size === 8 && bc.every((x) => x?.startsWith(`${c.client_code}-P`)), 'eight projects for one client at once: eight different numbers', `${[...bc].sort().join(' ').slice(0, 80)}`);
  const suppliedCode = (await newProject(c.id, ORG, { project_code: 'CL-000001-P99' })).row;
  check(suppliedCode?.project_code !== 'CL-000001-P99' && suppliedCode?.project_code?.startsWith(c.client_code), 'a project code supplied by the caller is ignored');

  section('5. A project\'s code is for life');
  const editP = await rest('PATCH', 'projects', `projects?id=eq.${p1.id}`, { project_code: 'CL-000001-P01' });
  check(!editP.ok, 'editing it is refused', `HTTP ${editP.status}`);
  const lower = await rest('PATCH', 'core', `client_accounts?id=eq.${c.id}`, { project_seq: 0 });
  check(!lower.ok, 'the client\'s project counter cannot be wound back (it would reissue a number)', `HTTP ${lower.status}`);
  await rest('PATCH', 'projects', `projects?id=eq.${p2.id}`, { deleted_at: new Date().toISOString() });
  const p3 = (await newProject(c.id)).row;
  check(![p1.project_code, p2.project_code].includes(p3?.project_code) && Number(p3?.project_code.split('-P')[1]) > 10, 'a removed project\'s number is not reissued', p3?.project_code);
  const renameP = await rest('PATCH', 'projects', `projects?id=eq.${p1.id}`, { name: `${MARKER} renamed`, code: null });
  check(renameP.ok && one(await rest('GET', 'projects', `projects?id=eq.${p1.id}&select=project_code`))?.project_code === p1.project_code, 'a rename leaves it as it was');
  const orphan = await rest('POST', 'projects', 'projects', { organization_id: ORG, client_account_id: randomUUID(), name: `${MARKER} orphan` });
  check(!orphan.ok, 'a project with no real client cannot be created');

  section('6. Per organization, and closed to signed-in users');
  const org2 = one(await rest('POST', 'core', 'organizations', { name: `${MARKER} org`, slug: `${MARKER}-org` }));
  made.orgs.push(org2?.id);
  const x = (await newClient(org2.id)).row;
  check(x?.client_code === 'CL-000001', 'a new organization starts at CL-000001 - numbering is its own', x?.client_code);
  const counters = await fx.call(owner.token, 'GET', 'core', 'client_code_counters?select=*');
  check(!counters.ok || (counters.json ?? []).length === 0, 'the counter table is not readable by a signed-in user', `HTTP ${counters.status}`);
  const write = await fx.call(owner.token, 'PATCH', 'core', `client_code_counters?organization_id=eq.${ORG}`, { last_number: 0 });
  check(!write.ok || (write.json ?? []).length === 0, 'nor writable', `HTTP ${write.status}`);

  section('7. Everything that existed before was numbered, once');
  const unnumbered = (await rest('GET', 'core', 'client_accounts?client_code=is.null&select=id')).json ?? [];
  const all = (await rest('GET', 'core', `client_accounts?organization_id=eq.${ORG}&select=client_code`)).json ?? [];
  check(unnumbered.length === 0 && new Set(all.map((r) => r.client_code)).size === all.length, 'every client has a code and no two share one', `${all.length} clients`);
  const projects = (await rest('GET', 'projects', `projects?organization_id=eq.${ORG}&select=project_code,client_account_id&limit=2000`)).json ?? [];
  const clientCodeById = new Map((await rest('GET', 'core', `client_accounts?organization_id=eq.${ORG}&select=id,client_code`)).json.map((r) => [r.id, r.client_code]));
  check(projects.length > 0 && new Set(projects.map((r) => r.project_code)).size === projects.length && projects.every((r) => r.project_code.startsWith(`${clientCodeById.get(r.client_account_id)}-P`)), 'every project has one, unique, built from its own client\'s code', `${projects.length} projects`);
} catch (e) {
  console.error(e);
  failures += 1;
} finally {
  for (const id of made.projects) await rest('DELETE', 'projects', `projects?id=eq.${id}`).catch(() => {});
  for (const id of made.clients) await rest('DELETE', 'core', `client_accounts?id=eq.${id}`).catch(() => {});
  for (const id of made.orgs) await rest('DELETE', 'core', `organizations?id=eq.${id}`).catch(() => {});
  await fx.cleanup().catch(() => {});
  console.log(`\n${failures === 0 ? '\x1b[32m✔' : '\x1b[31m✖'} ${checks - failures}/${checks} checks passed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}
