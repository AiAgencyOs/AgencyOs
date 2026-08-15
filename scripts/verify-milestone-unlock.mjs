#!/usr/bin/env node
/**
 * invoice.paid → job runner → next milestone, verified end to end.
 *
 * This one drives the **real HTTP route**. It writes an `invoice.paid` event
 * exactly as finance/service.ts emits it, then calls POST /api/jobs/run with
 * the cron secret and checks what the running application actually did:
 *
 *   • the dispatcher published the event and enqueued one job
 *   • the job carries the dedupe key `evt:<id>:projects:unlockNextMilestone`
 *   • the intended next milestone moved pending → in_progress
 *   • no other milestone moved
 *   • replaying the same event changes nothing
 *   • a wrong project, wrong milestone, wrong organization, or unpaid invoice
 *     is refused, parked as `dead`, and leaves every milestone untouched
 *   • a final milestone unlocks nothing and creates nothing
 *
 * Requires the app to be running locally and CRON_SECRET set. The secret is
 * read, never printed.
 *
 * ── which database ──────────────────────────────────────────────────────────
 *
 * Runs against .env.verify.local when that file exists, otherwise .env.local.
 * See scripts/verify-target.mjs; the target is announced on the first line of
 * the output.
 *
 * Every assertion below is on **settled database state**, never on the response
 * body of the runner call this script happens to make. That is deliberate. The
 * production Vercel cron calls the same route every sixty seconds, so against a
 * shared database a job may well be claimed and finished by the live runner
 * before our own tick returns — and the old body-reading assertions failed
 * intermittently for exactly that reason. What is being verified (the milestone
 * moved, the job is dead with a recorded reason, exactly one job exists for the
 * event) is durable and true no matter which invocation did the work.
 *
 * Fixtures are created under a marker name and removed afterwards. One thing
 * cannot be removed: audit.audit_log is append-only by design — a trigger
 * refuses DELETE for every role including service_role — so the two history
 * rows the successful paths write are reported rather than cleaned. That is a
 * property of the schema, not of this script.
 *
 *   npm run dev            # in another terminal
 *   node scripts/verify-milestone-unlock.mjs
 */

import { setTimeout as delay } from 'node:timers/promises';

import { announceTarget, assertAppTarget, resolveTarget } from './verify-target.mjs';

const MARKER = 'ZZTEST milestone-unlock';
const HANDLER = 'projects:unlockNextMilestone';

/**
 * The `core.jobs.kind` the unlock handler runs under.
 *
 * Spelled out rather than imported from src/lib/events/catalog.ts, matching how
 * HANDLER above is spelled out: this script drives the running application over
 * HTTP and PostgREST, and importing the app's own constants would let a rename
 * pass here by changing both sides at once.
 */
const HANDLER_KIND = 'milestone.unlock';

/** Jobs §6 plants directly, so cleanup can remove them by id. */
const plantedJobIds = [];

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const target = resolveTarget(fail);
const URL_BASE = target.url;
const SECRET = target.serviceKey;
const CRON_SECRET = target.cronSecret;
const APP = target.app;

/**
 * How long to wait for a job to reach a terminal state.
 *
 * Generous on purpose. When this runs against an isolated database the
 * runner call below does the work and the first poll already sees it, so the
 * budget is never spent. When it runs against the shared production database
 * the live cron may have claimed the job first, and its tick is on a
 * sixty-second cadence — so the budget has to outlast one of those.
 */
const SETTLE_TIMEOUT_MS = 90_000;

/** Statuses a job never leaves on its own. */
const TERMINAL = new Set(['succeeded', 'failed', 'dead', 'cancelled']);

// ── REST helpers ───────────────────────────────────────────────────────────

/**
 * A REST call, retried on transport failure.
 *
 * Only a thrown fetch — DNS, a dropped socket — is retried. An HTTP error
 * status is an answer from the database and is returned as-is: retrying a 400
 * would turn a real refusal into a hang, and this script exists to observe
 * refusals.
 */
async function request(method, schema, path, options = {}, attempt = 0) {
  try {
    return await requestOnce(method, schema, path, options);
  } catch (error) {
    if (attempt >= 3) throw error;
    await delay(250 * (attempt + 1));
    return request(method, schema, path, options, attempt + 1);
  }
}

async function requestOnce(method, schema, path, { body, prefer } = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
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
    /* non-JSON body reported through text */
  }
  return { status: res.status, ok: res.ok, json, text };
}

const select = (schema, path) => request('GET', schema, path);
const insert = (schema, table, body) =>
  request('POST', schema, table, { body, prefer: 'return=representation' });
const patch = (schema, path, body) =>
  request('PATCH', schema, path, { body, prefer: 'return=representation' });
const remove = (schema, path) => request('DELETE', schema, path);

/** One tick of the real runner. */
async function runJobs() {
  const res = await fetch(`${APP}/api/jobs/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
    cache: 'no-store',
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ── reporting ──────────────────────────────────────────────────────────────

let failures = 0;
const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  failures++;
};
const check = (condition, message, detail) =>
  condition ? pass(message) : bad(`${message}${detail ? ` — ${detail}` : ''}`);

// ── fixture ────────────────────────────────────────────────────────────────

const fixture = {
  organizationId: null,
  clientAccountId: null,
  projectId: null,
  milestones: [],
  otherOrganizationId: null,
  /**
   * Every outbox event this run writes.
   *
   * Tracked explicitly rather than rediscovered at the end: the fixture's
   * invoices are replaced part-way through, so an event cannot be found again
   * by walking back from the invoice it names.
   */
  eventIds: [],
};

let invoiceSeq = 0;
const invoiceNumber = () => `${MARKER}-${Date.now()}-${(invoiceSeq += 1)}`;

/** Exactly the payload finance/service.ts emits when an invoice is paid. */
function invoicePaidEvent({ organizationId, invoiceId, projectId, milestoneId, unlockedMilestoneId }) {
  return {
    organization_id: organizationId,
    type: 'invoice.paid',
    subject_type: 'invoice',
    subject_id: invoiceId,
    payload: {
      number: `${MARKER}-event`,
      clientAccountId: fixture.clientAccountId,
      projectId,
      milestoneId,
      unlockedMilestoneId,
      paidMinor: 1000,
      currency: 'INR',
    },
  };
}

/** Writes an outbox event and remembers it, so cleanup can find it again. */
async function emitEvent(body) {
  const result = await insert('core', 'outbox_events', body);
  const id = result.json?.[0]?.id ?? null;
  if (id !== null) fixture.eventIds.push(id);
  return { result, id };
}

/** Creates a paid invoice for a milestone, the way the app leaves one. */
async function paidInvoiceFor(milestone, { paid = true } = {}) {
  const now = new Date().toISOString();
  const result = await insert('finance', 'invoices', {
    organization_id: fixture.organizationId,
    client_account_id: fixture.clientAccountId,
    project_id: fixture.projectId,
    milestone_id: milestone.id,
    number: invoiceNumber(),
    status: paid ? 'paid' : 'issued',
    currency: 'INR',
    subtotal_minor: milestone.amount_minor,
    tax_minor: 0,
    total_minor: milestone.amount_minor,
    paid_minor: paid ? milestone.amount_minor : 0,
    issued_at: now,
    ...(paid ? { paid_at: now } : {}),
  });
  if (!result.ok) fail(`could not create fixture invoice: ${result.text}`);
  return result.json[0];
}

async function milestoneStatuses() {
  const result = await select(
    'projects',
    `milestones?project_id=eq.${fixture.projectId}&select=id,position,status&order=position`,
  );
  return (result.json ?? []).map((m) => m.status);
}

async function jobFor(eventId) {
  const result = await select(
    'core',
    `jobs?dedupe_key=eq.${encodeURIComponent(`evt:${eventId}:${HANDLER}`)}&select=id,kind,status,last_error,attempts`,
  );
  return result.json?.[0] ?? null;
}

/**
 * Waits until the job for an event has finished, however it finished.
 *
 * This is the whole answer to the race. The old assertions read the response
 * body of *our* runner call and so only held while nothing else drained the
 * queue; the live cron broke that. What is actually being verified — that the
 * handler refused, or unlocked, or found nothing to unlock — is durable, and
 * lands in `core.jobs` regardless of which invocation did the work. Asserting
 * on the settled row is both race-proof and a stronger claim: it survives the
 * work being done by the real production runner.
 *
 * Returns the job as last seen, so a timeout reports the state it was stuck in
 * rather than a bare failure.
 */
async function settleJob(eventId, { timeoutMs = SETTLE_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await jobFor(eventId);
    if (job && TERMINAL.has(job.status)) return job;
    if (Date.now() >= deadline) return job;
    await delay(500);
  }
}

/** Waits until the dispatcher has published an event. */
async function settlePublished(eventId, { timeoutMs = SETTLE_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await select('core', `outbox_events?id=eq.${eventId}&select=published_at`);
    const publishedAt = result.json?.[0]?.published_at ?? null;
    if (publishedAt) return publishedAt;
    if (Date.now() >= deadline) return null;
    await delay(500);
  }
}

/** Unlocks recorded against this fixture's milestones, as the audit trail sees them. */
async function unlockedAuditCount() {
  const ids = fixture.milestones.map((m) => m.id).join(',');
  const result = await select(
    'audit',
    `audit_log?action=eq.milestone.unlocked&subject_id=in.(${ids})&select=id`,
  );
  return (result.json ?? []).length;
}

/** How many jobs exist for an event — one, always, however often it is redelivered. */
async function jobCountFor(eventId) {
  const result = await select(
    'core',
    `jobs?dedupe_key=eq.${encodeURIComponent(`evt:${eventId}:${HANDLER}`)}&select=id`,
  );
  return (result.json ?? []).length;
}

async function cleanup() {
  // Jobs first: each is addressed by the dedupe key derived from its event, so
  // this holds regardless of which invoices still exist.
  for (const eventId of fixture.eventIds) {
    await remove('core', `jobs?dedupe_key=eq.${encodeURIComponent(`evt:${eventId}:${HANDLER}`)}`);
    await remove('core', `outbox_events?id=eq.${eventId}`);
  }

  if (fixture.projectId) {
    const invoices = await select('finance', `invoices?project_id=eq.${fixture.projectId}&select=id`);
    for (const invoice of invoices.json ?? []) {
      await remove('finance', `payments?invoice_id=eq.${invoice.id}`);
    }
    await remove('finance', `invoices?project_id=eq.${fixture.projectId}`);
    await remove('projects', `milestones?project_id=eq.${fixture.projectId}`);
    await remove('projects', `projects?id=eq.${fixture.projectId}`);
  }

  if (fixture.otherOrganizationId) {
    await remove('core', `jobs?organization_id=eq.${fixture.otherOrganizationId}`);
    await remove('core', `outbox_events?organization_id=eq.${fixture.otherOrganizationId}`);
    await remove('core', `organizations?id=eq.${fixture.otherOrganizationId}`);
  }

  // §6 plants milestone.unlock rows directly rather than through the outbox,
  // so they carry no event id and no marker. Leaving one behind is not inert
  // the way the reaper script's probe kind is: `milestone.unlock` is a live
  // kind, so the production runner would keep claiming it every minute until
  // its attempts ran out.
  for (const jobId of plantedJobIds) {
    await remove('core', `jobs?id=eq.${jobId}`);
  }

  // Belt and braces: anything tagged by this script, whichever run wrote it.
  const tag = encodeURIComponent(`${MARKER}-event`);
  await remove('core', `jobs?payload->event->>number=eq.${tag}`);
  await remove('core', `outbox_events?payload->>number=eq.${tag}`);
  await remove('core', `jobs?dedupe_key=like.zztest-d18-*`);
}

// ── run ────────────────────────────────────────────────────────────────────

console.log('\n\x1b[1mAgencyOS — invoice.paid → runner → milestone unlock\x1b[0m');

/** Removes anything a previous interrupted run left behind. */
async function sweepLeftovers() {
  const projects = await select(
    'projects',
    `projects?name=like.${encodeURIComponent(`${MARKER}%`)}&select=id`,
  );
  for (const project of projects.json ?? []) {
    const invoices = await select('finance', `invoices?project_id=eq.${project.id}&select=id`);
    for (const invoice of invoices.json ?? []) {
      await remove('finance', `payments?invoice_id=eq.${invoice.id}`);
      await remove('core', `outbox_events?subject_id=eq.${invoice.id}`);
    }
    await remove('finance', `invoices?project_id=eq.${project.id}`);
    await remove('projects', `milestones?project_id=eq.${project.id}`);
    await remove('projects', `projects?id=eq.${project.id}`);
  }

  const orgs = await select(
    'core',
    `organizations?name=like.${encodeURIComponent(`${MARKER}%`)}&select=id`,
  );
  for (const org of orgs.json ?? []) {
    await remove('core', `jobs?organization_id=eq.${org.id}`);
    await remove('core', `outbox_events?organization_id=eq.${org.id}`);
    await remove('core', `organizations?id=eq.${org.id}`);
  }

  // Events (and the jobs they produced) are also tagged, so an interrupted run
  // that never reached its project cleanup is still fully recoverable.
  const tag = encodeURIComponent(`${MARKER}-event`);
  await remove('core', `jobs?payload->event->>number=eq.${tag}`);
  await remove('core', `outbox_events?payload->>number=eq.${tag}`);
}

try {
  // ── 0. preflight ─────────────────────────────────────────────────────────
  console.log('\n0. Preflight');
  {
    announceTarget(target);
    // This script drives the running application, so it must be talking to the
    // same database (gap G-083). Checked before any fixture is planted.
    await assertAppTarget(target, fail);
    const health = await fetch(`${APP}/api/health`, { cache: 'no-store' }).catch(() => null);
    if (!health || !health.ok) {
      fail(`the app is not responding at ${APP}. Start it with "npm run dev" and re-run.`);
    }
    pass(`app reachable at ${APP}`);

    const unauthorized = await fetch(`${APP}/api/jobs/run`, { method: 'POST' });
    check(unauthorized.status === 401, 'the runner refuses an unauthenticated call');
  }

  // ── 1. fixture ───────────────────────────────────────────────────────────
  console.log('\n1. Fixture (temporary data only)');
  {
    await sweepLeftovers();
    const orgs = await select('core', 'organizations?select=id&limit=1');
    const accounts = await select('core', 'client_accounts?select=id&limit=1');
    fixture.organizationId = orgs.json?.[0]?.id ?? null;
    fixture.clientAccountId = accounts.json?.[0]?.id ?? null;
    if (!fixture.organizationId || !fixture.clientAccountId) fail('seed data missing.');

    const project = await insert('projects', 'projects', {
      organization_id: fixture.organizationId,
      client_account_id: fixture.clientAccountId,
      name: `${MARKER} project`,
      status: 'active',
      currency: 'INR',
      budget_minor: 300_000,
    });
    fixture.projectId = project.json?.[0]?.id ?? null;
    if (!fixture.projectId) fail(`could not create the project: ${project.text}`);

    // 40/30/30 — an ordinary custom plan, nothing special about the split.
    const milestones = await insert(
      'projects',
      'milestones',
      [
        { name: 'Advance', percent: 40, amount: 120_000 },
        { name: 'Build', percent: 30, amount: 90_000 },
        { name: 'Launch', percent: 30, amount: 90_000 },
      ].map((m, index) => ({
        organization_id: fixture.organizationId,
        project_id: fixture.projectId,
        name: `${MARKER} ${m.name}`,
        position: index,
        status: 'pending',
        payment_percent: m.percent,
        amount_minor: m.amount,
        currency: 'INR',
      })),
    );
    fixture.milestones = (milestones.json ?? []).sort((a, b) => a.position - b.position);

    check(fixture.milestones.length === 3, 'project with a 40/30/30 plan created', milestones.text);
    check(
      (await milestoneStatuses()).every((s) => s === 'pending'),
      'every milestone starts pending',
    );

    const other = await insert('core', 'organizations', {
      name: `${MARKER} other org`,
      slug: `zztest-unlock-${Date.now()}`,
      currency: 'INR',
    });
    fixture.otherOrganizationId = other.json?.[0]?.id ?? null;
    check(Boolean(fixture.otherOrganizationId), 'a second organization exists for isolation tests');
  }

  const [first, second, third] = fixture.milestones;

  // ── 2. the happy path ────────────────────────────────────────────────────
  console.log('\n2. invoice.paid → runner → unlock (B, C)');
  let firstEventId = null;
  {
    const invoice = await paidInvoiceFor(first);
    const event = await emitEvent(
      invoicePaidEvent({
        organizationId: fixture.organizationId,
        invoiceId: invoice.id,
        projectId: fixture.projectId,
        milestoneId: first.id,
        unlockedMilestoneId: second.id,
      }),
    );
    firstEventId = event.id;
    check(Boolean(firstEventId), 'A. invoice.paid event recorded in the outbox', event.result.text);

    const run = await runJobs();
    check(run.status === 200, `the runner accepted the cron call (${run.status})`);

    const job = await settleJob(firstEventId);
    check(
      (await jobCountFor(firstEventId)) === 1,
      'B. the dispatcher enqueued exactly one job for the event',
    );
    check(job?.kind === 'milestone.unlock', 'the job was queued under the milestone.unlock kind');
    check(job?.status === 'succeeded', `the job succeeded`, `status ${job?.status}`);

    check(Boolean(await settlePublished(firstEventId)), 'the event is marked published');

    const statuses = await milestoneStatuses();
    check(
      statuses[1] === 'in_progress',
      'C. the next milestone is unlocked (pending → in_progress)',
      `got ${statuses[1]}`,
    );
    check(statuses[0] === 'pending', 'the paid milestone itself is untouched', `got ${statuses[0]}`);
    check(
      statuses[2] === 'pending',
      '7. the milestone after next is NOT unlocked — nothing is skipped',
      `got ${statuses[2]}`,
    );
  }

  // ── 3. replay ────────────────────────────────────────────────────────────
  console.log('\n3. Redelivery and retry (H, I)');
  {
    // Redelivery: unpublish the event so the dispatcher sees it again.
    const jobIdBefore = (await jobFor(firstEventId))?.id;
    await patch('core', `outbox_events?id=eq.${firstEventId}`, { published_at: null });
    await runJobs();
    check(
      Boolean(await settlePublished(firstEventId)),
      'H. the redelivered event is published again',
    );
    check(
      (await jobCountFor(firstEventId)) === 1,
      'H. re-dispatching the same event enqueues nothing (dedupe key held)',
    );
    // Distinct from the count: a delete-and-reinsert would also leave exactly
    // one row. The dedupe key's job is that the original row is untouched.
    const jobIdAfter = (await jobFor(firstEventId))?.id;
    check(
      jobIdAfter !== undefined && jobIdAfter === jobIdBefore,
      'H. it is the same job row — no second insert was attempted behind the key',
      `${jobIdBefore} → ${jobIdAfter}`,
    );

    // Retry: force the same job back onto the queue and let it run again.
    await patch('core', `jobs?dedupe_key=eq.${encodeURIComponent(`evt:${firstEventId}:${HANDLER}`)}`, {
      status: 'queued',
      locked_at: null,
      locked_by: null,
    });
    await runJobs();
    const retriedJob = await settleJob(firstEventId);
    check(
      retriedJob?.status === 'succeeded',
      'I. re-running the job succeeds again rather than failing or unlocking twice',
      `status ${retriedJob?.status}`,
    );

    const statuses = await milestoneStatuses();
    check(
      statuses[1] === 'in_progress' && statuses[2] === 'pending',
      'I. the retry changed nothing',
      statuses.join(','),
    );

    const audits = await select(
      'audit',
      `audit_log?action=eq.milestone.unlocked&subject_id=eq.${second.id}&select=id`,
    );
    check(
      (audits.json ?? []).length === 1,
      'I. exactly one unlock is recorded in the audit trail',
      `${(audits.json ?? []).length} rows`,
    );
  }

  // ── 4. events that must be refused ───────────────────────────────────────
  console.log('\n4. Refusals (D, E, F, G)');
  {
    const cases = [
      {
        label: 'D. an event naming a different project',
        build: async () => {
          const invoice = await paidInvoiceFor(second);
          return invoicePaidEvent({
            organizationId: fixture.organizationId,
            invoiceId: invoice.id,
            projectId: fixture.otherOrganizationId, // a uuid that is not this project
            milestoneId: second.id,
            unlockedMilestoneId: third.id,
          });
        },
      },
      {
        label: 'E. an event naming a different milestone',
        build: async () => {
          const invoice = await paidInvoiceFor(third);
          return invoicePaidEvent({
            organizationId: fixture.organizationId,
            invoiceId: invoice.id,
            projectId: fixture.projectId,
            milestoneId: first.id, // the invoice is for `third`
            unlockedMilestoneId: third.id,
          });
        },
      },
      {
        label: 'F. an event queued under another organization',
        build: async () => {
          const invoices = await select(
            'finance',
            `invoices?project_id=eq.${fixture.projectId}&select=id&limit=1`,
          );
          return {
            ...invoicePaidEvent({
              organizationId: fixture.otherOrganizationId,
              invoiceId: invoices.json[0].id,
              projectId: fixture.projectId,
              milestoneId: first.id,
              unlockedMilestoneId: third.id,
            }),
            organization_id: fixture.otherOrganizationId,
          };
        },
      },
    ];

    for (const testCase of cases) {
      const before = await milestoneStatuses();
      const event = await emitEvent(await testCase.build());
      const eventId = event.id;
      if (!eventId) {
        bad(`${testCase.label} — could not write the event: ${event.result.text}`);
        continue;
      }

      await runJobs();
      const job = await settleJob(eventId);
      const after = await milestoneStatuses();

      check(
        job?.status === 'dead',
        `${testCase.label} is refused and parked as dead`,
        `job ${job?.status}`,
      );
      check(
        job?.last_error && job.last_error.length > 0,
        `${testCase.label} records why it was refused`,
        'last_error empty',
      );
      check(
        before.join(',') === after.join(','),
        `${testCase.label} left every milestone untouched`,
        `${before.join(',')} → ${after.join(',')}`,
      );
    }

    // G. an invoice that is not actually paid.
    {
      await remove('finance', `invoices?milestone_id=eq.${third.id}`);
      const unpaid = await paidInvoiceFor(third, { paid: false });
      const before = await milestoneStatuses();

      const event = await emitEvent(
        invoicePaidEvent({
          organizationId: fixture.organizationId,
          invoiceId: unpaid.id,
          projectId: fixture.projectId,
          milestoneId: third.id,
          unlockedMilestoneId: third.id,
        }),
      );
      await runJobs();
      const job = await settleJob(event.id);
      const after = await milestoneStatuses();

      check(
        job?.status === 'dead' && /not paid/.test(job?.last_error ?? ''),
        'G. an issued-but-unpaid invoice unlocks nothing',
        `${job?.status}: ${job?.last_error}`,
      );
      check(before.join(',') === after.join(','), 'G. milestones untouched');
    }
  }

  // ── 5. the final milestone ───────────────────────────────────────────────
  console.log('\n5. The final milestone (J, 12)');
  {
    // Bring the plan to its end: every milestone billed and paid.
    await remove('finance', `invoices?project_id=eq.${fixture.projectId}`);
    const invoices = [];
    for (const milestone of fixture.milestones) invoices.push(await paidInvoiceFor(milestone));

    const projectBefore = await select('projects', `projects?id=eq.${fixture.projectId}&select=status`);

    const event = await emitEvent(
      invoicePaidEvent({
        organizationId: fixture.organizationId,
        invoiceId: invoices[2].id,
        projectId: fixture.projectId,
        milestoneId: third.id,
        unlockedMilestoneId: null,
      }),
    );
    const eventId = event.id;

    const before = await milestoneStatuses();
    const unlockedBefore = await unlockedAuditCount();
    await runJobs();
    const job = await settleJob(eventId);
    const after = await milestoneStatuses();
    const unlockedAfter = await unlockedAuditCount();
    const projectAfter = await select('projects', `projects?id=eq.${fixture.projectId}&select=status`);

    check(
      unlockedAfter === unlockedBefore,
      'J. a final payment unlocks nothing — no new unlock is recorded',
      `${unlockedBefore} → ${unlockedAfter} audit rows`,
    );
    check(job?.status === 'succeeded', 'J. and is a success, not a failure', `status ${job?.status}`);
    check(before.join(',') === after.join(','), 'J. no milestone was created or changed');

    const count = await select(
      'projects',
      `milestones?project_id=eq.${fixture.projectId}&select=id`,
    );
    check((count.json ?? []).length === 3, 'J. still exactly three milestones — none invented');

    check(
      projectBefore.json?.[0]?.status === projectAfter.json?.[0]?.status,
      '12. the project status is left unchanged, and the gap is reported instead',
      `${projectBefore.json?.[0]?.status} → ${projectAfter.json?.[0]?.status}`,
    );

    const skipped = await select(
      'audit',
      `audit_log?action=eq.milestone.unlock_skipped&select=id,after`,
    );
    check(
      (skipped.json ?? []).length >= 1,
      '12. the skip is recorded in the audit trail with its reason',
    );
  }
} catch (error) {
  bad(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  // ── 6. D18 — a retryable failure does not spend the whole budget at once ──
  //
  // The runner drains up to ten unlock jobs per invocation and claims the
  // oldest queued row. settleUnlockJob put a retryable failure back as
  // `queued` and left `run_at` alone — so the row was still the oldest, and
  // the very next turn of the loop claimed it again. Five turns, five
  // attempts, `dead`, inside one tick and a few hundred milliseconds.
  //
  // That is the opposite of what D5 and D15 built. Both went to trouble to
  // make a failed *read* retryable rather than permanent, precisely so a
  // transient blip would not strand a milestone the client had already paid
  // for. There was no "later": every attempt happened inside the same blip.
  //
  // The fault injector is the subject id. handleInvoicePaid passes
  // `envelope.subjectId` straight to loadInvoice without validating it, so a
  // non-uuid makes the invoice read fail with 22P02 — and a failed read is
  // exactly the retryable outcome those two findings established. It cannot
  // arise in production: `core.outbox_events.subject_id` is a uuid column, so
  // a dispatched event can never carry one. The job below is therefore
  // hand-planted rather than dispatched, and what it exercises is the real
  // retryable path rather than a defect of its own.
  console.log('\n6. Retry backoff (D18)');
  {
    const plant = async (suffix, payload) => {
      const key = `zztest-d18-${suffix}-${Date.now()}`;
      const created = await insert('core', 'jobs', {
        organization_id: fixture.organizationId,
        kind: HANDLER_KIND,
        status: 'queued',
        attempts: 0,
        max_attempts: 5,
        dedupe_key: key,
        payload,
      });
      const row = created.json?.[0] ?? null;
      if (row) plantedJobIds.push(row.id);
      return row;
    };

    const reread = async (id) => {
      const res = await select('core', `jobs?id=eq.${id}&select=status,attempts,run_at,last_error`);
      return res.json?.[0] ?? null;
    };

    const transient = await plant('transient', {
      eventId: 0,
      eventType: 'invoice.paid',
      subjectType: 'invoice',
      subjectId: 'zztest-not-a-uuid',
      event: { projectId: null, milestoneId: null, unlockedMilestoneId: null },
    });

    check(Boolean(transient), 'a job is planted for the retryable case', JSON.stringify(transient));

    if (transient) {
      const before = Date.parse(transient.run_at);
      await runJobs();
      const after = await reread(transient.id);

      // The control. If the injector ever stops producing a *retryable*
      // failure — say the subject id starts being validated — the payload
      // becomes a permanent refusal, and every assertion below would be
      // asserting the wrong thing while still looking plausible.
      check(
        /could not be read/.test(after?.last_error ?? ''),
        'control: the failure really is the retryable read failure, not some other refusal',
        `last_error: ${after?.last_error}`,
      );

      check(
        after?.attempts === 1,
        'one tick spends one attempt',
        `attempts ${after?.attempts} — five means the loop re-claimed the same row`,
      );
      check(
        after?.status === 'queued',
        'and the job is still queued rather than parked dead',
        `status ${after?.status}`,
      );
      check(
        Date.parse(after?.run_at ?? 0) > before,
        'the retry is scheduled into the future, which is what stops the re-claim',
        `run_at ${transient.run_at} → ${after?.run_at}`,
      );
      check(
        Date.parse(after?.run_at ?? 0) - before >= 60_000,
        'by at least the cron cadence, so the next attempt is a different tick',
        `${Math.round((Date.parse(after?.run_at ?? 0) - before) / 1000)}s`,
      );

      // The claim filters run_at <= now, so an immediate second tick must not
      // touch it. This is the half that actually proves the budget survives.
      await runJobs();
      const again = await reread(transient.id);
      check(
        again?.attempts === 1,
        'a second tick in the same moment leaves the attempt count alone',
        `attempts ${again?.attempts}`,
      );
    }

    // The counterpart: backoff must not be applied to something that will
    // never succeed. A malformed event is refused permanently, and a
    // permanent refusal is parked on its first attempt exactly as before.
    const permanent = await plant('permanent', {
      eventId: 0,
      eventType: 'invoice.paid',
      subjectType: 'invoice',
      subjectId: null,
      event: { projectId: 'not-a-uuid-either', milestoneId: null, unlockedMilestoneId: null },
    });

    if (permanent) {
      const before = permanent.run_at;
      await runJobs();
      const after = await reread(permanent.id);
      check(
        after?.status === 'dead' && after?.attempts === 1,
        'a permanent refusal is still parked on its first attempt, not retried four more times',
        `status ${after?.status}, attempts ${after?.attempts}`,
      );
      check(
        after?.run_at === before,
        'and nothing was scheduled for a job that is never coming back',
        `run_at ${before} → ${after?.run_at}`,
      );
    }
  }

  console.log('\n7. Cleanup');
  try {
    await cleanup();

    const leftProjects = await select(
      'projects',
      `projects?name=like.${encodeURIComponent(`${MARKER}%`)}&select=id`,
    );
    // Selected with their identity, not only counted: this sweep failed twice
    // in CI with three rows nobody could name, because the check printed a
    // count and the app-log trap dump has no usable timestamps. A failing
    // global sweep must say what it found or it costs a CI cycle per guess.
    const leftJobs = await select('core', 'jobs?select=id,kind,status,dedupe_key,organization_id,last_error');
    const leftEvents = await select('core', 'outbox_events?select=id');
    const leftOrgs = await select(
      'core',
      `organizations?name=like.${encodeURIComponent(`${MARKER}%`)}&select=id`,
    );

    check((leftProjects.json ?? []).length === 0, 'test projects and milestones removed');
    check((leftJobs.json ?? []).length === 0, 'test jobs removed');
    for (const row of leftJobs.json ?? []) {
      console.log(`    · leftover job ${row.id}: kind=${row.kind} status=${row.status} org=${row.organization_id} dedupe=${row.dedupe_key ?? '(none)'} err=${(row.last_error ?? '').slice(0, 80)}`);
    }
    check((leftEvents.json ?? []).length === 0, 'test outbox events removed');
    check((leftOrgs.json ?? []).length === 0, 'the temporary organization removed');

    // audit.audit_log is append-only: a BEFORE DELETE trigger refuses every
    // role, service_role included. Report what stays rather than pretend.
    const audits = await select(
      'audit',
      'audit_log?action=in.(milestone.unlocked,milestone.unlock_skipped)&select=id,action,subject_id',
    );
    const rows = audits.json ?? [];
    if (rows.length > 0) {
      console.log(
        `  \x1b[33m•\x1b[0m ${rows.length} audit row(s) remain — audit.audit_log is append-only by design:`,
      );
      for (const row of rows) console.log(`      #${row.id} ${row.action} → ${row.subject_id}`);
    }
  } catch (error) {
    bad(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures > 0) {
  console.error(`\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32m✔ All checks passed\x1b[0m\n');
