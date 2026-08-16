#!/usr/bin/env node
/**
 * The INVOKER-writer-without-the-RLS-policy class cannot silently return.
 *
 * This session found three money-critical instances of one class: a SECURITY
 * INVOKER function the app calls with the user's session, writing a table whose
 * RLS lacks the policy that write needs. The function runs as the authenticated
 * user, RLS blocks the write, and the feature is dead in the app — invisible to
 * CI because every other verify script drives the RPC through the service role,
 * which bypasses RLS (verify_payment #193, request_refund/record_refund #194,
 * mark_outbound_delivery — found by this very check).
 *
 * `core.audit_invoker_writes_without_policy()` (20260815330000) enumerates every
 * app-callable INVOKER function that writes an RLS-enabled table with no policy
 * for that op, minus an allowlist of service-role-only cron writers. This asserts
 * it returns nothing, so a future function that reintroduces the shape fails CI
 * instead of shipping a dead feature.
 *
 *   npm run db:verify:invokerrls
 */
import { resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: false });
const URL_BASE = target.url;
const KEY = target.serviceKey;

console.log('\n\x1b[1mAgencyOS — the INVOKER/RLS class cannot silently return\x1b[0m\n');

const res = await fetch(`${URL_BASE}/rest/v1/rpc/audit_invoker_writes_without_policy`, {
  method: 'POST',
  headers: {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'core',
    'Content-Profile': 'core',
  },
  cache: 'no-store',
  body: '{}',
});

const text = await res.text();
if (!res.ok) {
  fail(`could not run the audit function (HTTP ${res.status}): ${text.slice(0, 200)}`);
}

let rows;
try {
  rows = JSON.parse(text);
} catch {
  fail(`the audit function returned non-JSON: ${text.slice(0, 200)}`);
}

if (!Array.isArray(rows) || rows.length === 0) {
  console.log('  \x1b[32m✓\x1b[0m every app-callable SECURITY INVOKER writer targets a table with the RLS policy it needs');
  console.log('\n\x1b[32m✔ No silently-broken authenticated write path\x1b[0m\n');
  process.exit(0);
}

console.error('  \x1b[31m✗\x1b[0m app-callable INVOKER writers with NO matching RLS policy (silently broken for authenticated callers):');
for (const r of rows) {
  console.error(`      ${r.writer}  →  ${r.op} ${r.target}`);
}
console.error(
  '\n  Each of these runs as the authenticated user and RLS refuses the write, so the feature is dead in the app\n' +
    '  while service-role verify scripts stay green. Add the RLS policy the write needs (plus a sanctioned-write\n' +
    '  guard so the opened policy is not a direct-write forgery surface), or — if the function is genuinely\n' +
    '  service-role-only — add it to the allowlist in core.audit_invoker_writes_without_policy() with its reason.',
);
fail(`${rows.length} silently-broken authenticated write path(s)`);
