// ═══════════════════════════════════════════════════════════════════════════
// A failed extraction must not wedge its transcript.
//
// Found on production: three requirement versions for one conversation, all
// `failed`, under a button offering to queue the extraction again — and
// queueing it again could never have run anything.
//
// Two mechanisms held it shut, and only one of them lives in code the test
// suite can read. This checks the other: the unique index. Under the old
// definition, (organization, conversation, source_message_count) was unique
// regardless of status, so the row recording a FAILURE occupied the slot a
// successful retry needed, and that retry died on 23505 instead.
//
// Asserted against a real Postgres because a partial unique index is exactly
// the kind of thing that reads correctly and behaves otherwise: the predicate
// is evaluated by the database, and `status <> 'failed'` over a `not null`
// column is a claim about SQL's three-valued logic, not about JavaScript.
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: false });
announceTarget(target, 'a failed extraction does not wedge its transcript');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-retry';
const ORG = '00000000-0000-4000-8000-000000000001';

let failures = 0;

function check(condition, description, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${description}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

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

const created = { leads: [], conversations: [] };

/** One version at a stated transcript length. */
const version = (conversationId, n, status, count) =>
  rest('POST', 'crm', 'requirement_versions', {
    organization_id: ORG,
    conversation_id: conversationId,
    version: n,
    source: 'agent',
    status,
    payload: {},
    source_message_count: count,
  });

try {
  const lead = one(
    await rest('POST', 'crm', 'leads', {
      organization_id: ORG,
      source: 'manual',
      title: `${MARKER} ${randomUUID().slice(0, 8)}`,
      status: 'new',
    }),
  );
  created.leads.push(lead.id);

  const conversation = one(
    await rest('POST', 'crm', 'conversations', {
      organization_id: ORG,
      lead_id: lead.id,
      channel: 'whatsapp',
      kind: 'direct',
      status: 'active',
    }),
  );
  created.conversations.push(conversation.id);

  const COUNT = 10;

  console.log('\n  A. a failure does not take the slot');
  const firstFailure = await version(conversation.id, 1, 'failed', COUNT);
  check(firstFailure.ok, 'a failed version records at a transcript length', `${firstFailure.status}`);

  const retry = await version(conversation.id, 2, 'proposed', COUNT);
  check(
    retry.ok,
    'and a successful retry at the SAME length is accepted',
    retry.ok ? `${retry.status}` : `${retry.status} ${JSON.stringify(retry.json).slice(0, 120)}`,
  );

  console.log('\n  B. failures may accumulate — they are the history the screen shows');
  const secondFailure = await version(conversation.id, 3, 'failed', COUNT);
  check(secondFailure.ok, 'a second failure at that length is not refused', `${secondFailure.status}`);

  console.log('\n  C. but one proposal per transcript state still holds');
  const duplicate = await version(conversation.id, 4, 'proposed', COUNT);
  check(
    !duplicate.ok && duplicate.status === 409,
    'a SECOND non-failed version at the same length is refused',
    `${duplicate.status}`,
  );
  check(
    JSON.stringify(duplicate.json ?? '').includes('requirement_versions_transcript_state_key'),
    'and the refusal names the transcript-state key',
    JSON.stringify(duplicate.json ?? '').slice(0, 140),
  );

  console.log('\n  D. the guard is still scoped, and still keyed on length');
  const otherLength = await version(conversation.id, 5, 'proposed', COUNT + 1);
  check(otherLength.ok, 'a longer transcript is a different thing to read', `${otherLength.status}`);

  // ── E. the same rule on the other key ──────────────────────────────────
  //
  // requirement_versions_source_job_key is the double-run guard: one proposal
  // per job. With `failed` inside it, a job that exhausted its attempts left a
  // row that its own requeued run then collided with — so pressing Requeue
  // could never produce anything. Same shape as A–C, one key over.
  console.log('\n  E. a requeued job is not blocked by the run it is retrying');
  const JOB = randomUUID();

  const bySameJob = (n, status, count) =>
    rest('POST', 'crm', 'requirement_versions', {
      organization_id: ORG,
      conversation_id: conversation.id,
      version: n,
      source: 'agent',
      status,
      payload: {},
      source_job_id: JOB,
      source_message_count: count,
    });

  const jobFailed = await bySameJob(6, 'failed', COUNT + 2);
  check(jobFailed.ok, 'a job records its failure', `${jobFailed.status}`);

  const jobRetry = await bySameJob(7, 'proposed', COUNT + 3);
  check(
    jobRetry.ok,
    'and the SAME job may then produce a proposal',
    jobRetry.ok ? `${jobRetry.status}` : `${jobRetry.status} ${JSON.stringify(jobRetry.json).slice(0, 140)}`,
  );

  const jobTwice = await bySameJob(8, 'proposed', COUNT + 4);
  check(
    !jobTwice.ok && jobTwice.status === 409,
    'but never TWO — the double-run guard is intact',
    `${jobTwice.status}`,
  );
  check(
    JSON.stringify(jobTwice.json ?? '').includes('requirement_versions_source_job_key'),
    'and the refusal names the source-job key',
    JSON.stringify(jobTwice.json ?? '').slice(0, 140),
  );
} finally {
  for (const id of created.conversations) {
    await rest('DELETE', 'crm', `conversations?id=eq.${id}`);
  }
  for (const id of created.leads) {
    await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  }
}

if (failures > 0) {
  console.error(`\n  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
