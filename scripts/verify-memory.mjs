// ═══════════════════════════════════════════════════════════════════════════
// Memory that cannot promote itself.
//
// Doc 05 §35: "Never store a model-generated assumption as a verified client
// fact without provenance." §18 defines the ladder — explicit, verified,
// inferred, temporary, stale, conflicted — and then the sentence that makes it
// a rule: "Only EXPLICIT/VERIFIED information should normally drive important
// business decisions without additional validation."
//
// Two of those are structural here and both are asserted against real
// Postgres: a claim to come from somewhere must say where, and an AGENT may
// never write `verified`. The second is the memory version of a producer
// verifying its own work.
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: false });
announceTarget(target, 'a model-derived guess cannot become a client fact');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const ORG = '00000000-0000-4000-8000-000000000001';

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

async function rest(method, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'Content-Profile': 'ai',
      'Accept-Profile': 'ai',
      Prefer: 'return=representation',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ok: res.ok, status: res.status, json: parse(await res.text()) };
}

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const remember = (over) =>
  rest('POST', 'memory_records', {
    organization_id: ORG,
    scope: 'organization',
    kind: 'preference',
    fact: 'The client prefers WhatsApp over email.',
    ...over,
  });

const written = [];

try {
  console.log('\n  A. a claim to come from somewhere must say where');

  const bare = await remember({ confidence: 'explicit' });
  check(
    !bare.ok && /provenance/.test(JSON.stringify(bare.json)),
    'explicit with no source is refused',
    bare.ok ? 'IT WAS ACCEPTED' : `${bare.status}`,
  );

  const bareVerified = await remember({ confidence: 'verified' });
  check(
    !bareVerified.ok && /provenance/.test(JSON.stringify(bareVerified.json)),
    'and so is verified',
    bareVerified.ok ? 'IT WAS ACCEPTED' : `${bareVerified.status}`,
  );

  const sourced = one(
    await remember({
      confidence: 'explicit',
      source_kind: 'crm.conversation_messages',
      source_id: randomUUID(),
    }),
  );
  check(Boolean(sourced?.id), 'with provenance it is accepted');
  if (sourced?.id) written.push(sourced.id);

  const guess = one(await remember({ confidence: 'inferred', fact: 'They are probably price-sensitive.' }));
  check(Boolean(guess?.id), 'an inference needs no source, because it claims none');
  if (guess?.id) written.push(guess.id);

  console.log('\n  B. an agent may not confirm its own inference');

  const agentVerified = await remember({
    confidence: 'verified',
    source_kind: 'ai.agent_runs',
    source_id: randomUUID(),
    authored_by_agent: 'requirement_collector',
  });
  check(
    !agentVerified.ok && /memory_agent_cannot_verify|cannot_verify/.test(JSON.stringify(agentVerified.json)),
    'even WITH provenance, an agent cannot write `verified`',
    agentVerified.ok ? 'IT WAS ACCEPTED' : `${agentVerified.status}`,
  );

  const agentGuess = one(
    await remember({
      confidence: 'inferred',
      fact: 'The client seems to want a vendor portal.',
      authored_by_agent: 'requirement_collector',
    }),
  );
  check(Boolean(agentGuess?.id), 'an agent may infer, which is the whole of what it may do');
  if (agentGuess?.id) written.push(agentGuess.id);

  const promote = await rest('PATCH', `memory_records?id=eq.${agentGuess.id}`, {
    confidence: 'explicit',
  });
  check(
    !promote.ok && /cannot become explicit/.test(JSON.stringify(promote.json)),
    'nor promote it afterwards — a client states a fact, an agent infers one',
    promote.ok ? 'IT WAS ACCEPTED' : `${promote.status}`,
  );

  console.log('\n  C. a correction supersedes, it does not overwrite');

  const corrected = one(
    await remember({
      confidence: 'explicit',
      fact: 'The client prefers email after all.',
      source_kind: 'crm.conversation_messages',
      source_id: randomUUID(),
    }),
  );
  if (corrected?.id) written.push(corrected.id);

  const supersede = await rest('PATCH', `memory_records?id=eq.${sourced.id}`, {
    superseded_by: corrected.id,
  });
  check(supersede.ok, 'the old fact is superseded by the new one', supersede.ok ? '' : `${supersede.status}`);

  const unsupersede = await rest('PATCH', `memory_records?id=eq.${sourced.id}`, { superseded_by: null });
  check(
    !unsupersede.ok && /stays superseded/.test(JSON.stringify(unsupersede.json)),
    'and cannot be un-superseded',
    unsupersede.ok ? 'IT WAS ACCEPTED' : `${unsupersede.status}`,
  );

  const editHistory = await rest('PATCH', `memory_records?id=eq.${sourced.id}`, {
    fact: 'Actually they never said that.',
  });
  check(
    !editHistory.ok && /history/.test(JSON.stringify(editHistory.json)),
    'nor edited — it is history now',
    editHistory.ok ? 'IT WAS ACCEPTED' : `${editHistory.status}`,
  );

  const deleted = await rest('DELETE', `memory_records?id=eq.${guess.id}`);
  check(
    !deleted.ok && /never deleted/.test(JSON.stringify(deleted.json)),
    'and no memory is deleted at all',
    deleted.ok ? 'IT WAS ACCEPTED' : `${deleted.status}`,
  );

  console.log('\n  D. recall returns what may be relied on, in that order');

  const recalled = await rest('POST', 'rpc/recall', { p_scope: 'organization', p_limit: 50 });
  const rows = Array.isArray(recalled.json) ? recalled.json : [];
  check(recalled.ok, 'recall answers for a scope', recalled.ok ? `${rows.length} rows` : `${recalled.status}`);

  check(
    !rows.some((r) => r.id === sourced.id),
    'a superseded memory is never returned',
    rows.some((r) => r.id === sourced.id) ? 'IT CAME BACK' : '',
  );

  const order = rows.map((r) => r.confidence);
  const rank = { explicit: 0, verified: 1, conflicted: 2, inferred: 3, temporary: 4, stale: 5 };
  check(
    order.every((c, i) => i === 0 || rank[order[i - 1]] <= rank[c]),
    'what a client said outranks what a model guessed',
    order.join(' → '),
  );

  console.log('\n  E. an expired memory stops being context');

  const expired = one(
    await remember({
      confidence: 'temporary',
      kind: 'task_note',
      fact: 'Waiting on the logo for this stage only.',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    }),
  );
  if (expired?.id) written.push(expired.id);

  const after = await rest('POST', 'rpc/recall', { p_scope: 'organization', p_limit: 50 });
  check(
    !(Array.isArray(after.json) ? after.json : []).some((r) => r.id === expired.id),
    'it is stored, and it is not recalled',
  );
} finally {
  // Deliberately not deleted — the table refuses it, which is the point of
  // check C. Superseded into a marker instead, so a re-run is clean and the
  // history stays intact.
  for (const id of written) {
    await rest('PATCH', `memory_records?id=eq.${id}`, { kind: 'zztest-memory' }).catch(() => {});
  }
}

if (failures > 0) {
  console.error(`\n  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
