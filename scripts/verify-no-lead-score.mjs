// ═══════════════════════════════════════════════════════════════════════════
// A number that is never invented.
//
// ADM-88 — Decision: reversed by the owner on 2026-09-29.
//
// The first rule was "no numeric lead score and no invented weights", held as
// `check (score is null and score_reasons is null)`, and this script proved
// it against real Postgres. The owner reversed it: a 0–100 score computed by
// `src/modules/crm/lead-score.ts` from stated inputs and stored by
// `crm.set_lead_score` WITH its reasons. What this script now proves is the
// rule in its new direction — `leads_score_carries_its_reasons`: a score is
// stored with a non-empty reasons array, an inputs object and a time, or not
// at all. A bare number is still refused; so is a justification with no
// number, so are reasons with no inputs.
//
// A constraint is the only form of this rule that an agent cannot talk its way
// past (Doc 19 §38), so it is asserted here against real Postgres rather than
// inferred from the migration text.
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: false });
announceTarget(target, 'a lead score never travels without its reasons and inputs');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = 'zztest-score';

let failures = 0;
function check(condition, description, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${description}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

const parse = (t) => {
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return t;
  }
};

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'Content-Profile': schema,
      'Accept-Profile': schema,
      Prefer: 'return=representation',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ok: res.ok, status: res.status, json: parse(await res.text()) };
}

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const refusedForScore = (r) => !r.ok && /leads_score_carries_its_reasons/.test(JSON.stringify(r.json));

// Every lead this script creates, INCLUDING the ones it expects to be
// refused. A refusal that does not happen leaves a row behind, and the only
// time that occurs is a red-proof run — precisely when the next `alter table`
// has to succeed. A harness that cannot clean up after the failure it was
// written to detect makes the failure harder to recover from than to find.
const created = [];
let leadId;

try {
  console.log('\n  A. a lead is created, and it has no score');

  const lead = one(
    await rest('POST', 'crm', 'leads', {
      organization_id: ORG,
      title: `${MARKER} ${randomUUID().slice(0, 8)}`,
      source: 'web_form',
      status: 'new',
    }),
  );
  check(Boolean(lead?.id), 'the lead is created');
  leadId = lead?.id;
  if (leadId) created.push(leadId);
  check(
    lead?.score === null && lead?.score_reasons === null && lead?.score_inputs === null && lead?.scored_at === null,
    'and carries none of the four columns',
  );

  console.log('\n  B. a bare number is refused, and so is every partial row');

  const reasons = [{ code: 'coverage', points: 0, detail: '0 of 15 qualification areas covered' }, { code: 'engagement', points: 8, detail: '1 client reply' }];
  const inputs = { source: 'web_form', status: 'new', clientReplies: 1 };
  const now = new Date().toISOString();

  const bare = await rest('PATCH', 'crm', `leads?id=eq.${leadId}`, { score: 82 });
  check(refusedForScore(bare), 'a score alone is refused', bare.ok ? 'IT WAS ACCEPTED' : `${bare.status}`);

  const zero = await rest('PATCH', 'crm', `leads?id=eq.${leadId}`, { score: 0 });
  check(refusedForScore(zero), 'including zero — an in-range value is still a bare score', zero.ok ? 'IT WAS ACCEPTED' : `${zero.status}`);

  const reasonsOnly = await rest('PATCH', 'crm', `leads?id=eq.${leadId}`, { score_reasons: reasons });
  check(refusedForScore(reasonsOnly), 'reasons alone are refused — a justification with no number', reasonsOnly.ok ? 'IT WAS ACCEPTED' : `${reasonsOnly.status}`);

  const noInputs = await rest('PATCH', 'crm', `leads?id=eq.${leadId}`, { score: 8, score_reasons: reasons, scored_at: now });
  check(refusedForScore(noInputs), 'a score with reasons but no inputs is refused', noInputs.ok ? 'IT WAS ACCEPTED' : `${noInputs.status}`);

  const emptyReasons = await rest('PATCH', 'crm', `leads?id=eq.${leadId}`, { score: 8, score_reasons: [], score_inputs: inputs, scored_at: now });
  check(refusedForScore(emptyReasons), 'an empty reasons array is refused — a reason list that says nothing', emptyReasons.ok ? 'IT WAS ACCEPTED' : `${emptyReasons.status}`);

  const noTime = await rest('PATCH', 'crm', `leads?id=eq.${leadId}`, { score: 8, score_reasons: reasons, score_inputs: inputs });
  check(refusedForScore(noTime), 'a score with no scored_at is refused', noTime.ok ? 'IT WAS ACCEPTED' : `${noTime.status}`);

  const born = await rest('POST', 'crm', 'leads', {
    organization_id: ORG,
    title: `${MARKER} born scored`,
    source: 'web_form',
    status: 'new',
    score: 91,
  });
  check(refusedForScore(born), 'a lead cannot be born with a bare score either', born.ok ? 'IT WAS ACCEPTED' : `${born.status}`);
  const bornId = one(born)?.id;
  if (bornId) created.push(bornId);

  console.log('\n  C. the whole row is accepted, and the door writes it');

  const whole = await rest('PATCH', 'crm', `leads?id=eq.${leadId}`, { score: 8, score_reasons: reasons, score_inputs: inputs, scored_at: now });
  check(whole.ok, 'score + reasons + inputs + time is accepted together', whole.ok ? '' : `${whole.status} ${JSON.stringify(whole.json).slice(0, 200)}`);

  const cleared = await rest('PATCH', 'crm', `leads?id=eq.${leadId}`, { score: null, score_reasons: null, score_inputs: null, scored_at: null });
  check(cleared.ok, 'and all four clear together', cleared.ok ? '' : `${cleared.status}`);

  // The door, as the service role: it refuses the same partial shapes by
  // name before the constraint has to, and accepts the whole.
  const doorNoReasons = await rest('POST', 'crm', 'rpc/set_lead_score', { p_lead_id: leadId, p_score: 8, p_reasons: [], p_inputs: inputs });
  check(!doorNoReasons.ok || one(doorNoReasons)?.outcome === 'no_reasons' || one(doorNoReasons)?.outcome === 'no_actor',
    'crm.set_lead_score refuses empty reasons (or a caller with no actor)', JSON.stringify(doorNoReasons.json).slice(0, 120));

  const doorBad = await rest('POST', 'crm', 'rpc/set_lead_score', { p_lead_id: leadId, p_score: 101, p_reasons: reasons, p_inputs: inputs });
  check(!doorBad.ok || one(doorBad)?.outcome === 'bad_score' || one(doorBad)?.outcome === 'no_actor',
    'and a score above 100 (or a caller with no actor)', JSON.stringify(doorBad.json).slice(0, 120));

  console.log('\n  D. everything else about the lead still moves');

  const renamed = await rest('PATCH', 'crm', `leads?id=eq.${leadId}`, { title: `${MARKER} renamed` });
  check(renamed.ok, 'the constraint refuses four columns and nothing else', renamed.ok ? '' : `${renamed.status}`);

  console.log('\n  E. and what was built beside it still answers');

  // Reactivation ordering (`crm.reactivation_priority`) was built under the
  // first ADM-88 as an order over recorded facts; the reversal adds a score,
  // it does not remove the order. Asserted so the reversal proves it left
  // the replacement standing.
  const ranked = await rest('POST', 'crm', 'rpc/reactivation_priority', {
    p_organization_id: ORG,
    p_limit: 5,
  });
  check(ranked.ok, 'reactivation priority still ranks by recorded fact', ranked.ok ? '' : `${ranked.status}`);

  console.log('\n  F. no lead in this database carries a score without reasons');

  const orphaned = await rest(
    'GET',
    'crm',
    'leads?select=title,score,score_reasons&score=not.is.null&score_reasons=is.null',
  );
  check(
    Array.isArray(orphaned.json) && orphaned.json.length === 0,
    'every stored score has its reasons beside it',
    Array.isArray(orphaned.json) && orphaned.json.length ? orphaned.json.map((r) => r.title).join(', ') : '',
  );
} finally {
  for (const id of created) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
}

if (failures > 0) {
  console.error(`\n  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
