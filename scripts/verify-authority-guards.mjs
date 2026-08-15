#!/usr/bin/env node
/**
 * Authority cannot be forged — proven against the live schema.
 *
 * Two rules from migration 20260815130000, each exercised in both
 * directions, because a guard that has never refused anything is a hope:
 *
 *   1. Consent may leave only with the identity it belongs to. A withdrawn
 *      consent row cannot be deleted while its contact exists — that is the
 *      forge-by-erasure: delete the withdrawn row, insert a granted one,
 *      message an opted-out client over a clean audit trail. The cascade
 *      stays legal: deleting the contact or the organization takes consent
 *      with it, because that is an identity being erased, not a record
 *      being forged.
 *
 *   2. A handoff cannot declare itself done. Born queued only; the status
 *      machine's edges are enumerated; terminal states have no exits; and
 *      completion requires a verified verdict — non-empty passed evidence,
 *      signed by the declared verifier from ai.agent_verifiers. A settled
 *      verdict is frozen.
 *
 * Hermetic: everything lives in one throwaway organization, deleted at the
 * end through the very cascade rule 1 permits. No shared state is touched.
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\x1b[31m${message}\x1b[0m`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false });
await announceTarget(target, 'verify-authority-guards');

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

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=representation',
      'Accept-Profile': schema,
      'Content-Profile': schema,
    },
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json refusal text */ }
  return { status: res.status, text, json };
}

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const MARK = `zzauth-${randomUUID().slice(0, 8)}`;

console.log('\n\x1b[1mAgencyOS — authority cannot be forged (live)\x1b[0m');

let org = null;
try {
  org = one(await rest('POST', 'core', 'organizations', { name: MARK, slug: MARK }))?.id;
  if (!org) fail('could not create the probe organization');

  // ── 1. consent: forge-by-erasure refused, cascade allowed ───────────────
  console.log('\n1. Consent may leave only with the identity it belongs to');
  const contact = one(await rest('POST', 'crm', 'contacts', {
    organization_id: org, full_name: MARK, phone: `+9198${Date.now() % 100000000}`,
  }))?.id;
  await rest('POST', 'crm', 'communication_consent', {
    organization_id: org, contact_id: contact, channel: 'whatsapp', status: 'withdrawn',
  });

  const forge = await rest('DELETE', 'crm', `communication_consent?contact_id=eq.${contact}`);
  check(forge.status >= 400, 'deleting a withdrawn consent row is refused while the contact exists', `HTTP ${forge.status}`);
  check(/withdrawn is a row|never deleted/i.test(forge.text), 'and the refusal says why', forge.text.slice(0, 100));

  const regrant = await rest('POST', 'crm', 'communication_consent', {
    organization_id: org, contact_id: contact, channel: 'whatsapp', status: 'granted',
  });
  check(regrant.status >= 400, 'so a fresh granted row cannot replace it (the unique row already exists)', `HTTP ${regrant.status}`);

  // The reparent bypass: move the withdrawn row onto a throwaway contact and
  // delete that, and the cascade would erase the withdrawal while the real
  // contact survives. The identity is frozen, so the move itself is refused.
  const decoy = one(await rest('POST', 'crm', 'contacts', {
    organization_id: org, full_name: `${MARK} decoy`, phone: `+9197${Date.now() % 100000000}`,
  }))?.id;
  const reparent = await rest('PATCH', 'crm', `communication_consent?contact_id=eq.${contact}`, { contact_id: decoy });
  check(reparent.status >= 400 && /does not change hands|reparent/i.test(reparent.text), 'a consent row cannot be moved to another contact', reparent.text.slice(0, 90));
  await rest('DELETE', 'crm', `contacts?id=eq.${decoy}`);
  // TRUNCATE cannot be issued over PostgREST at all, and the statement-level
  // guard refuses it besides; that arm is proven in psql, not here.

  const cascade = await rest('DELETE', 'crm', `contacts?id=eq.${contact}`);
  check(cascade.status < 400, 'deleting the contact itself is allowed', `HTTP ${cascade.status}`);
  const orphans = await rest('GET', 'crm', `communication_consent?contact_id=eq.${contact}&select=contact_id`);
  check(Array.isArray(orphans.json) && orphans.json.length === 0, 'and the cascade took the consent rows with it', orphans.text.slice(0, 80));

  // ── 2. the handoff machine ───────────────────────────────────────────────
  console.log('\n2. A handoff cannot declare itself done');
  const born = await rest('POST', 'ai', 'handoffs', {
    organization_id: org, correlation_id: randomUUID(),
    from_agent: 'requirement_collector', to_agent: 'quality_assurance',
    objective: `${MARK} born-completed`, status: 'completed',
    verification: { anything: true }, depth: 0,
  });
  check(born.status >= 400 && /born queued/i.test(born.text), 'a handoff born completed is refused', born.text.slice(0, 90));

  const h = one(await rest('POST', 'ai', 'handoffs', {
    organization_id: org, correlation_id: randomUUID(),
    from_agent: 'requirement_collector', to_agent: 'quality_assurance',
    objective: `${MARK} machine`, depth: 0,
  }))?.id;

  const jump = await rest('PATCH', 'ai', `handoffs?id=eq.${h}`, {
    status: 'completed',
    verification: { outcome: 'verified', verifier: 'quality_assurance', evidence: [{ kind: 'requirement', passed: true }] },
  });
  check(jump.status >= 400 && /no such edge/i.test(jump.text), 'queued cannot jump straight to completed', jump.text.slice(0, 90));

  await rest('PATCH', 'ai', `handoffs?id=eq.${h}`, { status: 'accepted' });
  await rest('PATCH', 'ai', `handoffs?id=eq.${h}`, { status: 'running' });

  const selfV = await rest('PATCH', 'ai', `handoffs?id=eq.${h}`, {
    status: 'completed',
    verification: { outcome: 'verified', verifier: 'requirement_collector', evidence: [{ kind: 'requirement', passed: true }] },
  });
  check(selfV.status >= 400 && /producer never verifies|not it/i.test(selfV.text), 'a self-signed completion is refused', selfV.text.slice(0, 90));

  const empty = await rest('PATCH', 'ai', `handoffs?id=eq.${h}`, {
    status: 'completed',
    verification: { outcome: 'verified', verifier: 'quality_assurance', evidence: [] },
  });
  check(empty.status >= 400, 'a completion with no evidence is refused', empty.text.slice(0, 90));

  const failedEv = await rest('PATCH', 'ai', `handoffs?id=eq.${h}`, {
    status: 'completed',
    verification: { outcome: 'verified', verifier: 'quality_assurance', evidence: [{ kind: 'tests', passed: false }] },
  });
  check(failedEv.status >= 400, 'a verified verdict carrying failed evidence is refused', failedEv.text.slice(0, 90));

  const legit = await rest('PATCH', 'ai', `handoffs?id=eq.${h}`, {
    status: 'completed',
    verification: { outcome: 'verified', verifier: 'quality_assurance', evidence: [{ kind: 'requirement', passed: true }] },
  });
  check(legit.status < 400, 'the legitimate completion is accepted', legit.text.slice(0, 90));
  check(typeof one(legit)?.completed_at === 'string', 'and completed_at is stamped by the guard');

  const rewrite = await rest('PATCH', 'ai', `handoffs?id=eq.${h}`, {
    verification: { outcome: 'verified', verifier: 'forged', evidence: [{ kind: 'requirement', passed: true }] },
  });
  check(rewrite.status >= 400 && /frozen/i.test(rewrite.text), 'a settled verdict cannot be rewritten', rewrite.text.slice(0, 90));

  const reopen = await rest('PATCH', 'ai', `handoffs?id=eq.${h}`, { status: 'running' });
  check(reopen.status >= 400 && /terminal|no such edge/i.test(reopen.text), 'terminal has no exits', reopen.text.slice(0, 90));

  // Relabeling a settled handoff's agents is refused. With today's
  // single-pair registry, enforce_handoff_target is the first refusal (any
  // change makes an undeclared pair); the terminal freeze is what still
  // refuses it once a second pair makes some other from/to legal. Either
  // refusal means the row is protected — which is the property under test.
  const relabel = await rest('PATCH', 'ai', `handoffs?id=eq.${h}`, { from_agent: 'quality_assurance' });
  check(relabel.status >= 400, 'the agents a settled handoff names cannot be relabeled', relabel.text.slice(0, 90));

  const erase = await rest('DELETE', 'ai', `handoffs?id=eq.${h}`);
  check(erase.status >= 400 && /not deleted|forging by omission/i.test(erase.text), 'a settled verdict cannot be deleted while its org exists', erase.text.slice(0, 90));

  // The QA-shape legitimacy arm is what `legit` exercised: quality_assurance
  // is the SENDER's declared verifier signing work carried to it. The other
  // arm — the receiver's own declared verifier — needs a handoff whose
  // receiver has a mirror row; with two agents defined, that pair does not
  // exist yet, and inventing an agent to test it would test the invention.
  console.log('\n  (verifier-of-receiver arm becomes testable when a second producer exists)');
} finally {
  if (org) {
    const gone = await rest('DELETE', 'core', `organizations?id=eq.${org}`);
    check(gone.status < 400, 'the probe organization deletes cleanly — nothing here is undeletable', `HTTP ${gone.status}`);
  }
}

console.log(`\n  ${checks} checks`);
if (failures > 0) {
  console.error(`\n\x1b[31m✖ ${failures} failure(s)\x1b[0m`);
  process.exit(1);
}
console.log('\n\x1b[32m✔ Consent cannot be erased and completion cannot be forged\x1b[0m');
