#!/usr/bin/env node
/**
 * Smoke tests — the runbook's post-deploy table, as an executable.
 *
 * AGENCYOS_OPERATIONS' checklist has carried "Smoke tests defined" unticked
 * since it was written, while the runbook's §6 table said what to check in
 * prose. This is that table made runnable, against ANY deployment:
 *
 *   npm run smoke                      → http://localhost:3000
 *   npm run smoke -- https://host      → a staging or production deployment
 *
 * ── what needs no credential, and what the checks refuse to assume ────────
 *
 * Most of the table is verifiable with no secret at all — and four of the
 * checks are NEGATIVE: the cron runner must 401 an unauthenticated tick and a
 * wrong bearer; the webhook must 403 a wrong verify token and 401 an unsigned
 * delivery. A deployment that answered 200 to any of those would be wide
 * open, and a smoke test that never tried would not know. The statuses are
 * exact on purpose — a check that greens on 404 or 500 certifies a guard
 * that may not even exist.
 *
 * The webhook and the runner are deliberately asymmetric about "not
 * configured" (both answer 503): a deployment without CRON_SECRET is a broken
 * deployment — the scheduler is AgencyOS's heartbeat — so 503 there FAILS,
 * with the real cause named. A deployment without the WhatsApp secrets is an
 * expected state while no Meta account exists (G-091), so 503 there is
 * reported as "webhook not configured, refusal not proven", never as a guard
 * that held.
 *
 * The "right database" row is the one the runbook marks NEVER ASSUME, so
 * this script refuses to skip it: it requires NEXT_PUBLIC_SUPABASE_URL (or
 * SMOKE_EXPECT_TARGET, the twelve-hex fingerprint itself) and fails loudly
 * when neither is set. A smoke run that cannot say which database the app is
 * pointed at has not smoke-tested the thing that matters most (G-083 — a
 * build once aimed itself at the wrong project, and only a mismatched key
 * stopped it).
 *
 * Two checks go further WHEN the deployment's facts are in the environment,
 * and say "not proven here" when they are not, rather than passing vacuously:
 * CRON_SECRET makes the authorized tick prove the runner runs; a WhatsApp
 * verify token makes the handshake prove the webhook echoes its challenge.
 *
 * ── what stays manual, by design ──────────────────────────────────────────
 *
 * Signing in as a real user needs a real user; proving RLS across two real
 * organizations needs their credentials; watching a core.jobs row leave
 * `queued` needs database access this script must not require. The runbook
 * table still lists them — this automates the automatable rows, it does not
 * redefine the table.
 */

const base = (process.argv[2] ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000')
  .replace(/\/+$/, '');

// Vercel Deployment Protection (SSO) sits in front of every route on a
// protected deployment and 302-redirects an unauthenticated request to
// vercel.com/sso-api — so a smoke run without a way past it tests the wall,
// not the app. "Protection Bypass for Automation" (Vercel → Settings →
// Deployment Protection) issues a secret and injects it as the deployment env
// var VERCEL_AUTOMATION_BYPASS_SECRET; presenting that value in the
// `x-vercel-protection-bypass` header gets the request to the function, where
// the app's OWN CRON_SECRET / verify-token / HMAC checks still apply. It is
// not an app credential and authenticates nothing here — it only opens the
// door, so it is safe to send on every request including the negative ones.
// Absent (localhost, or an unprotected deployment) this whole block is a no-op.
const bypassToken = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? process.env.SMOKE_BYPASS_TOKEN ?? '';
const bypass = bypassToken ? { 'x-vercel-protection-bypass': bypassToken } : {};

let failures = 0;
let notProven = 0;
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const bad = (msg) => { failures += 1; console.log(`  \x1b[31m✗\x1b[0m ${msg}`); };
const open = (msg) => { notProven += 1; console.log(`  \x1b[33m○\x1b[0m ${msg}`); };

const get = (path, headers = {}) =>
  fetch(`${base}${path}`, { headers: { ...bypass, ...headers }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
const post = (path, headers = {}, body = '{}') =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...bypass, ...headers }, body, redirect: 'manual', signal: AbortSignal.timeout(30_000) });

/**
 * One dead endpoint must cost one ✗, not the rest of the run: the summary and
 * the remaining checks are the point of a smoke test against a sick host.
 */
async function probe(name, fn) {
  try {
    await fn();
  } catch (e) {
    bad(`${name}: ${e.message}`);
  }
}

console.log(`Smoke — ${base}${bypassToken ? ' (with Vercel protection-bypass header)' : ''}`);

// ── the app answers ─────────────────────────────────────────────────────────
try {
  const root = await get('/');
  const location = root.headers.get('location') ?? '';
  const ssoWalled = [301, 302, 307, 308].includes(root.status) && /vercel\.com\/sso-api/.test(location);
  if (ssoWalled) {
    // Every check below would 302 too, testing the wall instead of the app —
    // so this is fatal rather than a single ✗, and it names the exact fix.
    const hint = bypassToken
      ? 'a bypass token WAS sent and the wall still redirected — the token is wrong, or "Protection Bypass for Automation" is not enabled on this deployment'
      : 'enable "Protection Bypass for Automation" (Vercel → Settings → Deployment Protection) and re-run with VERCEL_AUTOMATION_BYPASS_SECRET set';
    bad(`the deployment is behind Vercel Deployment Protection (302 → vercel.com/sso-api): ${hint}`);
    console.error(`\n\x1b[31m✖ Cannot smoke-test past the protection wall — every check would test the SSO redirect, not the app.\x1b[0m`);
    process.exit(1);
  } else if (root.status < 500) {
    ok(`the app answers / (${root.status})`);
  } else {
    bad(`/ returned ${root.status} — the app is not serving`);
  }
} catch (e) {
  bad(`the app is unreachable at ${base}: ${e.message}`);
  console.error(`\n\x1b[31m✖ Nothing else can be smoke-tested against a dead host.\x1b[0m`);
  process.exit(1);
}

// ── health, and both of its dependencies ────────────────────────────────────
let body = null;
await probe('GET /api/health', async () => {
  const health = await get('/api/health');
  body = await health.json().catch(() => null);
  if (health.status === 200 && body?.status === 'ok') ok('GET /api/health is 200 ok');
  else bad(`GET /api/health: status ${health.status}, body.status ${body?.status ?? 'unparseable'}`);
  if (body?.checks?.database?.ok) ok(`database reachable (${body.checks.database.probe}, ${body.checks.database.latencyMs}ms)`);
  else bad(`database check: ${body?.checks?.database?.detail ?? 'absent'}`);
  if (body?.checks?.auth?.ok) ok(`auth reachable (${body.checks.auth.latencyMs}ms)`);
  else bad(`auth check: ${body?.checks?.auth?.detail ?? 'absent'}`);
});

// ── the right database — the row the runbook says to NEVER assume ──────────
// The app hashed its URL as an exact string at build time, so the expected
// side tolerates the one slip that is not a different database: a trailing
// slash. Everything else must match byte for byte.
const { createHash } = await import('node:crypto');
const fingerprint = (url) => createHash('sha256').update(url).digest('hex').slice(0, 12);
const expected = process.env.SMOKE_EXPECT_TARGET
  ? [process.env.SMOKE_EXPECT_TARGET]
  : process.env.NEXT_PUBLIC_SUPABASE_URL
    ? [...new Set([
        fingerprint(process.env.NEXT_PUBLIC_SUPABASE_URL),
        fingerprint(process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, '')),
        fingerprint(`${process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, '')}/`),
      ])]
    : null;
if (!expected) {
  bad('cannot verify WHICH database the app is pointed at — set NEXT_PUBLIC_SUPABASE_URL or SMOKE_EXPECT_TARGET. '
    + `The app reports target ${body?.target ?? 'unknown'}; the runbook marks this row "never assume", so a run that cannot check it fails.`);
} else if (expected.includes(body?.target)) {
  ok(`the app is pointed at the expected database (target ${body.target})`);
} else {
  bad(`WRONG DATABASE: the app reports target ${body?.target}, expected ${expected[0]} — the fingerprint hashes the exact URL string`);
}

// ── the cron runner refuses strangers ───────────────────────────────────────
// 503 here means CRON_SECRET is not set at all — the runner is inert, and a
// deployment whose scheduler cannot fire is broken, not guarded.
await probe('POST /api/jobs/run (bare)', async () => {
  const bare = await post('/api/jobs/run');
  if (bare.status === 401) ok('POST /api/jobs/run without a secret is 401');
  else if (bare.status === 503) bad('the job runner is DISABLED (503): CRON_SECRET is not set on this deployment');
  else if (bare.status === 500) bad('POST /api/jobs/run errored (500) — is CRON_SECRET set but shorter than 16 characters?');
  else bad(`POST /api/jobs/run without a secret returned ${bare.status} — the runner must refuse strangers`);
});
await probe('POST /api/jobs/run (wrong secret)', async () => {
  const wrong = await post('/api/jobs/run', { Authorization: 'Bearer smoke-wrong-secret' });
  if (wrong.status === 401) ok('and 401 with a wrong secret');
  else bad(`POST /api/jobs/run with a wrong secret returned ${wrong.status}`);
});

// ── the webhook refuses strangers ───────────────────────────────────────────
// Exact statuses: the route answers 403 to a wrong token and 401 to an
// unsigned delivery WHEN CONFIGURED, and 503 when the WhatsApp secrets are
// absent — which is a webhook that is switched off, not a guard that held,
// and is an expected state while no Meta account exists (G-091).
await probe('webhook handshake (wrong token)', async () => {
  const badToken = await get('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=smoke-wrong-token&hub.challenge=smoke-1');
  const text = await badToken.text();
  if (badToken.status === 403) ok('webhook handshake refuses a wrong verify token (403)');
  else if (badToken.status === 503) open('webhook not configured on this deployment (503) — token refusal not proven');
  else if (badToken.status === 200 && text.includes('smoke-1')) bad('the webhook echoed the challenge for a WRONG verify token');
  else bad(`webhook handshake with a wrong token returned ${badToken.status} — a refusal must be a 403, not whatever this is`);
});
await probe('webhook delivery (unsigned)', async () => {
  const unsigned = await post('/api/webhooks/whatsapp', {}, JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));
  if (unsigned.status === 401) ok('unsigned webhook delivery is refused (401)');
  else if (unsigned.status === 503) open('webhook not configured on this deployment (503) — signature enforcement not proven');
  else bad(`an UNSIGNED webhook delivery returned ${unsigned.status} — signatures are not being enforced`);
});

// ── with the deployment's facts, when present ──────────────────────────────
// The scheduler's pulse is reported by /api/health so an external monitor can
// tell a stopped cron from a quiet one. Structural first: the check is present.
await probe('cron heartbeat', async () => {
  const health = await get('/api/health');
  const body = await health.json().catch(() => null);
  if (body?.checks?.cron) ok(`/api/health reports the cron pulse (${body.checks.cron.ok ? 'fresh' : 'stale'})`);
  else bad('/api/health does not report a cron heartbeat — a stopped scheduler would be invisible');
});

if (process.env.CRON_SECRET) {
  await probe('authorized tick advances the pulse', async () => {
    const tick = await post('/api/jobs/run', { Authorization: `Bearer ${process.env.CRON_SECRET}` });
    if (tick.status !== 200) {
      bad(`an authorized tick returned ${tick.status} — the secret in this environment does not open the runner`);
      return;
    }
    ok('an authorized tick runs (200)');
    // After a tick, the heartbeat must be fresh — the end-to-end proof that the
    // pulse is stamped and read.
    const after = await (await get('/api/health')).json().catch(() => null);
    if (after?.checks?.cron?.ok) ok('and the cron heartbeat is fresh afterwards');
    else bad(`the heartbeat is not fresh after a tick: ${JSON.stringify(after?.checks?.cron)}`);
  });
} else {
  open('authorized tick not proven here — CRON_SECRET not in this environment');
}

if (process.env.WHATSAPP_VERIFY_TOKEN) {
  await probe('webhook handshake (real token)', async () => {
    const hs = await get(`/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(process.env.WHATSAPP_VERIFY_TOKEN)}&hub.challenge=smoke-2`);
    if (hs.status === 200 && (await hs.text()) === 'smoke-2') ok('webhook handshake echoes the challenge for the real token');
    else bad(`webhook handshake with the real token: ${hs.status}`);
  });
} else {
  open('webhook handshake not proven here — WHATSAPP_VERIFY_TOKEN not in this environment');
}

console.log('\n  manual rows the runbook still owns: sign in as a real user · RLS across two real organizations · a core.jobs row leaving queued');

if (failures > 0) {
  console.error(`\n\x1b[31m✖ ${failures} smoke failure(s) — do not call this deployment good.\x1b[0m`);
  process.exit(1);
}
console.log(`\n\x1b[32m✔ Smoke passed${notProven ? ` — ${notProven} check(s) not proven here, said so above` : ''}.\x1b[0m`);
