/**
 * Open the internal pages on a local stack — G-205.
 *
 * ── what this exists because of ───────────────────────────────────────────
 *
 * `core.custom_access_token_hook` has stamped `organization_id` and `role`
 * onto the token since migration 011, and on the deployed project a dashboard
 * step points GoTrue at it. Locally nothing did. So a browser session carried
 * no role claim, `requireInternal()` refused, and every internal page
 * redirected to `/no-access`.
 *
 * Twelve changes in a row had to say "not visually verified" for that one
 * reason — and the verification scripts never noticed, because they mint
 * their tokens by hand and never go through GoTrue at all.
 *
 * Three lines of `supabase/config.toml` fixed it: the hook, the app's own
 * callback on the redirect allow-list, and a magic-link template that emits
 * the shape `app/auth/callback/route.ts` documents it accepts. This script is
 * the fourth thing that was missing — a way to get a signed-in session
 * without doing five manual steps and getting one of them wrong.
 *
 *   node scripts/sign-in-locally.mjs [email]
 *
 * It prints a URL. Open it, and you are the owner of the demo organization.
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: true, jwt: false });
await announceTarget(target, 'a signed-in session for the internal pages');

if (!target.url.includes('127.0.0.1') && !target.url.includes('localhost')) {
  fail('This is for a LOCAL stack. It creates a user and reads a mailbox; neither belongs on a deployment.');
}

const URL_BASE = target.url;
const KEY = target.serviceKey;
const ANON = target.anonKey;
const APP = target.appUrl ?? 'http://localhost:3000';
const MAIL = 'http://127.0.0.1:54324';
const ORG = '00000000-0000-4000-8000-000000000001';
const EMAIL = process.argv[2] ?? 'owner-local@example.invalid';

const admin = (method, schema, path, body) =>
  fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema, Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json().catch(() => null) }));

// ── the person ────────────────────────────────────────────────────────────
//
// Created if absent, reused if not. Running this twice should not be an error
// and should not make a second owner.
const existing = await admin('GET', 'core', `users?email=eq.${encodeURIComponent(EMAIL)}&select=id`);
let userId = existing.json?.[0]?.id ?? null;

if (!userId) {
  const created = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ email: EMAIL, password: randomUUID(), email_confirm: true }),
  }).then((r) => r.json()).catch(() => ({}));
  userId = created?.id ?? null;
  if (!userId) fail(`could not create ${EMAIL}: ${JSON.stringify(created)}`);
  console.log(`  created ${EMAIL}`);
} else {
  console.log(`  reusing ${EMAIL}`);
}

// ── and their membership, which is what the hook reads ────────────────────
//
// The claim comes from `core.memberships`, not from the user: a user with no
// membership signs in perfectly well and is refused by every internal page,
// which is the behaviour and not a bug.
const membership = await admin('GET', 'core', `memberships?user_id=eq.${userId}&select=id,role`);
if (!membership.json?.length) {
  const made = await admin('POST', 'core', 'memberships', {
    organization_id: ORG, user_id: userId, role: 'owner', status: 'active',
  });
  if (!made.ok) fail(`could not make them an owner: HTTP ${made.status}`);
  console.log('  made them an owner of the demo organization');
} else {
  console.log(`  already a ${membership.json[0].role}`);
}

// ── the link ──────────────────────────────────────────────────────────────
await fetch(`${MAIL}/api/v1/messages`, { method: 'DELETE' }).catch(() => {});

const sent = await fetch(
  `${URL_BASE}/auth/v1/magiclink?redirect_to=${encodeURIComponent(`${APP}/auth/callback`)}`,
  {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ email: EMAIL }),
  },
);
if (!sent.ok) fail(`the magic link was refused: HTTP ${sent.status}. Is ${APP}/auth/callback on additional_redirect_urls?`);

// Mailpit takes a moment. Polled rather than slept, because a fixed wait is
// either too short on a cold stack or wasted on a warm one.
let link = null;
for (let i = 0; i < 20 && !link; i += 1) {
  await sleep(250);
  const list = await fetch(`${MAIL}/api/v1/messages?limit=1`).then((r) => r.json()).catch(() => null);
  const id = (list?.messages ?? list?.items ?? [])[0]?.ID ?? (list?.messages ?? list?.items ?? [])[0]?.id;
  if (!id) continue;
  const message = await fetch(`${MAIL}/api/v1/message/${id}`).then((r) => r.json()).catch(() => null);
  const body = `${message?.HTML ?? ''}${message?.Text ?? ''}`;
  link = (body.match(/https?:\/\/[^"\s<>]+auth\/callback[^"\s<>]*/) ?? [])[0]?.replace(/&amp;/g, '&') ?? null;
}

if (!link) {
  fail(
    'no sign-in link arrived. Check the magic-link template in supabase/config.toml — ' +
      'the DEFAULT one routes through /auth/v1/verify and reaches the app with neither ' +
      '`code` nor `token_hash`, which the callback correctly refuses.',
  );
}

console.log(`\n  Open this, and you are signed in as the owner:\n\n  ${link}\n`);
