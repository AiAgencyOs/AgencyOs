#!/usr/bin/env node
/**
 * The requirement proposal lifecycle, verified end to end.
 *
 * This is the whole chain in one run: a signed WhatsApp delivery arrives at the
 * real webhook, becomes a lead and a queued job, the real job runner claims it
 * and extracts a requirement set, and the proposal that lands is decided by a
 * human — or refused, when a human tries to decide it twice.
 *
 * The model is a stub on 127.0.0.1:54399. The dev server points at it through
 * ANTHROPIC_BASE_URL (see .env.verify.local.example), so the SDK, the retry
 * loop, the budget and the schema validation are all the real ones and nothing
 * leaves this machine. That is the same stand-in tests/ai-extraction.test.ts
 * uses; here it is wired to the running application instead of to the provider.
 *
 *   • an inbound message creates exactly one extraction job
 *   • running the job creates exactly one proposal, status `proposed`
 *   • redelivering the message creates no second job and no second proposal
 *   • re-running the same job — what the reaper causes — creates no second
 *     proposal, and does not pay for a second model call
 *   • an extraction that keeps failing ends as `failed`, only once its attempts
 *     are spent
 *   • approving changes exactly one row, and nothing else about it
 *   • an approved or rejected proposal cannot be silently changed
 *   • one organization's proposal is unreachable from another's context
 *   • nothing is ever sent to the client
 *
 *   npm run verify:db:up        # a local stack, if you do not have one
 *   npm run verify:dev          # in another terminal
 *   npm run db:verify:proposal
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

import { announceTarget, assertAppTarget, resolveTarget } from './verify-target.mjs';

const SLUG_A = 'zztest-proposal-a';
const SLUG_B = 'zztest-proposal-b';
const PN_A = 'ZZTEST_PROPOSAL_PN_A';
const SENDER = '919900770066';
const STUB_PORT = 54399;

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const target = resolveTarget(fail, { cron: true, anon: true, whatsapp: true, jwt: true });
const URL_BASE = target.url;
const SECRET = target.serviceKey;
const ANON = target.anonKey;
const CRON_SECRET = target.cronSecret;
const APP = target.app;

// ── PostgREST ──────────────────────────────────────────────────────────────

async function request(method, schema, path, { body, prefer, key = SECRET } = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(schema && schema !== 'public'
        ? method === 'GET'
          ? { 'Accept-Profile': schema }
          : { 'Content-Profile': schema }
        : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* reported through text */
  }
  return { status: res.status, ok: res.ok, json, text };
}

const select = (schema, path, key) => request('GET', schema, path, key ? { key } : {});
const insert = (schema, table, body) =>
  request('POST', schema, table, { body, prefer: 'return=representation' });
const patch = (schema, path, body, key = SECRET) =>
  request('PATCH', schema, path, { body, prefer: 'return=representation', key });
const remove = (schema, path) => request('DELETE', schema, path);
const rows = async (schema, path, key) => (await select(schema, path, key)).json ?? [];
const countOf = async (schema, path) => (await rows(schema, path)).length;

// ── the stub model ─────────────────────────────────────────────────────────

/** What the next model call receives. Swapped between phases. */
let stubMode = 'ok';
let modelCalls = 0;
/** Widens the window between two runners' checks so the C2 race is reachable. */
let stubDelayMs = 0;

/**
 * Must satisfy requirementPayloadSchema exactly — the runner validates the
 * model's output against it and refuses anything else, so an incomplete fixture
 * here fails the extraction rather than the assertion, which is the schema
 * doing its job.
 */
const EXTRACTED = {
  summary: 'A booking system for a dental practice.',
  scopeItems: [{ title: 'Online appointment booking', detail: 'Patients self-serve' }],
  constraints: ['Must work on mobile'],
  openQuestions: ['Which payment provider?'],
};

const stub = createServer((req, res) => {
  modelCalls += 1;
  req.resume();
  if (stubMode === 'error') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'stub failure' } }));
    return;
  }
  const send = () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(EXTRACTED) }],
        usage: { input_tokens: 40, output_tokens: 30 },
      }),
    );
  };
  if (stubDelayMs) setTimeout(send, stubDelayMs);
  else send();
});

// ── the real webhook ───────────────────────────────────────────────────────

const sign = (body) =>
  `sha256=${createHmac('sha256', target.whatsappAppSecret).update(body, 'utf8').digest('hex')}`;

async function deliver(externalRef, text) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ZZTEST',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PN_A },
              contacts: [{ profile: { name: 'Meera' }, wa_id: SENDER }],
              messages: [
                {
                  from: SENDER,
                  id: externalRef,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const body = JSON.stringify(payload);
  const res = await fetch(`${APP}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body) },
    body,
    cache: 'no-store',
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** One tick of the real job runner. */
async function runJobs() {
  const res = await fetch(`${APP}/api/jobs/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
    cache: 'no-store',
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let failures = 0;
const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  failures++;
};
const check = (cond, m) => (cond ? pass(m) : bad(m));
const note = (m) => console.log(`  \x1b[33m•\x1b[0m ${m}`);
const section = (m) => console.log(`\n${m}`);

async function dropOrganizations() {
  for (const slug of [SLUG_A, SLUG_B]) await remove('core', `organizations?slug=eq.${slug}`);
}

/** Parks every other queued extraction so the runner claims only ours. */
async function isolateQueue(exceptOrg) {
  await patch('core', `jobs?kind=eq.requirement.extract&status=eq.queued&organization_id=neq.${exceptOrg}`, {
    status: 'cancelled',
  });
}

console.log('\n\x1b[1mRequirement proposal lifecycle — end to end\x1b[0m');

// ── 0. Preflight ───────────────────────────────────────────────────────────
section('0. Preflight');
announceTarget(target);
// This script drives the running application, so it must be talking to the
// same database (gap G-083). Checked before any fixture is planted.
await assertAppTarget(target, fail);

const health = await fetch(`${APP}/api/health`, { cache: 'no-store' }).catch(() => null);
check(Boolean(health?.ok), `app reachable at ${APP}`);
if (!health?.ok) fail(`the app is not running at ${APP} — start it with: npm run verify:dev`);

await new Promise((resolve, reject) => {
  stub.once('error', reject);
  stub.listen(STUB_PORT, '127.0.0.1', resolve);
}).catch((error) => fail(`could not bind the model stub on ${STUB_PORT}: ${error.message}`));
check(true, `model stub listening on 127.0.0.1:${STUB_PORT}`);
note('the dev server must have ANTHROPIC_BASE_URL pointed here (.env.verify.local)');

await dropOrganizations();

// ── 1. Fixture ─────────────────────────────────────────────────────────────
section('1. Fixture (temporary organizations only)');

const orgA = await insert('core', 'organizations', {
  name: 'ZZTEST Proposal A',
  slug: SLUG_A,
  settings: { whatsapp_phone_number_id: PN_A },
});
const orgB = await insert('core', 'organizations', { name: 'ZZTEST Proposal B', slug: SLUG_B });
const ORG_A = orgA.json?.[0]?.id;
const ORG_B = orgB.json?.[0]?.id;
if (!ORG_A || !ORG_B) fail(`could not create organizations: ${orgA.text} ${orgB.text}`);
check(true, 'two organizations exist');

await isolateQueue(ORG_A);

// ── 2. Inbound message → exactly one job ───────────────────────────────────
section('2. An inbound message creates one extraction job');

const inbound = await deliver('wamid.ZZTEST.P1', 'We need an online booking system for our clinic');
check(inbound.status === 200 && inbound.json?.ingested === 1, 'A. the webhook ingested the message');

let jobs = await rows('core', `jobs?organization_id=eq.${ORG_A}&select=*`);
check(jobs.length === 1, `A. exactly one job exists (${jobs.length})`);
check(jobs[0]?.kind === 'requirement.extract', 'A. of kind requirement.extract');
check(jobs[0]?.status === 'queued', 'A. queued, waiting for a tick');

const CONV = jobs[0]?.payload?.conversationId;
check(Boolean(CONV), 'A. pointing at the conversation it created');

// ── 3. Running the job → exactly one proposal ──────────────────────────────
section('3. The job creates one proposal');

stubMode = 'ok';
const callsBefore = modelCalls;
const tick = await runJobs();

check(tick.status === 200, 'B. the runner accepted the cron call');
check(modelCalls === callsBefore + 1, `B. exactly one model call was made (${modelCalls - callsBefore})`);

const versions = await rows('crm', `requirement_versions?conversation_id=eq.${CONV}&select=*`);
check(versions.length === 1, `B. exactly one requirement version exists (${versions.length})`);

const proposal = versions[0];
if (!proposal) {
  const why = (await rows('core', `jobs?id=eq.${jobs[0]?.id}&select=last_error`))[0]?.last_error;
  stub.close();
  fail(`no proposal was produced, so nothing below can be checked. The job says: ${why}`);
}
check(proposal?.status === 'proposed', 'C. it is a proposal, not approved data');
check(proposal?.source === 'agent', 'C. authored by the agent');
check(proposal?.version === 1, 'C. at version 1');
check(proposal?.organization_id === ORG_A, 'D. provenance: the organization');
check(proposal?.conversation_id === CONV, 'D. provenance: the conversation');
check(proposal?.source_job_id === jobs[0]?.id, 'D. provenance: the extraction job');
check(Boolean(proposal?.generated_by_run_id), 'D. provenance: the agent run');
check(proposal?.payload?.summary === EXTRACTED.summary, 'C. carrying what the model returned');

const run = (await rows('ai', `agent_runs?id=eq.${proposal?.generated_by_run_id}&select=*`))[0];
check(run?.status === 'succeeded', 'D. the agent run is recorded as succeeded');
check(Boolean(run?.model), `D. provenance: the model used (${run?.model ?? 'none'})`);
check(run?.trigger === `job:${jobs[0]?.id}`, 'D. the run names the job that triggered it');

const settled = (await rows('core', `jobs?id=eq.${jobs[0]?.id}&select=status`))[0];
check(settled?.status === 'succeeded', 'B. and the job is settled succeeded');

// ── 4. Replay creates nothing ──────────────────────────────────────────────
section('4. Redelivering the same message');

const replay = await deliver('wamid.ZZTEST.P1', 'We need an online booking system for our clinic');
check(replay.status === 200 && replay.json?.replayed === 1, 'E. the webhook reports a replay');
check(
  (await countOf('core', `jobs?organization_id=eq.${ORG_A}&select=id`)) === 1,
  'E. no second extraction job',
);
check(
  (await countOf('crm', `requirement_versions?conversation_id=eq.${CONV}&select=id`)) === 1,
  'E. and no second proposal',
);

// ── 5. Re-running the same job creates nothing ─────────────────────────────
section('5. The same job run twice (what the reaper causes)');

const before = modelCalls;
await patch('core', `jobs?id=eq.${jobs[0]?.id}`, { status: 'queued', locked_at: null, locked_by: null });
const second = await runJobs();

check(second.status === 200, 'F. the re-run was accepted');
check(second.body?.reason === 'already produced', 'F. and recognised as already produced');
check(modelCalls === before, `F. no second model call was paid for (${modelCalls - before})`);
check(
  (await countOf('crm', `requirement_versions?conversation_id=eq.${CONV}&select=id`)) === 1,
  'F. still exactly one proposal',
);

// ── 6. Approving ───────────────────────────────────────────────────────────
section('6. A human decides');

// A second proposal in the other organization, to prove a decision is narrow.
const convB = (
  await insert('crm', 'conversations', {
    organization_id: ORG_B,
    lead_id: (
      await insert('crm', 'leads', {
        organization_id: ORG_B,
        title: 'ZZTEST other org',
        source: 'manual',
      })
    ).json?.[0]?.id,
    channel: 'manual',
  })
).json?.[0]?.id;
const otherProposal = (
  await insert('crm', 'requirement_versions', {
    organization_id: ORG_B,
    conversation_id: convB,
    version: 1,
    source: 'agent',
    status: 'proposed',
    payload: {},
  })
).json?.[0];
check(Boolean(otherProposal), 'a second organization also has a proposal open');

const approved = await patch(
  'crm',
  `requirement_versions?id=eq.${proposal.id}&status=eq.proposed`,
  { status: 'accepted' },
);
check(approved.json?.[0]?.status === 'accepted', 'G. approving moves it to accepted');
check(
  (await rows('crm', `requirement_versions?id=eq.${otherProposal.id}&select=status`))[0]?.status ===
    'proposed',
  'G. the other organization’s proposal is untouched',
);

const reReject = await patch('crm', `requirement_versions?id=eq.${proposal.id}`, {
  status: 'rejected',
});
check(reReject.status >= 400, 'H. an accepted proposal cannot then be rejected');
check(
  (await rows('crm', `requirement_versions?id=eq.${proposal.id}&select=status`))[0]?.status ===
    'accepted',
  'H. and it is still accepted',
);

const edit = await patch('crm', `requirement_versions?id=eq.${proposal.id}`, {
  payload: { summary: 'rewritten after approval' },
});
check(edit.status >= 400, 'H. and the approved scope itself cannot be rewritten');

const rejected = await patch(
  'crm',
  `requirement_versions?id=eq.${otherProposal.id}&status=eq.proposed`,
  { status: 'rejected' },
);
check(rejected.json?.[0]?.status === 'rejected', 'I. rejecting the other proposal works');
check(
  (await rows('crm', `requirement_versions?id=eq.${proposal.id}&select=status`))[0]?.status ===
    'accepted',
  'I. and did not disturb the first',
);

const reApprove = await patch('crm', `requirement_versions?id=eq.${otherProposal.id}`, {
  status: 'accepted',
});
check(reApprove.status >= 400, 'I. a rejected proposal cannot be quietly approved');

// ── 6b. Who may decide, enforced by the database ───────────────────────────
//
// The gate has to hold against a caller who never runs the server action. The
// crm schema is exposed through PostgREST and a signed-in browser holds a
// session token, so this mints one token per internal role and PATCHes the row
// the way that browser could, checking the database's own answer rather than
// the application's.
section('6b. Only owner/ops_admin may decide, through PostgREST');

/** An HS256 token shaped the way core.current_user_role() reads it. */
function mintToken(role, organizationId) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub: randomUUID(),
    aud: 'authenticated',
    role: 'authenticated',
    iat: now,
    exp: now + 600,
    app_metadata: { role, organization_id: organizationId },
  });
  const signature = createHmac('sha256', target.jwtSecret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

/** One fresh proposal to attempt a decision on, so no attempt sees another's. */
async function freshProposal(version) {
  return (
    await insert('crm', 'requirement_versions', {
      organization_id: ORG_A,
      conversation_id: CONV,
      version,
      source: 'agent',
      status: 'proposed',
      payload: {},
    })
  ).json?.[0];
}

let nextVersion = 100;
for (const [role, mayDecide] of [
  ['member', false],
  ['delivery_lead', false],
  ['ops_admin', true],
  ['owner', true],
]) {
  const row = await freshProposal((nextVersion += 1));
  const token = mintToken(role, ORG_A);

  const res = await fetch(
    `${URL_BASE}/rest/v1/requirement_versions?id=eq.${row.id}&status=eq.proposed`,
    {
      method: 'PATCH',
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Profile': 'crm',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ status: 'accepted' }),
      cache: 'no-store',
    },
  );
  await res.text();

  const after = (await rows('crm', `requirement_versions?id=eq.${row.id}&select=status`))[0]?.status;

  if (mayDecide) {
    check(after === 'accepted', `M. ${role} (holds lead.write) can decide — status is ${after}`);
  } else {
    check(
      after === 'proposed',
      `M. ${role} (no lead.write) is refused by RLS — status is still ${after}`,
    );
  }
}

// A wrong-organization token must fail even for a role that may decide.
const strayAdmin = await freshProposal(nextVersion + 1);
const strayRes = await fetch(
  `${URL_BASE}/rest/v1/requirement_versions?id=eq.${strayAdmin.id}`,
  {
    method: 'PATCH',
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${mintToken('owner', ORG_B)}`,
      'Content-Type': 'application/json',
      'Content-Profile': 'crm',
    },
    body: JSON.stringify({ status: 'accepted' }),
    cache: 'no-store',
  },
);
await strayRes.text();
check(
  (await rows('crm', `requirement_versions?id=eq.${strayAdmin.id}&select=status`))[0]?.status ===
    'proposed',
  'M. an owner of another organization cannot decide this one’s proposal',
);

// ── 7. Organization isolation ──────────────────────────────────────────────
section('7. Organization isolation');

const leaked = await rows('crm', 'requirement_versions?select=id', ANON);
check(leaked.length === 0, 'J. a caller with no organization claim reads no proposals at all');

// Captured immediately before the attempt rather than hard-coded: by this
// point §6b has approved newer versions of the same conversation, which
// correctly supersedes this one. What matters is that the anonymous write
// changes nothing, not which state it happens to be resting in.
const statusBeforeAnon = (
  await rows('crm', `requirement_versions?id=eq.${proposal.id}&select=status`)
)[0]?.status;

const anonWrite = await patch(
  'crm',
  `requirement_versions?id=eq.${proposal.id}`,
  { status: 'rejected' },
  ANON,
);
check(
  anonWrite.status >= 400 || (anonWrite.json ?? []).length === 0,
  'J. and cannot decide one either',
);
const statusAfterAnon = (
  await rows('crm', `requirement_versions?id=eq.${proposal.id}&select=status`)
)[0]?.status;
check(
  statusAfterAnon === statusBeforeAnon && statusAfterAnon !== 'rejected',
  `J. the proposal is unchanged (still ${statusAfterAnon})`,
);

// ── 7b. Regression: C1 — one proposal per transcript state ─────────────────
//
// Two messages arriving between cron ticks queue two jobs, one at message
// count 1 and one at count 2. Whichever runs first reads the transcript as it
// stands — both messages — so before the fix the second job extracted exactly
// the same conversation again: two identical proposals and two model calls.
section('7b. C1 — two jobs over one transcript produce one proposal');

const C1_SENDER = '919900660055';

async function deliverAs(sender, externalRef, text) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ZZTEST',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PN_A },
              contacts: [{ profile: { name: 'C1 Probe' }, wa_id: sender }],
              messages: [
                {
                  from: sender,
                  id: externalRef,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const body = JSON.stringify(payload);
  const res = await fetch(`${APP}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body) },
    body,
    cache: 'no-store',
  });
  return res.json().catch(() => null);
}

stubMode = 'ok';
await deliverAs(C1_SENDER, 'wamid.ZZTEST.C1.a', 'We want a booking system');
await deliverAs(C1_SENDER, 'wamid.ZZTEST.C1.b', 'Budget is flexible');

const c1Jobs = await rows(
  'core',
  `jobs?organization_id=eq.${ORG_A}&status=eq.queued&kind=eq.requirement.extract&select=id,dedupe_key`,
);
check(c1Jobs.length === 2, `N. two jobs were queued, one per transcript state (${c1Jobs.length})`);

const c1Before = modelCalls;
await runJobs();
await runJobs();

// The thread key contains a `+`, which a query string decodes as a space.
const c1Ref = encodeURIComponent(`wa:+${C1_SENDER}`);
const c1Conv = (
  await rows('crm', `conversations?organization_id=eq.${ORG_A}&external_ref=eq.${c1Ref}&select=id`)
)[0]?.id;
if (!c1Conv) {
  stub.close();
  fail('the C1 probe conversation was not created — the webhook did not ingest');
}
const c1Versions = await rows(
  'crm',
  `requirement_versions?conversation_id=eq.${c1Conv}&select=version,status,source_message_count`,
);

check(modelCalls - c1Before === 1, `N. exactly one model call was paid for (${modelCalls - c1Before})`);
check(c1Versions.length === 1, `N. exactly one proposal exists (${c1Versions.length})`);
check(
  c1Versions[0]?.source_message_count === 2,
  `N. recorded against the transcript it read (${c1Versions[0]?.source_message_count} messages)`,
);
check(
  (await rows('core', `jobs?organization_id=eq.${ORG_A}&status=eq.queued&kind=eq.requirement.extract&select=id`))
    .length === 0,
  'N. both jobs settled — the redundant one was not left queued',
);

// ── 7c. Regression: C3 — one authoritative version ─────────────────────────
//
// Nothing ever set `superseded`, so every proposal stayed decidable and two
// versions could both be `accepted` with nothing saying which was the agreed
// scope.
section('7c. C3 — agreement moves rather than accumulating');

const c3a = (
  await insert('crm', 'requirement_versions', {
    organization_id: ORG_A,
    conversation_id: c1Conv,
    version: 50,
    source: 'agent',
    status: 'proposed',
    payload: {},
  })
).json?.[0];

const c3b = (
  await insert('crm', 'requirement_versions', {
    organization_id: ORG_A,
    conversation_id: c1Conv,
    version: 51,
    source: 'agent',
    status: 'proposed',
    payload: {},
  })
).json?.[0];

check(
  (await rows('crm', `requirement_versions?id=eq.${c3a.id}&select=status`))[0]?.status === 'superseded',
  'O. a newer proposal supersedes the older undecided one',
);
check(
  (await rows('crm', `requirement_versions?conversation_id=eq.${c1Conv}&status=eq.proposed&select=id`))
    .length === 1,
  'O. leaving exactly one proposal open to decide',
);

await patch('crm', `requirement_versions?id=eq.${c3b.id}&status=eq.proposed`, { status: 'accepted' });

const c3c = (
  await insert('crm', 'requirement_versions', {
    organization_id: ORG_A,
    conversation_id: c1Conv,
    version: 52,
    source: 'agent',
    status: 'proposed',
    payload: {},
  })
).json?.[0];
await patch('crm', `requirement_versions?id=eq.${c3c.id}&status=eq.proposed`, { status: 'accepted' });

check(
  (await rows('crm', `requirement_versions?id=eq.${c3b.id}&select=status`))[0]?.status === 'superseded',
  'O. accepting a newer version supersedes the previously accepted one',
);
check(
  (await rows('crm', `requirement_versions?conversation_id=eq.${c1Conv}&status=eq.accepted&select=id`))
    .length === 1,
  'O. exactly one accepted version — the authoritative scope is single',
);

// The index is what holds if the trigger is ever dropped.
const secondAccepted = await insert('crm', 'requirement_versions', {
  organization_id: ORG_A,
  conversation_id: c1Conv,
  version: 53,
  source: 'agent',
  status: 'accepted',
  payload: {},
});
check(secondAccepted.status >= 400, 'O. a second accepted version cannot be inserted at all');

const sameState = await insert('crm', 'requirement_versions', {
  organization_id: ORG_A,
  conversation_id: c1Conv,
  version: 54,
  source: 'agent',
  status: 'proposed',
  payload: {},
  source_message_count: 2,
});
check(sameState.status >= 400, 'N. and a second version for an already-extracted transcript cannot');

// ── 7d. Regression: C8 — version lookups are scoped by organization ────────
//
// A conversation belongs to one organization, so filtering versions by
// conversation *looks* like it implies the organization. It does not: the
// insert policy checks the row's own organization_id, not the organization of
// the conversation it points at, so any tenant with write access can attach a
// row to another tenant's conversation.
//
// Unscoped, one such row at the same transcript length made the runner skip the
// real extraction and hand back the foreign row's id.
section('7d. C8 — a foreign row cannot suppress or steer an extraction');

stubMode = 'ok';
const c8Sender = '919900330022';
await deliverAs(c8Sender, 'wamid.ZZTEST.C8', 'orgA needs a booking system');

const c8Conv = (
  await rows(
    'crm',
    `conversations?organization_id=eq.${ORG_A}&external_ref=eq.${encodeURIComponent(`wa:+${c8Sender}`)}&select=id`,
  )
)[0]?.id;
check(Boolean(c8Conv), 'R. orgA has a conversation with one message');

// ORG_B attaches a version to ORG_A's conversation, at the same transcript
// length the pending extraction will read, and at a high version number.
const foreign = (
  await insert('crm', 'requirement_versions', {
    organization_id: ORG_B,
    conversation_id: c8Conv,
    version: 77,
    source: 'human',
    status: 'proposed',
    payload: { summary: 'ORG B PRIVATE' },
    source_message_count: 1,
  })
).json?.[0];
check(Boolean(foreign), 'R. a second organization attached a row to that conversation');

const c8Before = modelCalls;
const c8Tick = await runJobs();
const c8Mine = await rows(
  'crm',
  `requirement_versions?conversation_id=eq.${c8Conv}&organization_id=eq.${ORG_A}&select=id,version,payload`,
);

check(modelCalls - c8Before === 1, `R. the extraction still ran (${modelCalls - c8Before} model call)`);
check(c8Mine.length === 1, `R. orgA got its own proposal (${c8Mine.length})`);
check(
  c8Tick.body?.versionId !== foreign.id && c8Tick.body?.reason !== 'transcript already extracted',
  'R. and the response did not hand back the other organization’s row',
);
check(
  c8Mine[0]?.version === 1,
  `R. version numbering ignored the foreign row's 77 (got ${c8Mine[0]?.version})`,
);
check(
  c8Mine[0]?.payload?.summary !== 'ORG B PRIVATE',
  'R. orgA’s proposal is its own extraction, not the foreign payload',
);

// The foreign row is left exactly as it was — scoping reads must not delete or
// mutate another tenant's data, only ignore it.
const foreignAfter = (await rows('crm', `requirement_versions?id=eq.${foreign.id}&select=version,status`))[0];
check(
  foreignAfter?.version === 77 && foreignAfter?.status === 'proposed',
  'R. the other organization’s row is untouched, not deleted',
);

// ── positive cases: scoping must not reject legitimate lookups ─────────────
//
// The risk of adding a filter is that it stops matching things it should. C1's
// suppression is exactly such a lookup, so it is re-checked here *within* one
// organization, alongside the foreign row that must stay invisible.
const c8Again = await runJobs();
check(
  c8Again.body?.reason === 'transcript already extracted' ||
    (await rows('crm', `requirement_versions?conversation_id=eq.${c8Conv}&organization_id=eq.${ORG_A}&select=id`))
      .length === 1,
  'S. orgA’s own row still suppresses a second extraction of the same transcript',
);

await deliverAs(c8Sender, 'wamid.ZZTEST.C8.b', 'and a payments page');
await runJobs();
const c8Grown = await rows(
  'crm',
  `requirement_versions?conversation_id=eq.${c8Conv}&organization_id=eq.${ORG_A}&select=version,source_message_count&order=version`,
);
check(
  c8Grown.length === 2,
  `S. a longer transcript still produces a new proposal (${c8Grown.length})`,
);
check(
  c8Grown[1]?.version === 2,
  `S. numbered from this organization's own versions (got ${c8Grown[1]?.version})`,
);
check(
  c8Grown[1]?.source_message_count === 2,
  'S. and recorded against the transcript it actually read',
);

// ── 8. A permanently failing extraction ────────────────────────────────────
section('8. An extraction that keeps failing');

stubMode = 'error';
await deliver('wamid.ZZTEST.P2', 'A second message, which will fail to extract');

const failJob = (await rows('core', `jobs?organization_id=eq.${ORG_A}&status=eq.queued&select=*`))[0];
check(Boolean(failJob), 'K. a fresh extraction job was queued');
const maxAttempts = failJob?.max_attempts ?? 5;

// The retries are spaced now (audit finding D18), so five ticks in a quarter
// of a second no longer spend five attempts — the first one defers the job a
// minute and the other four find nothing due. Proved rather than assumed:
await runJobs();
const afterOne = (await rows('core', `jobs?id=eq.${failJob?.id}&select=attempts,status,run_at`))[0];
check(
  afterOne?.attempts === 1 && afterOne?.status === 'queued',
  'K. one tick spends one attempt and leaves the job queued (D18)',
  `attempts ${afterOne?.attempts}, status ${afterOne?.status}`,
);
await runJobs();
const afterTwo = (await rows('core', `jobs?id=eq.${failJob?.id}&select=attempts`))[0];
check(
  afterTwo?.attempts === 1,
  'K. and an immediate second tick cannot claim it again',
  `attempts ${afterTwo?.attempts}`,
);

// So the remaining attempts are driven by moving the clock rather than by
// calling faster. Pulling run_at into the past is what a later cron tick looks
// like to the claim; nothing else about the path changes.
for (let i = 1; i < maxAttempts; i += 1) {
  await patch('core', `jobs?id=eq.${failJob?.id}`, { run_at: new Date(Date.now() - 1000).toISOString() });
  await runJobs();
  await delay(50);
}

const failedVersions = await rows(
  'crm',
  `requirement_versions?source_job_id=eq.${failJob?.id}&select=*`,
);
check(failedVersions.length === 1, `K. exactly one failed version was written (${failedVersions.length})`);
check(failedVersions[0]?.status === 'failed', 'K. with status failed');
check(failedVersions[0]?.organization_id === ORG_A, 'K. under the right organization');
check(Boolean(failedVersions[0]?.source_job_id), 'K. naming the job that could not finish');

const deadJob = (await rows('core', `jobs?id=eq.${failJob?.id}&select=status,attempts,last_error`))[0];
check(deadJob?.status === 'dead', 'K. and the job is parked dead, not retried forever');
check(Boolean(deadJob?.last_error), 'K. with the reason recorded on the job');

// ── 8b. Regression: C4 — a reaped failed extraction stays failed ───────────
//
// failExtraction writes the `failed` version and then settles the job. If the
// process dies between the two, the job sits `running` until the reaper
// releases it. Before the fix the retry found *a* version for the job and
// reported success, closing the job on a lie: the queue said the work was done
// while the conversation carried a failure nobody was told about.
section('8b. C4 — a failed extraction cannot be reported as succeeded');

stubMode = 'ok';
const c4Sender = '919900550044';
await deliverAs(c4Sender, 'wamid.ZZTEST.C4', 'This extraction will be marked failed');

const c4Job = (
  await rows('core', `jobs?organization_id=eq.${ORG_A}&status=eq.queued&kind=eq.requirement.extract&select=id`)
)[0];
const c4Conv = (
  await rows(
    'crm',
    `conversations?organization_id=eq.${ORG_A}&external_ref=eq.${encodeURIComponent(`wa:+${c4Sender}`)}&select=id`,
  )
)[0]?.id;
check(Boolean(c4Job && c4Conv), 'P. a fresh job and conversation exist');

// Exactly what failExtraction leaves behind when the process dies before it can
// settle the job: the marker written, the job not yet closed.
await insert('crm', 'requirement_versions', {
  organization_id: ORG_A,
  conversation_id: c4Conv,
  version: 90,
  source: 'agent',
  status: 'failed',
  payload: {},
  source_job_id: c4Job.id,
  source_message_count: 1,
});
await patch('core', `jobs?id=eq.${c4Job.id}`, {
  status: 'queued',
  locked_at: null,
  locked_by: null,
  last_error: 'provider unavailable',
});

const c4Before = modelCalls;
const c4Tick = await runJobs();
const c4After = (await rows('core', `jobs?id=eq.${c4Job.id}&select=status,last_error`))[0];

check(c4Tick.body?.reason === 'already failed', 'P. the runner recognises a failed extraction');
check(c4Tick.body?.status === 'failed', 'P. and reports it as failed, not succeeded');
check(c4After?.status === 'dead', `P. the job is parked dead, not succeeded (${c4After?.status})`);
check(c4After?.last_error === 'provider unavailable', 'P. keeping the reason already recorded');
check(modelCalls === c4Before, 'P. and no model call was made to rediscover it');

// ── 8c. Regression: C2 — a lost allocation race is not a failure ───────────
//
// Two runners on one conversation both read the highest version and both
// inserted it. The loser failed *after* paying for a model call, burning one of
// its attempts to arrive — on retry — at a proposal that was already there.
section('8c. C2 — concurrent runners settle without burning an attempt');

const c2Sender = '919900440033';
await deliverAs(c2Sender, 'wamid.ZZTEST.C2.a', 'First of two');
await deliverAs(c2Sender, 'wamid.ZZTEST.C2.b', 'Second of two');

const c2Jobs = await rows(
  'core',
  `jobs?organization_id=eq.${ORG_A}&status=eq.queued&kind=eq.requirement.extract&select=id`,
);
check(c2Jobs.length === 2, `Q. two jobs are queued for one conversation (${c2Jobs.length})`);

// Staggered rather than simultaneous: fired together, both runners pick the
// same candidate and one loses the *claim*, which never reaches the allocation.
// The delay lets the second claim its own job while the first is mid-model-call.
stubDelayMs = 2000;
const c2First = runJobs();
await delay(400);
const c2Second = runJobs();
const [c2a, c2b] = await Promise.all([c2First, c2Second]);
stubDelayMs = 0;

const c2Conv = (
  await rows(
    'crm',
    `conversations?organization_id=eq.${ORG_A}&external_ref=eq.${encodeURIComponent(`wa:+${c2Sender}`)}&select=id`,
  )
)[0]?.id;
const c2Versions = await rows('crm', `requirement_versions?conversation_id=eq.${c2Conv}&select=version`);
const c2Settled = await rows(
  'core',
  `jobs?id=in.(${c2Jobs.map((j) => j.id).join(',')})&select=status,attempts,last_error`,
);

check(c2Versions.length === 1, `Q. exactly one proposal was written (${c2Versions.length})`);
check(
  c2Settled.every((j) => j.status === 'succeeded'),
  `Q. both jobs settled succeeded (${c2Settled.map((j) => j.status).join(', ')})`,
);
check(c2Settled.every((j) => !j.last_error), 'Q. neither recorded a duplicate-key failure');
check(
  c2Settled.every((j) => j.attempts <= 1),
  `Q. no attempt was burned on the race (${c2Settled.map((j) => j.attempts).join(', ')})`,
);
// Required, not merely preferred: an `|| versions.length === 1` fallback here
// would make this assertion unfailable, since that is already checked above.
// The staggered timing puts the loser in the allocation, and the RPC surfaces
// the constraint name, so `raced` is the outcome that proves the fix rather
// than the outcome that happens to coincide with it.
const racedReasons = [c2a.body?.reason, c2b.body?.reason];
check(
  racedReasons.includes('raced'),
  `Q. the runner that lost the race reported it rather than failing (${racedReasons.join(', ')})`,
);

// ── 9. Nothing was sent ────────────────────────────────────────────────────
section('9. Nothing was sent to the client');

const authored = await rows('crm', `conversation_messages?organization_id=eq.${ORG_A}&select=author_type`);
check(authored.length > 0, 'L. the transcript has messages');
check(
  authored.every((m) => m.author_type === 'client'),
  'L. every one of them is client-authored — the agent replied to nothing',
);
note('AI proposes, a human approves; sending remains unbuilt (ARCHITECTURE.md §6.1)');

// ── 10. Cleanup ────────────────────────────────────────────────────────────
section('10. Cleanup');

await dropOrganizations();
check((await countOf('crm', `requirement_versions?organization_id=eq.${ORG_A}&select=id`)) === 0, 'temporary organizations and everything under them removed');
stub.close();

if (failures > 0) {
  console.log(`\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32m✔ All checks passed\x1b[0m\n');
