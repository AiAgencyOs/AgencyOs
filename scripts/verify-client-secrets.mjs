#!/usr/bin/env node
/**
 * The per-project vault for what a client sends in confidence (ADM-106).
 * Against the real database through PostgREST, as real tokens.
 *
 *   node scripts/verify-client-secrets.mjs
 *
 * Proves, each in both directions:
 *   • an admin (owner or ops_admin) stores a secret; a delivery lead and a plain member cannot
 *   • nobody reads the table through PostgREST - not even a signed-in owner
 *   • listing shows label/kind/hint/who/when and never a ciphertext
 *   • revealing is the only read, and it is AUDITED (who, which label) - the audit row carries no value
 *   • a secret cannot be edited; revoking wipes the ciphertext, keeps the record, and a revoked one cannot be revealed
 *   • another organization's admin cannot see, reveal or revoke it
 */

import { randomUUID } from 'node:crypto';

import { fixturesFor } from './verify-fixtures.mjs';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'a client secret, stored, opened and revoked');

const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-secrets-${randomUUID().slice(0, 8)}`;
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

const CIPHER = { p_ciphertext: 'Y2lwaGVydGV4dA==', p_iv: 'aXZpdml2aXZpdg==', p_auth_tag: 'dGFndGFndGFndGFndGFn' };
const PLAINTEXT_MARKER = 'hunter2-never-stored-in-the-clear';

let projectId = null;
try {
  const owner = await fx.bootstrapOwner(MARKER);
  const ownerTok = owner.token;
  const opsTok = fx.mint(owner.id, 'ops_admin');
  const leadTok = fx.mint(owner.id, 'delivery_lead');
  const viewerTok = fx.mint(owner.id, 'member');
  const foreignTok = fx.mint(owner.id, 'owner', randomUUID());
  const door = (tok, fn, args) => fx.call(tok, 'POST', 'projects', `rpc/${fn}`, args);

  const client = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }));
  const contact = one(await rest('POST', 'crm', 'contacts', { organization_id: ORG, client_account_id: client.id, full_name: MARKER, phone: `+9198${String(Date.now()).slice(-8)}1` }));
  const lead = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, contact_id: contact.id, title: MARKER, source: 'whatsapp', source_ref: `${MARKER}:lead`, status: 'new' }));
  const opp = one(await rest('POST', 'sales', 'opportunities', { organization_id: ORG, lead_id: lead.id, name: `${MARKER} deal`, stage: 'discovery', client_account_id: client.id }));
  const project = one(await rest('POST', 'projects', 'projects', { organization_id: ORG, client_account_id: client.id, opportunity_id: opp.id, name: `${MARKER} project`, status: 'planning' }));
  projectId = project?.id;
  check(Boolean(projectId), 'a project to hold the secrets');

  section('1. Who may store');
  const args = (label, extra = {}) => ({ p_project_id: projectId, p_label: label, p_kind: 'hosting', ...CIPHER, p_hint: 'abcd', ...extra });
  const viewerTry = one(await door(viewerTok, 'store_client_secret', args('viewer try')));
  check(viewerTry?.outcome === 'not_authorized', 'a plain member cannot store one', viewerTry?.outcome);
  const leadTry = one(await door(leadTok, 'store_client_secret', args('lead try')));
  check(leadTry?.outcome === 'not_authorized', 'a delivery lead cannot store one', leadTry?.outcome);
  const foreignTry = one(await door(foreignTok, 'store_client_secret', args('foreign try')));
  check(foreignTry?.outcome === 'not_authorized' || foreignTry?.outcome === 'project_not_found', "another organization's admin cannot store on this project", foreignTry?.outcome);
  const stored = one(await door(opsTok, 'store_client_secret', args('Hosting login')));
  check(stored?.outcome === 'stored' && stored.secret_id, 'an ops_admin stores one', stored?.outcome);
  const stored2 = one(await door(ownerTok, 'store_client_secret', args('Stripe key', { p_kind: 'api_key' })));
  check(stored2?.outcome === 'stored', 'the owner stores one', stored2?.outcome);
  const noLabel = one(await door(ownerTok, 'store_client_secret', args('   ')));
  check(noLabel?.outcome === 'invalid_label', 'a blank label is refused', noLabel?.outcome);
  const noValue = one(await door(ownerTok, 'store_client_secret', { ...args('x'), p_ciphertext: '' }));
  check(noValue?.outcome === 'invalid_value', 'an empty value is refused', noValue?.outcome);

  section('2. Nobody reads the table');
  const directOwner = await fx.call(ownerTok, 'GET', 'projects', `client_secrets?project_id=eq.${projectId}&select=ciphertext`);
  check(!directOwner.ok || (directOwner.json ?? []).length === 0, 'a signed-in owner cannot select the table', `HTTP ${directOwner.status}`);
  const directWrite = await fx.call(ownerTok, 'POST', 'projects', 'client_secrets', { organization_id: ORG, project_id: projectId, label: 'sneaky', ...{ ciphertext: 'a', iv: 'b', auth_tag: 'c' }, stored_by: owner.id });
  check(!directWrite.ok, 'nor insert into it directly', `HTTP ${directWrite.status}`);

  section('3. Listing shows facts, never the value');
  const list = (await door(opsTok, 'client_secret_list', { p_project_id: projectId })).json ?? [];
  check(list.length === 2 && list.some((r) => r.label === 'Hosting login' && r.hint === 'abcd'), 'an admin lists both, with label and hint', `${list.length} rows`);
  check(!JSON.stringify(list).includes('ciphertext') && !JSON.stringify(list).includes(CIPHER.p_ciphertext), 'and no ciphertext is in the list');
  const viewerList = (await door(viewerTok, 'client_secret_list', { p_project_id: projectId })).json ?? [];
  check(viewerList.length === 0, 'a plain member lists nothing');
  const foreignList = (await door(foreignTok, 'client_secret_list', { p_project_id: projectId })).json ?? [];
  check(foreignList.length === 0, "another organization's admin lists nothing");

  section('4. Revealing is the only read - and it is audited');
  const id = stored.secret_id;
  const before = (await rest('GET', 'audit', `audit_log?action=eq.client_secret.viewed&subject_id=eq.${id}&select=id`)).json ?? [];
  const viewerReveal = one(await door(viewerTok, 'reveal_client_secret', { p_secret_id: id }));
  check(viewerReveal?.outcome === 'not_authorized' && !viewerReveal.ciphertext, 'a plain member cannot reveal', viewerReveal?.outcome);
  const leadReveal = one(await door(leadTok, 'reveal_client_secret', { p_secret_id: id }));
  check(leadReveal?.outcome === 'not_authorized' && !leadReveal.ciphertext, 'a delivery lead cannot reveal', leadReveal?.outcome);
  const foreignReveal = one(await door(foreignTok, 'reveal_client_secret', { p_secret_id: id }));
  check(foreignReveal?.outcome !== 'revealed' && !foreignReveal?.ciphertext, "another organization's admin cannot reveal", foreignReveal?.outcome);
  const afterRefusals = (await rest('GET', 'audit', `audit_log?action=eq.client_secret.viewed&subject_id=eq.${id}&select=id`)).json ?? [];
  check(afterRefusals.length === before.length, 'refused attempts write no view record');
  const revealed = one(await door(opsTok, 'reveal_client_secret', { p_secret_id: id }));
  check(revealed?.outcome === 'revealed' && revealed.ciphertext === CIPHER.p_ciphertext && revealed.label === 'Hosting login', 'an admin reveals it', revealed?.outcome);
  const views = (await rest('GET', 'audit', `audit_log?action=eq.client_secret.viewed&subject_id=eq.${id}&select=id,actor_id,after`)).json ?? [];
  check(views.length === before.length + 1, 'the view is in the audit log', `${views.length} view(s)`);
  check(JSON.stringify(views).includes('Hosting login') && !JSON.stringify(views).includes(CIPHER.p_ciphertext), 'naming the label and never the ciphertext');
  await door(ownerTok, 'reveal_client_secret', { p_secret_id: id });
  const views2 = (await rest('GET', 'audit', `audit_log?action=eq.client_secret.viewed&subject_id=eq.${id}&select=id`)).json ?? [];
  check(views2.length === before.length + 2, 'every opening is its own record');

  section('5. A value is never edited; revoking wipes it and keeps the record');
  const edit = await rest('PATCH', 'projects', `client_secrets?id=eq.${id}`, { ciphertext: 'ZGlmZmVyZW50' });
  check(!edit.ok, 'editing a stored value is refused, even for the service role', `HTTP ${edit.status}`);
  const revokeLead = one(await door(leadTok, 'revoke_client_secret', { p_secret_id: id }));
  check(revokeLead?.outcome === 'not_authorized', 'a delivery lead cannot revoke', revokeLead?.outcome);
  const revokeForeign = one(await door(foreignTok, 'revoke_client_secret', { p_secret_id: id }));
  check(revokeForeign?.outcome === 'not_found' || revokeForeign?.outcome === 'not_authorized', "another organization's admin cannot revoke", revokeForeign?.outcome);
  const revoked = one(await door(ownerTok, 'revoke_client_secret', { p_secret_id: id }));
  check(revoked?.outcome === 'revoked', 'an admin revokes it', revoked?.outcome);
  const row = one(await rest('GET', 'projects', `client_secrets?id=eq.${id}&select=ciphertext,iv,auth_tag,revoked_at,revoked_by,label`));
  check(row && row.ciphertext === null && row.iv === null && row.auth_tag === null && row.revoked_at && row.revoked_by === owner.id, 'the ciphertext is gone; who and when remain', JSON.stringify(row));
  const again = one(await door(ownerTok, 'revoke_client_secret', { p_secret_id: id }));
  check(again?.outcome === 'already_revoked', 'revoking twice says so', again?.outcome);
  const afterRevoke = one(await door(opsTok, 'reveal_client_secret', { p_secret_id: id }));
  check(afterRevoke?.outcome === 'revoked' && !afterRevoke.ciphertext, 'a revoked secret cannot be revealed', afterRevoke?.outcome);
  const stillListed = ((await door(opsTok, 'client_secret_list', { p_project_id: projectId })).json ?? []).find((r) => r.id === id);
  check(stillListed?.revoked_at, 'and still appears in the list as revoked');

  section('6. The audit trail carries no plaintext');
  const trail = (await rest('GET', 'audit', `audit_log?subject_type=eq.client_secret&subject_id=in.(${id},${stored2.secret_id})&select=action,before,after`)).json ?? [];
  const actions = trail.map((r) => r.action).sort();
  check(actions.includes('client_secret.stored') && actions.includes('client_secret.viewed') && actions.includes('client_secret.revoked'), 'stored, viewed and revoked are all recorded', actions.join(', '));
  check(!JSON.stringify(trail).includes(PLAINTEXT_MARKER) && !JSON.stringify(trail).includes(CIPHER.p_ciphertext), 'and none of it contains a value');
} catch (e) {
  console.error(e);
  failures += 1;
} finally {
  await fx.cleanup().catch(() => {});
  console.log(`\n${failures === 0 ? '\x1b[32m✔' : '\x1b[31m✖'} ${checks - failures}/${checks} checks passed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}
