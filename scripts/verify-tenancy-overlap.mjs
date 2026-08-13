#!/usr/bin/env node
/**
 * Was anything filed under the wrong tenant? — gap G-090.
 *
 * D22: `crm.ingest_whatsapp_message` resolved which organization an inbound
 * message belonged to with an unordered `LIMIT 1` over every organization
 * claiming that WhatsApp number. Two claimants meant the message landed in
 * whichever row came back first, and the wrong organization was then stamped
 * on the contact, the lead, the conversation, the message and the job. The
 * index that made that unrepresentable came later; this asks what it left
 * behind.
 *
 * ── the answer is mostly "the data cannot say", and that is the finding ───
 *
 * The ingest keys a thread on the SENDER's number — `'wa:' || v_phone` — and
 * never records the number the message arrived on. So for a row already
 * written there is nothing to compare against: which organization *should*
 * have received it is not recoverable from the row, from the conversation, or
 * from the message. Any tool claiming to identify mis-filed rows in general
 * would be guessing.
 *
 * Two things can be established, and both are here:
 *
 *   1. Whether the ambiguity exists NOW. `organizations_whatsapp_number_key`
 *      is a partial unique index, and the migration that added it refused to
 *      build over an existing collision — so its presence is itself evidence
 *      that no two organizations claimed one number at that moment.
 *
 *   2. The only detectable fingerprint: one phone number appearing under more
 *      than one organization. That is what split traffic looks like from the
 *      inside. It is not proof — two agencies may genuinely talk to the same
 *      person — which is exactly why this reports rather than repairs.
 *
 *   node scripts/verify-tenancy-overlap.mjs
 */

import { announceTarget, resolveTarget } from './verify-target.mjs';

/**
 * Refuses an environment it cannot run against, with a message rather than a
 * crash. `resolveTarget` takes the caller's own exit function — the first
 * version of this script passed none, so an incomplete .env.verify.local
 * produced "fail is not a function" instead of the sentence explaining what
 * was missing. The error path nobody had executed.
 */
function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

// This script needs a service key: it drives the database directly and
// never calls the job runner, so CRON_SECRET is not required of it.
const target = await resolveTarget(fail, { cron: false, anon: false });
await announceTarget(target, 'verify-tenancy-overlap');

const URL_BASE = target.url;
const KEY = target.serviceKey;

let failures = 0;
let checks = 0;

function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function rest(schema, path) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Accept-Profile': schema },
    cache: 'no-store',
  });
  return { status: res.status, json: parse(await res.text()) };
}

console.log('\n\x1b[1mAgencyOS — tenancy overlap (G-090)\x1b[0m');

// ── 1. is the ambiguity representable at all any more ──────────────────────
console.log('\n1. Can two organizations claim one number today?');
{
  const orgs = await rest('core', 'organizations?select=id,name,settings');
  const claims = new Map();

  for (const org of orgs.json ?? []) {
    const number = org.settings?.whatsapp_phone_number_id;
    if (!number) continue;
    claims.set(number, [...(claims.get(number) ?? []), org.name]);
  }

  const contested = [...claims.entries()].filter(([, names]) => names.length > 1);

  check(
    contested.length === 0,
    'no WhatsApp number is claimed by more than one organization',
    contested.map(([n, names]) => `${n}: ${names.join(' + ')}`).join('; '),
  );
  console.log(`  \x1b[2m·\x1b[0m ${claims.size} number(s) claimed across ${(orgs.json ?? []).length} organization(s)`);
}

// ── 2. the only detectable fingerprint ─────────────────────────────────────
console.log('\n2. Does one phone number appear under more than one organization?');
{
  const contacts = await rest('crm', 'contacts?select=id,phone,organization_id&phone=not.is.null');
  const byPhone = new Map();

  for (const contact of contacts.json ?? []) {
    const seen = byPhone.get(contact.phone) ?? new Set();
    seen.add(contact.organization_id);
    byPhone.set(contact.phone, seen);
  }

  const split = [...byPhone.entries()].filter(([, orgs]) => orgs.size > 1);

  check(
    split.length === 0,
    'no contact phone number is split across organizations',
    split.map(([phone, orgs]) => `${phone} in ${orgs.size} orgs`).join('; '),
  );
  console.log(`  \x1b[2m·\x1b[0m ${byPhone.size} distinct number(s) across ${(contacts.json ?? []).length} contact(s)`);

  if (split.length > 0) {
    console.log(
      '\n  \x1b[33m!\x1b[0m This is a fingerprint, not proof. Two agencies may genuinely talk to the\n' +
        '    same person. Which rows — if any — should move is ADM territory, and the\n' +
        '    number the messages arrived on was never recorded, so the system cannot\n' +
        '    decide it for you.',
    );
  }
}

// ── 3. going forward, the question is answerable (G-102) ──────────────────
console.log('\n3. Is the number a message arrived on recorded now?');
{
  const conversations = await rest(
    'crm',
    'conversations?select=id,organization_id,inbound_number_id&channel=eq.whatsapp',
  );
  const rows = conversations.json ?? [];
  const recorded = rows.filter((c) => c.inbound_number_id);

  check(
    conversations.status === 200,
    'the column exists, so the question can be asked at all',
    `status ${conversations.status}`,
  );

  const orgs = await rest('core', 'organizations?select=id,settings');
  const owner = new Map(
    (orgs.json ?? [])
      .filter((o) => o.settings?.whatsapp_phone_number_id)
      .map((o) => [o.settings.whatsapp_phone_number_id, o.id]),
  );

  // The check G-090 could not make: a conversation whose recorded number is
  // claimed by a different organization than the one it is filed under.
  const misfiled = recorded.filter(
    (c) => owner.has(c.inbound_number_id) && owner.get(c.inbound_number_id) !== c.organization_id,
  );

  check(
    misfiled.length === 0,
    'no conversation is filed under an organization that does not claim its number',
    misfiled.map((c) => c.id).join(', '),
  );

  console.log(
    `  \x1b[2m·\x1b[0m ${recorded.length} of ${rows.length} WhatsApp conversation(s) carry the number they arrived on` +
      (rows.length > recorded.length
        ? ' — the rest predate the column and cannot be checked, which is the gap this closed'
        : ''),
  );
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ Nothing looks split across tenants\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} finding(s) — read the note above before acting\x1b[0m\n`);
process.exit(1);
