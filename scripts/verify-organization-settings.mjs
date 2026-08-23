#!/usr/bin/env node
/**
 * Operational settings are set through an audited, whitelisted function — Phase 4/6.
 *
 * Proves, against a real database:
 *   1. A valid whatsapp_phone_number_id is set and audited.
 *   2. A valid whatsapp_test_recipient is set.
 *   3. A malformed value is refused 'invalid_value', nothing changes.
 *   4. A key OUTSIDE the whitelist — a secret name — is refused 'invalid_key':
 *      no token can be smuggled into the settings blob through this door.
 *   5. An empty value CLEARS the key.
 *   6. A non-owner authenticated caller is refused 'forbidden'.
 *   7. A direct authenticated PATCH of a guarded key is refused by the guard,
 *      while an unchanged settings write by the same owner still succeeds.
 *   8. The service role (identity-less) is unrestricted.
 *
 * Uses the seed organization and restores its settings at the end.
 *
 *   node scripts/verify-organization-settings.mjs
 */

import { createHmac, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'verify-organization-settings');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = `zzset-${randomUUID().slice(0, 8)}`;
const ORG = '00000000-0000-4000-8000-000000000001';

let failures = 0;
let checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}
const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };

async function call(token, method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: token, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema, Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: parse(text), text };
}
const rest = (m, s, p, b) => call(KEY, m, s, p, b);
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

function mint(userId, role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const b = b64({
    sub: userId, aud: 'authenticated', role: 'authenticated',
    app_metadata: { organization_id: ORG, role }, iat: now, exp: now + 900,
  });
  return `${h}.${b}.${createHmac('sha256', target.jwtSecret).update(`${h}.${b}`).digest('base64url')}`;
}

const setSetting = (token, key, value) =>
  call(token ?? KEY, 'POST', 'core', 'rpc/set_organization_setting', {
    p_organization_id: ORG, p_key: key, p_value: value,
  });
const outcomeOf = (r) => (Array.isArray(r.json) ? r.json[0]?.outcome : r.json?.outcome);
const settingsOf = async () =>
  one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings`))?.settings ?? {};

const created = { users: [] };
let original;

console.log('\n\x1b[1mAgencyOS — operational settings are set and audited (Phase 4/6)\x1b[0m');

try {
  original = await settingsOf();

  const mkUser = async (role) => {
    const u = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ email: `${MARKER}-${role}@example.invalid`, password: randomUUID(), email_confirm: true }),
    }).then((r) => r.json());
    created.users.push(u.id);
    await rest('POST', 'core', 'users', { id: u.id, email: u.email });
    await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: u.id, role, status: 'active' });
    return mint(u.id, role);
  };
  const owner = await mkUser('owner');
  const member = await mkUser('member');

  // ── 1. a valid phone_number_id, audited ─────────────────────────────────
  console.log('\n1. A valid whatsapp_phone_number_id is set and audited');
  {
    const r = await setSetting(null, 'whatsapp_phone_number_id', '123456789012345');
    check(outcomeOf(r) === 'set', 'the setter returns set', `outcome ${outcomeOf(r)} / ${r.text}`);
    check((await settingsOf()).whatsapp_phone_number_id === '123456789012345', 'and settings carries the id');
    const audit = one(await rest('GET', 'audit',
      `audit_log?subject_id=eq.${ORG}&action=eq.organization.setting_set&order=created_at.desc&limit=1&select=after`));
    check(audit?.after?.key === 'whatsapp_phone_number_id', 'and the write is audited', JSON.stringify(audit?.after));
  }

  // ── 2. a valid test recipient ───────────────────────────────────────────
  console.log('\n2. A valid whatsapp_test_recipient is set');
  {
    const r = await setSetting(null, 'whatsapp_test_recipient', '+919000000000');
    check(outcomeOf(r) === 'set', 'the setter returns set', `outcome ${outcomeOf(r)}`);
    check((await settingsOf()).whatsapp_test_recipient === '+919000000000', 'and settings carries the number');
  }

  // ── 3. a malformed value is refused ─────────────────────────────────────
  console.log('\n3. A malformed value is refused');
  {
    const r = await setSetting(null, 'whatsapp_phone_number_id', 'not-a-number');
    check(outcomeOf(r) === 'invalid_value', 'a non-numeric phone_number_id is invalid_value', `outcome ${outcomeOf(r)}`);
    check((await settingsOf()).whatsapp_phone_number_id === '123456789012345', 'and the stored id is unchanged');
  }

  // ── 4. a secret key cannot be smuggled in ───────────────────────────────
  console.log('\n4. A key outside the whitelist is refused — no secret through this door');
  {
    const r = await setSetting(null, 'anthropic_api_key', 'x');
    check(outcomeOf(r) === 'invalid_key', 'a non-whitelisted key is invalid_key', `outcome ${outcomeOf(r)}`);
    check((await settingsOf()).anthropic_api_key === undefined, 'and no such key is written');
  }

  // ── 5. an empty value clears ────────────────────────────────────────────
  console.log('\n5. An empty value clears the key');
  {
    const r = await setSetting(null, 'whatsapp_test_recipient', '');
    check(outcomeOf(r) === 'cleared', 'the setter returns cleared', `outcome ${outcomeOf(r)}`);
    check((await settingsOf()).whatsapp_test_recipient === undefined, 'and the key is removed');
  }

  // ── 6. authority ────────────────────────────────────────────────────────
  console.log('\n6. Authority is enforced in the database');
  {
    const r = await setSetting(member, 'whatsapp_phone_number_id', '999999999999');
    check(outcomeOf(r) === 'forbidden', 'a member is forbidden', `outcome ${outcomeOf(r)}`);
    check((await settingsOf()).whatsapp_phone_number_id === '123456789012345', 'and nothing changed');
  }

  // ── 7. the guard, key-scoped ────────────────────────────────────────────
  console.log('\n7. The audit trail cannot be sidestepped, and ordinary writes still work');
  {
    const current = await settingsOf();
    const changed = { ...current, whatsapp_phone_number_id: '111111111111' };
    const patchChange = await call(owner, 'PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: changed });
    check(patchChange.status >= 400, 'a direct authenticated PATCH that changes the key is refused', `status ${patchChange.status}`);
    check((await settingsOf()).whatsapp_phone_number_id === '123456789012345', 'and the id is unchanged');

    // Re-writing the same settings (guarded keys unchanged) is allowed: the guard
    // fires only on a change to the two keys, not on every organization write.
    const patchSame = await call(owner, 'PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: current });
    check(patchSame.status < 300, 'an unchanged settings write by the same owner still succeeds', `status ${patchSame.status}`);
  }

  // ── 8. the service path is unrestricted ─────────────────────────────────
  console.log('\n8. The internal service path is unrestricted');
  {
    const patch = await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, {
      settings: { ...(await settingsOf()), whatsapp_phone_number_id: '222222222222' },
    });
    check(patch.status < 300, 'a service-role change of the key succeeds (guard exempts identity-less)', `status ${patch.status}`);
    check((await settingsOf()).whatsapp_phone_number_id === '222222222222', 'and the id is updated');
  }
  // ── 9. the agency's own name — G-160 ────────────────────────────────────
  //
  // The letterhead on every quotation PDF (G-156) read "Demo Agency" one
  // step before the first real client, and nothing but SQL could change it.
  // The setter follows the timezone's shape: owner-only in the body, audited
  // as organization.renamed, and the column guard refuses any other
  // authenticated write.
  console.log('\n9. The agency signs its own name');
  {
    const before = one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=name`))?.name;

    const renamed = await call(owner, 'POST', 'core', 'rpc/set_organization_name', {
      p_organization_id: ORG, p_name: `  ${MARKER} BussEnhancer  `,
    });
    const renamedOutcome = (Array.isArray(renamed.json) ? renamed.json[0] : renamed.json)?.outcome;
    check(renamedOutcome === 'set', 'the owner renames the agency', `status ${renamed.status}: ${renamed.text?.slice(0, 80)}`);
    check(
      one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=name`))?.name === `${MARKER} BussEnhancer`,
      'trimmed, and on the row',
    );

    const audited = (await rest('GET', 'audit',
      `audit_log?action=eq.organization.renamed&select=before,after&order=created_at.desc&limit=1`)).json ?? [];
    check(
      audited[0]?.before?.name === before && audited[0]?.after?.name === `${MARKER} BussEnhancer`,
      'audited with the old and the new name — identity changes are ledger rows',
      JSON.stringify(audited[0] ?? {}),
    );

    const memberTry = await call(member, 'POST', 'core', 'rpc/set_organization_name', {
      p_organization_id: ORG, p_name: 'Mallory & Co',
    });
    const memberOutcome = (Array.isArray(memberTry.json) ? memberTry.json[0] : memberTry.json)?.outcome;
    check(memberOutcome === 'forbidden', 'a member may not — the signature is the owner’s', `outcome ${memberOutcome}`);

    const sidestep = await call(owner, 'PATCH', 'core', `organizations?id=eq.${ORG}`, { name: 'Sidestep Ltd' });
    check(sidestep.status >= 400, 'a direct authenticated PATCH of the name is refused — the audit cannot be sidestepped', `status ${sidestep.status}`);
    check(
      one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=name`))?.name === `${MARKER} BussEnhancer`,
      'and the name is unchanged',
    );

    // restore
    await rest('POST', 'core', 'rpc/set_organization_name', { p_organization_id: ORG, p_name: before ?? 'Demo Agency' });
  }

} finally {
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: original ?? {} });
  for (const id of created.users) {
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
      method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, cache: 'no-store',
    }).catch(() => {});
  }
}

console.log(
  failures === 0
    ? `\n\x1b[32m✔ ${checks} checks passed.\x1b[0m\n`
    : `\n\x1b[31m✖ ${failures} of ${checks} checks failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
