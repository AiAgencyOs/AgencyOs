// ═══════════════════════════════════════════════════════════════════════════
// A number the owner declined.
//
// ADM-88: "no numeric lead score and no invented weights — the repository has
// no approved scoring model and inventing one is out of scope."
//
// `crm.leads.score` is a 0–100 column and `score_reasons` is a jsonb beside
// it. Both were empty in code and BOTH WERE FILLED BY THE SEED, so every fresh
// environment showed an operator `· score 82` with reasons under it for a
// feature that does not exist. The columns are retained and constrained rather
// than dropped, so the decision stays visible where somebody would reach for
// it — and the next thing to reach for it is an agent asked to qualify a lead
// and offered a bounded numeric column.
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
announceTarget(target, 'a lead cannot carry a score nobody approved');

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
const refusedForScore = (r) => !r.ok && /leads_no_invented_score/.test(JSON.stringify(r.json));

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
  check(lead?.score === null && lead?.score_reasons === null, 'and carries neither column');

  console.log('\n  B. and it cannot be given one');

  const scored = await rest('PATCH', 'crm', `leads?id=eq.${leadId}`, { score: 82 });
  check(refusedForScore(scored), 'a score is refused', scored.ok ? 'IT WAS ACCEPTED' : `${scored.status}`);

  const zero = await rest('PATCH', 'crm', `leads?id=eq.${leadId}`, { score: 0 });
  check(refusedForScore(zero), 'including zero — an in-range value is still a score', zero.ok ? 'IT WAS ACCEPTED' : `${zero.status}`);

  const reasons = await rest('PATCH', 'crm', `leads?id=eq.${leadId}`, {
    score_reasons: { reasons: ['Budget confirmed'] },
  });
  check(
    refusedForScore(reasons),
    'and so are the reasons alone — a justification with no number is still an invented weight',
    reasons.ok ? 'IT WAS ACCEPTED' : `${reasons.status}`,
  );

  const born = await rest('POST', 'crm', 'leads', {
    organization_id: ORG,
    title: `${MARKER} born scored`,
    source: 'web_form',
    status: 'new',
    score: 91,
  });
  check(refusedForScore(born), 'a lead cannot be born with one either', born.ok ? 'IT WAS ACCEPTED' : `${born.status}`);
  const bornId = one(born)?.id;
  if (bornId) created.push(bornId);

  console.log('\n  C. everything else about the lead still moves');

  const renamed = await rest('PATCH', 'crm', `leads?id=eq.${leadId}`, { title: `${MARKER} renamed` });
  check(renamed.ok, 'the constraint refuses two columns and nothing else', renamed.ok ? '' : `${renamed.status}`);

  console.log('\n  D. and what was built instead still answers');

  // ADM-88 did not leave prioritisation undecided; it decided it differently.
  // `crm.reactivation_priority` orders by recorded fact-tiers, with no
  // coefficient in it. Asserted here so this script proves the rule AND its
  // replacement, rather than only the prohibition.
  const ranked = await rest('POST', 'crm', 'rpc/reactivation_priority', {
    p_organization_id: ORG,
    p_limit: 5,
  });
  check(ranked.ok, 'reactivation priority still ranks by recorded fact', ranked.ok ? '' : `${ranked.status}`);
  // The tier ORDERING is not re-asserted here. This database has no
  // consent-eligible lead, so a loop over the result would pass by being
  // empty — a check that passes for the wrong reason, which this repository
  // has shipped before and now refuses to. `db:verify:priority` proves the
  // four tiers, the recency tie-break, the no-consent exclusion and the
  // tenant pin against fixtures built for it. This asserts only that the
  // replacement is still reachable, which is what removing the score risks.

  console.log('\n  E. the seed no longer ships a score either');

  const seeded = await rest(
    'GET',
    'crm',
    'leads?select=title,score,score_reasons&score=not.is.null',
  );
  check(
    Array.isArray(seeded.json) && seeded.json.length === 0,
    'no lead in this database carries one',
    Array.isArray(seeded.json) && seeded.json.length ? seeded.json.map((r) => r.title).join(', ') : '',
  );
} finally {
  for (const id of created) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
}

if (failures > 0) {
  console.error(`\n  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
