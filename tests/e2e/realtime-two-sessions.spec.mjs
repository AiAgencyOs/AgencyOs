/**
 * Realtime, two sessions — the five scenarios of AGENCYOS_ADMIN_TEST_MATRIX §5.
 *
 * Two real browser contexts, signed in through the app's own callback
 * (`/auth/callback` → `verifyOtp` → `bootstrap_first_owner`), one as the
 * owner and one as an ops_admin. Session B acts through the real pages and
 * doors; session A watches without reloading. Every screen assertion is tied
 * to a committed row read back through PostgREST with the service-role key,
 * so a passing scenario means the database changed AND the other session saw
 * it arrive.
 *
 *   1. new lead from B → A's list and the dashboard KPI update; the pill says Live
 *   2. approval raised, then decided in B → A shows it pending, then gone after the decision commits
 *   3. payment claim submitted in B → A shows it; verified in B → A shows it verified
 *   4. a job fails (dead) → A shows it; requeued in B → A clears it
 *   5. realtime container stopped → A shows Reconnecting, then Degraded; started → Live, and the list catches up
 *
 * Environment:
 *   APP_URL                     the running app (default http://localhost:3000)
 *   NEXT_PUBLIC_SUPABASE_URL    the Supabase API gateway (PostgREST + GoTrue + Realtime)
 *   SUPABASE_SERVICE_ROLE_KEY   for read-backs and fixtures, never for the browser
 *   REALTIME_CONTAINER          docker container to stop/start for scenario 5; unset → scenario 5 is skipped and says so
 *   PLAYWRIGHT_DIR              a directory whose node_modules holds playwright-core, when it is not in the repo's
 *   CHROME                      a Chromium executable; unset → the installed Google Chrome channel
 *   OUT_DIR                     screenshots and summary.json (default tests/e2e/out)
 *
 * Exit code is non-zero on any failure. One JSON line per scenario is printed,
 * and the whole summary is written to OUT_DIR/summary.json.
 */

/* eslint-disable no-console -- the JSON lines on stdout are this script's interface, as for scripts/** */
/* global document, setTimeout -- `document` only inside page.evaluate / page.waitForFunction bodies, which run in the browser */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── playwright-core ────────────────────────────────────────────────────────
//
// Not a project dependency (scripts/local-qa/README.md says why). Resolved from
// the repository first (`npm i --no-save playwright-core` in CI), then from
// PLAYWRIGHT_DIR, the way the QA scripts do it.
function loadPlaywright() {
  const candidates = [
    createRequire(import.meta.url),
    ...(process.env.PLAYWRIGHT_DIR ? [createRequire(path.join(process.env.PLAYWRIGHT_DIR, 'package.json'))] : []),
  ];
  for (const req of candidates) {
    try {
      return req('playwright-core');
    } catch {
      /* next */
    }
  }
  console.error('playwright-core is not installed. `npm i --no-save playwright-core`, or set PLAYWRIGHT_DIR (see scripts/local-qa/README.md).');
  process.exit(2);
}
const { chromium } = loadPlaywright();

// ── configuration ──────────────────────────────────────────────────────────

const APP = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const REALTIME_CONTAINER = process.env.REALTIME_CONTAINER ?? '';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.OUT_DIR ?? path.join(HERE, 'out');
const RUN = randomUUID().slice(0, 8);
const MARKER = `e2e-rt-${RUN}`;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (the read-backs go through PostgREST).');
  process.exit(2);
}
mkdirSync(OUT_DIR, { recursive: true });

// Push is expected within a few seconds; the join timeout in use-live is 10 s
// and a degraded channel polls every 30 s, so anything past PUSH_MS is not push.
const PUSH_MS = 25_000;
const PILL_MS = 60_000;

// ── PostgREST, as the service role ─────────────────────────────────────────

function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function rest(method, schema, resource, body, extraHeaders = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${resource}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Accept-Profile': schema,
      'Content-Profile': schema,
      Prefer: method === 'POST' || method === 'PATCH' ? 'return=representation' : 'return=minimal',
      ...extraHeaders,
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: parse(text), text };
}
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json) ?? null;

async function gotrue(method, resource, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${resource}`, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { ok: res.ok, status: res.status, json: parse(await res.text()) };
}

// ── the summary ────────────────────────────────────────────────────────────

const summary = { run: RUN, app: APP, startedAt: new Date().toISOString(), scenarios: [] };
let failed = false;

function report(entry) {
  summary.scenarios.push(entry);
  if (entry.status === 'failed') failed = true;
  console.log(JSON.stringify(entry));
}

class Check {
  constructor(name) {
    this.name = name;
    this.checks = [];
    this.dbReadBack = {};
    this.notes = [];
  }
  ok(label, detail) {
    this.checks.push({ label, ok: true, ...(detail ? { detail } : {}) });
  }
  fail(label, detail) {
    this.checks.push({ label, ok: false, detail: String(detail ?? '') });
    throw new Error(`${this.name}: ${label} — ${detail ?? ''}`);
  }
  assert(cond, label, detail) {
    if (cond) this.ok(label);
    else this.fail(label, detail);
  }
}

async function scenario(name, fn) {
  const c = new Check(name);
  const t0 = Date.now();
  try {
    await fn(c);
    report({ scenario: name, status: 'passed', ms: Date.now() - t0, checks: c.checks, dbReadBack: c.dbReadBack, notes: c.notes });
  } catch (error) {
    report({
      scenario: name,
      status: 'failed',
      ms: Date.now() - t0,
      error: error?.message ?? String(error),
      checks: c.checks,
      dbReadBack: c.dbReadBack,
      notes: c.notes,
    });
  }
}

// ── page helpers ───────────────────────────────────────────────────────────

const shots = [];
async function shot(page, label) {
  const file = path.join(OUT_DIR, `${String(shots.length + 1).padStart(2, '0')}-${label}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  shots.push(file);
  return file;
}

/** The LiveRefresh pill: a role=status element whose whole text is the label. */
async function waitForPill(page, label, timeout = PILL_MS) {
  await page.waitForFunction(
    (want) => [...document.querySelectorAll('[role="status"]')].some((e) => (e.textContent ?? '').trim() === want),
    label,
    { timeout },
  );
}
async function currentPill(page) {
  return page.evaluate(() => {
    const labels = ['Live', 'Connecting', 'Reconnecting', 'Degraded', 'Polling'];
    for (const e of document.querySelectorAll('[role="status"]')) {
      const t = (e.textContent ?? '').trim();
      if (labels.includes(t)) return t;
    }
    return null;
  });
}
async function waitForText(page, text, timeout = PUSH_MS) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });
}
/** The value under a `Stat` label (src/ui/primitives/stat.tsx: label <p>, value <p> in the next row). */
async function statValue(page, label) {
  return page.evaluate((want) => {
    // The tile's label is a <p>; its figure is the `tabular` <p> in the same block. Labels are matched case-insensitively
    // (the panel's headings are Title Case) and the older layout, where the figure sat in the next sibling, still reads.
    const p = [...document.querySelectorAll('p')].find((e) => (e.textContent ?? '').trim().toLowerCase() === want.toLowerCase());
    const value = p?.parentElement?.querySelector('p.tabular') ?? p?.parentElement?.nextElementSibling?.querySelector('p');
    return value ? (value.textContent ?? '').trim() : null;
  }, label);
}
async function waitForStat(page, label, expected, timeout = PUSH_MS) {
  await page.waitForFunction(
    ([want, exp]) => {
      const p = [...document.querySelectorAll('p')].find((e) => (e.textContent ?? '').trim().toLowerCase() === want.toLowerCase());
      const value = p?.parentElement?.querySelector('p.tabular') ?? p?.parentElement?.nextElementSibling?.querySelector('p');
      return value ? (value.textContent ?? '').trim() === exp : false;
    },
    [label, String(expected)],
    { timeout },
  );
}
const num = (s) => Number(String(s ?? '').replace(/[^\d]/g, ''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── sign-in ────────────────────────────────────────────────────────────────
//
// The real path: an auth user, a membership the token hook reads, a magic link
// minted by GoTrue's admin API, and the app's own callback. On the local QA
// gateway (scripts/local-qa) GoTrue is a fake that knows `login:<email>[:<role>]`
// and has no generate_link; that is detected by its 404 and used instead.

let ORG = null;

async function organizationId() {
  if (ORG) return ORG;
  const demo = '00000000-0000-4000-8000-000000000001';
  const r = await rest('GET', 'core', 'organizations?select=id&order=created_at.asc&limit=5');
  const ids = (r.json ?? []).map((o) => o.id);
  ORG = ids.includes(demo) ? demo : ids[0];
  if (!ORG) throw new Error('no organization exists — was the seed applied?');
  return ORG;
}

async function ensureAuthUser(email) {
  const created = await gotrue('POST', 'admin/users', { email, password: randomUUID(), email_confirm: true });
  if (created.json?.id) {
    // core.users mirrors auth.users through a trigger; wait until it has.
    for (let i = 0; i < 20; i += 1) {
      const m = await rest('GET', 'core', `users?id=eq.${created.json.id}&select=id`);
      if (m.json?.length === 1) return created.json.id;
      await sleep(150);
    }
    throw new Error(`${email} was created in auth but never mirrored into core.users`);
  }
  const existing = await rest('GET', 'core', `users?email=eq.${encodeURIComponent(email)}&select=id`);
  if (existing.json?.[0]?.id) return existing.json[0].id;
  throw new Error(`could not create ${email}: HTTP ${created.status} ${JSON.stringify(created.json).slice(0, 160)}`);
}

async function membershipOf(userId) {
  const r = await rest('GET', 'core', `memberships?user_id=eq.${userId}&select=id,role,organization_id,status`);
  return r.json?.[0] ?? null;
}

async function signIn(context, { email, role }, c) {
  const userId = await ensureAuthUser(email);
  const org = await organizationId();

  // The first sign-in of a fresh install is bootstrapped by the app; when
  // memberships already exist (the fixtures of an earlier verifier, or a
  // second run), the membership is provisioned here so the hook can stamp it.
  const anyMembership = one(await rest('GET', 'core', 'memberships?select=id&limit=1'));
  const organizations = (await rest('GET', 'core', 'organizations?select=id&limit=3')).json?.length ?? 0;
  const membership = await membershipOf(userId);
  // bootstrap_first_owner fires only for zero memberships and exactly one organization.
  if (!membership && (anyMembership || organizations !== 1 || role !== 'owner')) {
    const made = await rest('POST', 'core', 'memberships', { organization_id: org, user_id: userId, role, status: 'active' });
    if (!made.ok) throw new Error(`could not make ${email} a ${role}: HTTP ${made.status} ${made.text.slice(0, 160)}`);
    c.notes.push(`${email}: membership ${role} provisioned by the harness (bootstrap_first_owner would decline: ${anyMembership ? 'memberships already exist' : `${organizations} organizations`})`);
  }

  const page = await context.newPage();
  const link = await gotrue('POST', 'admin/generate_link', { type: 'magiclink', email });
  let tokenHash;
  if (link.status === 404) {
    tokenHash = `login:${email}:${role}`;
    c.notes.push(`${email}: signed in through the local-qa gateway's login:<email>:<role> token`);
  } else {
    tokenHash = link.json?.hashed_token ?? link.json?.properties?.hashed_token;
    if (!tokenHash) throw new Error(`generate_link gave no hashed_token: HTTP ${link.status} ${JSON.stringify(link.json).slice(0, 200)}`);
  }
  await page.goto(`${APP}/auth/callback?token_hash=${encodeURIComponent(tokenHash)}&type=magiclink&next=${encodeURIComponent('/dashboard')}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120_000,
  });
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  const url = page.url();
  if (/\/login|\/no-access/.test(url)) throw new Error(`${email} did not reach the dashboard after the callback: ${url}`);

  const held = await membershipOf(userId);
  if (!held) throw new Error(`${email} signed in but holds no membership`);
  if (held.role !== role) throw new Error(`${email} is a ${held.role}, not the ${role} this session needs`);
  await page.close();
  return { userId, email, role, organizationId: held.organization_id };
}

// ── docker (scenario 5) ────────────────────────────────────────────────────

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// ── main ───────────────────────────────────────────────────────────────────

const cleanup = [];
const browser = await chromium.launch({
  ...(process.env.CHROME ? { executablePath: process.env.CHROME } : { channel: 'chrome' }),
  args: ['--no-sandbox'],
});

try {
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = { A: [], B: [] };
  for (const [name, ctx] of [['A', ctxA], ['B', ctxB]]) {
    ctx.on('page', (p) => {
      p.on('pageerror', (e) => consoleErrors[name].push(`pageerror: ${e.message.slice(0, 200)}`));
    });
  }

  let A;
  let B;
  await scenario('0. sign in — owner (A) and ops_admin (B)', async (c) => {
    A = await signIn(ctxA, { email: `${MARKER}-owner@example.invalid`, role: 'owner' }, c);
    c.ok('A is the owner', A.email);
    B = await signIn(ctxB, { email: `${MARKER}-ops@example.invalid`, role: 'ops_admin' }, c);
    c.ok('B is an ops_admin', B.email);
    c.dbReadBack = { A: await membershipOf(A.userId), B: await membershipOf(B.userId) };
  });
  if (!A || !B) throw new Error('sign-in failed; nothing else can run');
  const org = A.organizationId;

  // ── 1. a new lead ────────────────────────────────────────────────────────
  await scenario('1. new lead from B → A list and KPI update, pill says Live', async (c) => {
    const dashboard = await ctxA.newPage();
    await dashboard.goto(`${APP}/dashboard`, { waitUntil: 'networkidle' });
    await waitForPill(dashboard, 'Live').catch(async () => c.fail('A dashboard pill says Live', `pill is ${await currentPill(dashboard)}`));
    c.ok('A dashboard pill says Live');
    const leadsPage = await ctxA.newPage();
    await leadsPage.goto(`${APP}/leads`, { waitUntil: 'networkidle' });
    await waitForPill(leadsPage, 'Live').catch(async () => c.fail('A /leads pill says Live', `pill is ${await currentPill(leadsPage)}`));
    c.ok('A /leads pill says Live');

    const before = num(await statValue(dashboard, 'Total leads'));
    const beforeList = num(await statValue(leadsPage, 'Total leads'));
    const dbBefore = await rest('GET', 'crm', `leads?organization_id=eq.${org}&select=id`, undefined, { Prefer: 'count=exact' });
    c.ok('KPI read before', { dashboard: before, leads: beforeList, db: dbBefore.json?.length });

    const title = `${MARKER} lead`;
    const b = await ctxB.newPage();
    await b.goto(`${APP}/dashboard`, { waitUntil: 'networkidle' });
    await b.keyboard.press('Control+k');
    await b.getByRole('dialog', { name: 'Command palette' }).waitFor({ timeout: 10_000 });
    await b.getByLabel('Command search').fill('New lead');
    await b.getByRole('button', { name: /^New lead/ }).first().click();
    await b.locator('#qc-title').fill(title);
    await b.locator('#qc-contact-name').fill(`${MARKER} contact`);
    await b.locator('#qc-email').fill(`${MARKER}-contact@example.invalid`);
    // The header carries its own "Create" menu button; the palette's submit is the one meant.
    await b.getByRole('dialog', { name: 'Command palette' }).getByRole('button', { name: 'Create', exact: true }).click();
    await b.waitForURL(/\/leads\/[0-9a-f-]{36}/, { timeout: 30_000 });
    const leadId = b.url().match(/\/leads\/([0-9a-f-]{36})/)[1];
    await shot(b, 'lead-created-B');

    const row = one(await rest('GET', 'crm', `leads?id=eq.${leadId}&select=id,title,status,organization_id,created_at`));
    c.assert(row?.title === title && row.organization_id === org, 'crm.leads holds the committed row', JSON.stringify(row));
    c.dbReadBack.lead = row;
    cleanup.push(async () => {
      await rest('DELETE', 'crm', `leads?id=eq.${leadId}`);
      await rest('DELETE', 'crm', `contacts?email=eq.${encodeURIComponent(`${MARKER}-contact@example.invalid`)}`);
    });

    await waitForText(dashboard, title).catch(() => c.fail('A dashboard "Recent leads" shows the new lead without a reload', `not within ${PUSH_MS} ms`));
    c.ok('A dashboard "Recent leads" shows the new lead without a reload');
    await waitForStat(dashboard, 'Total leads', before + 1).catch(async () =>
      c.fail('A dashboard KPI "Total leads" went up by one', `is ${await statValue(dashboard, 'Total leads')}, expected ${before + 1}`),
    );
    c.ok('A dashboard KPI "Total leads" went up by one');
    await shot(dashboard, 'lead-dashboard-A');

    await waitForText(leadsPage, title).catch(() => c.fail('A /leads list shows the new lead without a reload', `not within ${PUSH_MS} ms`));
    await waitForStat(leadsPage, 'Total leads', beforeList + 1).catch(async () =>
      c.fail('A /leads KPI went up by one', `is ${await statValue(leadsPage, 'Total leads')}, expected ${beforeList + 1}`),
    );
    c.ok('A /leads list and KPI updated without a reload');
    c.assert((await currentPill(leadsPage)) === 'Live', 'A /leads pill still says Live', await currentPill(leadsPage));
    await shot(leadsPage, 'lead-list-A');
    await b.close();
    await dashboard.close();
    await leadsPage.close();
  });

  // ── 2. an approval ───────────────────────────────────────────────────────
  await scenario('2. approval raised and decided in B → A updates after the decision commits', async (c) => {
    const a = await ctxA.newPage();
    await a.goto(`${APP}/approvals`, { waitUntil: 'networkidle' });
    await waitForPill(a, 'Live').catch(async () => c.fail('A /approvals pill says Live', `pill is ${await currentPill(a)}`));
    c.ok('A /approvals pill says Live');
    const waitingBefore = num(await statValue(a, 'Waiting'));

    // Raised through the engine's own door. No page raises a bare deliverable
    // approval by hand (it is raised by the deliverable being submitted), so
    // the identity-less caller the engine allows — the job runner's path —
    // raises it, with a summary that names this run.
    const summaryText = `${MARKER} approval`;
    // A fresh database carries no approval policy for this organisation, and
    // request_approval answers no_policy rather than defaulting open. The run
    // states its own ladder (one rung, ops_admin, 24 h) and removes it after.
    const policy = one(
      await rest('POST', 'approvals', 'approval_policies', {
        organization_id: org,
        subject_type: 'deliverable',
        min_amount_minor: 0,
        required_role: 'ops_admin',
        sla_hours: 24,
        audience: 'internal',
        active: true,
      }),
    );
    c.assert(policy?.id, 'an approval policy for deliverables exists for this run', JSON.stringify(policy));
    cleanup.push(() => rest('DELETE', 'approvals', `approval_policies?id=eq.${policy.id}`));
    const raised = one(
      await rest('POST', 'approvals', 'rpc/request_approval', {
        p_organization_id: org,
        p_subject_type: 'deliverable',
        p_subject_id: randomUUID(),
        p_requested_by_type: 'system',
        p_summary: summaryText,
      }),
    );
    c.assert(raised?.outcome === 'requested' && raised.request_id, 'request_approval raised it', JSON.stringify(raised));
    const requestId = raised.request_id;
    c.dbReadBack.raised = raised;
    c.notes.push('raised through approvals.request_approval as the identity-less caller (no page raises a bare deliverable approval)');

    await waitForText(a, summaryText).catch(() => c.fail('A shows the pending request without a reload', `not within ${PUSH_MS} ms`));
    await waitForStat(a, 'Waiting', waitingBefore + 1).catch(async () => c.fail('A "Waiting" went up by one', await statValue(a, 'Waiting')));
    c.ok('A shows the pending request and "Waiting" went up by one, without a reload');
    await shot(a, 'approval-pending-A');

    // owner outranks ops_admin outranks delivery_lead (approval_engine.sql):
    // the ops_admin session decides when the policy lets it, the owner otherwise.
    const decider = raised.required_role === 'owner' ? { ctx: ctxA, who: 'A (owner)' } : { ctx: ctxB, who: 'B (ops_admin)' };
    c.notes.push(`policy requires ${raised.required_role}; decided by ${decider.who}`);
    const d = await decider.ctx.newPage();
    await d.goto(`${APP}/approvals/${requestId}`, { waitUntil: 'networkidle' });
    const pendingBeforeDecision = await rest('GET', 'approvals', `approval_requests?id=eq.${requestId}&select=id,state,decided_at`);
    c.assert(one(pendingBeforeDecision)?.state === 'pending', 'the row is pending before the button is pressed', JSON.stringify(one(pendingBeforeDecision)));
    const stillShown = await a.evaluate((t) => document.body.innerText.includes(t), summaryText);
    c.assert(stillShown, 'A still shows it pending before the decision', 'it was gone before anybody decided');

    await d.getByRole('button', { name: 'Approve' }).click();
    await d.waitForFunction(() => /approved|Approved|decided|recorded/i.test(document.body.innerText), null, { timeout: 30_000 }).catch(() => {});
    await shot(d, 'approval-decided-B');

    let row = null;
    for (let i = 0; i < 40 && row?.state !== 'approved'; i += 1) {
      row = one(await rest('GET', 'approvals', `approval_requests?id=eq.${requestId}&select=id,state,decided_at,decided_by`));
      if (row?.state !== 'approved') await sleep(250);
    }
    c.assert(row?.state === 'approved' && row.decided_at, 'approvals.approval_requests.state = approved with decided_at', JSON.stringify(row));
    c.dbReadBack.decided = row;

    await waitForStat(a, 'Waiting', waitingBefore).catch(async () => c.fail('A "Waiting" went back down after the decision', await statValue(a, 'Waiting')));
    c.ok('A "Waiting" went back down after the decision, without a reload');
    await shot(a, 'approval-settled-A');
    await d.close();
    await a.close();
  });

  // ── 3. a payment claim ───────────────────────────────────────────────────
  await scenario('3. payment claim submitted in B → A shows it; verified in B → A shows it verified', async (c) => {
    const client = one(await rest('POST', 'core', 'client_accounts', { organization_id: org, name: `${MARKER} client` }));
    c.assert(client?.id, 'fixture: a client account', JSON.stringify(client));
    cleanup.push(() => rest('DELETE', 'core', `client_accounts?id=eq.${client.id}`));
    const project = one(
      await rest('POST', 'projects', 'projects', { organization_id: org, client_account_id: client.id, name: `${MARKER} project`, status: 'planning' }),
    );
    c.assert(project?.id, 'fixture: a project', JSON.stringify(project));
    cleanup.unshift(() => rest('DELETE', 'projects', `projects?id=eq.${project.id}`));
    const invoiceNumber = `${MARKER.toUpperCase()}-INV`;
    const invoice = one(
      await rest('POST', 'finance', 'invoices', {
        organization_id: org,
        project_id: project.id,
        client_account_id: client.id,
        number: invoiceNumber,
        status: 'issued',
        currency: 'INR',
        total_minor: 1_250_000,
        issued_at: new Date().toISOString(),
        due_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      }),
    );
    c.assert(invoice?.id, 'fixture: an issued invoice', JSON.stringify(invoice));
    cleanup.unshift(() => rest('DELETE', 'finance', `invoices?id=eq.${invoice.id}`));
    c.notes.push('fixtures (client, project, issued invoice) planted through PostgREST as the service role; the claim and the verification go through the pages');

    const a = await ctxA.newPage();
    await a.goto(`${APP}/invoices/verify`, { waitUntil: 'networkidle' });
    await waitForPill(a, 'Live').catch(async () => c.fail('A /invoices/verify pill says Live', `pill is ${await currentPill(a)}`));
    c.ok('A /invoices/verify pill says Live');

    const reference = `UTR-${MARKER.toUpperCase()}`;
    const b = await ctxB.newPage();
    await b.goto(`${APP}/projects/${project.id}`, { waitUntil: 'networkidle' });
    await b.getByText('Record a claim', { exact: true }).click();
    await b.locator('#claim-invoice').selectOption(invoice.id);
    await b.locator('#claim-amount').fill('12500');
    await b.locator('#claim-method').selectOption('bank_transfer');
    await b.getByLabel('Reference', { exact: true }).fill(reference);
    await b.getByLabel('Payer', { exact: true }).fill(`${MARKER} payer`);
    await b.getByRole('button', { name: 'Record what they said they paid' }).click();
    let claim = null;
    for (let i = 0; i < 60 && !claim; i += 1) {
      claim = one(await rest('GET', 'finance', `payment_submissions?invoice_id=eq.${invoice.id}&select=id,status,reference,amount_minor,invoice_id`));
      if (!claim) await sleep(250);
    }
    c.assert(claim?.status === 'pending_verification' && claim.reference === reference, 'finance.payment_submissions holds the pending claim', JSON.stringify(claim));
    c.dbReadBack.claim = claim;
    cleanup.unshift(() => rest('DELETE', 'finance', `payment_submissions?id=eq.${claim.id}`));
    await shot(b, 'claim-recorded-B');

    await waitForText(a, reference).catch(() => c.fail('A shows the claim without a reload', `not within ${PUSH_MS} ms`));
    c.ok('A shows the claim without a reload');
    await shot(a, 'claim-pending-A');

    await b.goto(`${APP}/invoices/verify`, { waitUntil: 'networkidle' });
    // W1 (SCR-054): the decision is four explicit buttons over one note; PAYMENT VERIFIED is the confirm.
    const decisionForm = b.locator('form', { has: b.locator(`input[name="submissionId"][value="${claim.id}"]`) });
    await decisionForm.getByLabel('Verification note').fill(`bank statement line ${reference}`);
    await decisionForm.getByRole('button', { name: 'PAYMENT VERIFIED' }).click();
    let verified = null;
    for (let i = 0; i < 60 && verified?.status !== 'verified'; i += 1) {
      verified = one(await rest('GET', 'finance', `payment_submissions?id=eq.${claim.id}&select=id,status,verified_at,verified_by,verification_evidence`));
      if (verified?.status !== 'verified') await sleep(250);
    }
    c.assert(verified?.status === 'verified' && verified.verified_at, 'finance.payment_submissions.status = verified, with a verifier and evidence', JSON.stringify(verified));
    c.dbReadBack.verified = verified;
    const inv = one(await rest('GET', 'finance', `invoices?id=eq.${invoice.id}&select=id,status`));
    c.dbReadBack.invoice = inv;
    c.notes.push(
      `the verify door records the verification only (finance.verify_payment_submission "does NOT write money"); the invoice stays ${inv?.status} until record_manual_payment — the screen shows the claim as verified, which is what §5's "PAID" means on this page`,
    );
    await shot(b, 'claim-verified-B');

    await a.waitForFunction(
      (ref) => {
        const text = document.body.innerText;
        return text.includes(ref) && /verified by/.test(text);
      },
      reference,
      { timeout: PUSH_MS },
    ).catch(() => c.fail('A shows the claim as verified without a reload', `not within ${PUSH_MS} ms`));
    c.ok('A shows the claim as verified without a reload');
    await shot(a, 'claim-verified-A');
    await b.close();
    await a.close();
  });

  // ── 4. a dead job, requeued ──────────────────────────────────────────────
  await scenario('4. job failed → A shows it; requeued in B → A clears it', async (c) => {
    const a = await ctxA.newPage();
    await a.goto(`${APP}/operations`, { waitUntil: 'networkidle' });
    await waitForPill(a, 'Live').catch(async () => c.fail('A /operations pill says Live', `pill is ${await currentPill(a)}`));
    c.ok('A /operations pill says Live');

    // No page fails a job on purpose; the runner does after its retries. The
    // dead row is planted the way verify-operational-backlog plants one.
    const kind = `${MARKER}.dead`;
    const job = one(
      await rest('POST', 'core', 'jobs', {
        organization_id: org,
        kind,
        status: 'dead',
        attempts: 5,
        max_attempts: 5,
        last_error: `planted by ${MARKER}`,
      }),
    );
    c.assert(job?.id && job.status === 'dead', 'core.jobs holds the dead row', JSON.stringify(job));
    c.dbReadBack.dead = job;
    cleanup.unshift(() => rest('DELETE', 'core', `jobs?id=eq.${job.id}`));
    c.notes.push('the failure is planted as a dead core.jobs row (no page fails a job; the runner does after its retries)');

    await waitForText(a, kind).catch(() => c.fail('A shows the dead job under Dead letters without a reload', `not within ${PUSH_MS} ms`));
    c.ok('A shows the dead job under Dead letters without a reload');
    await shot(a, 'job-dead-A');

    const b = await ctxB.newPage();
    await b.goto(`${APP}/operations`, { waitUntil: 'networkidle' });
    // SCR-060 (bucket F): a requeue carries a reason, so the form refuses a
    // bare click — B says why, as a person would, then requeues.
    const deadRow = b.locator('li', { hasText: kind });
    await deadRow.getByLabel('Reason').fill(`${MARKER}: revived by the two-session run`);
    await deadRow.getByRole('button', { name: 'Requeue' }).click();
    let requeued = null;
    for (let i = 0; i < 60; i += 1) {
      requeued = one(await rest('GET', 'core', `jobs?id=eq.${job.id}&select=id,status,attempts`));
      if (requeued && requeued.status !== 'dead') break;
      await sleep(250);
    }
    c.assert(requeued && requeued.status !== 'dead', 'core.jobs.status left dead (requeued)', JSON.stringify(requeued));
    c.dbReadBack.requeued = requeued;
    await shot(b, 'job-requeued-B');

    // A requeued job leaves Dead letters and appears in the Job queue on the
    // same page, so the whole-page text still names it; the check is that no
    // Dead-letters row (a row with a Requeue button) carries it any more.
    await a
      .waitForFunction(
        (k) => ![...document.querySelectorAll('li')].some((li) => li.innerText.includes(k) && li.innerText.includes('Requeue')),
        kind,
        { timeout: PUSH_MS },
      )
      .catch(() => c.fail('A clears the dead job from Dead letters without a reload', `still shown after ${PUSH_MS} ms`));
    c.ok('A clears the dead job from Dead letters without a reload');
    await waitForText(a, kind).catch(() => c.fail('A shows the requeued job in the Job queue', `not within ${PUSH_MS} ms`));
    c.ok('A shows the requeued job in the Job queue');
    await shot(a, 'job-cleared-A');
    // A queued job of an unknown kind would die again on the next tick; remove it now.
    await rest('DELETE', 'core', `jobs?id=eq.${job.id}`);
    await b.close();
    await a.close();
  });

  // ── 5. the realtime server goes away and comes back ──────────────────────
  if (!REALTIME_CONTAINER) {
    report({
      scenario: '5. realtime container stopped → Reconnecting, Degraded; started → Live and the list catches up',
      status: 'skipped',
      reason: 'REALTIME_CONTAINER is not set — there is no realtime docker container to stop and start here',
    });
  } else {
    await scenario('5. realtime container stopped → Reconnecting, Degraded; started → Live and the list catches up', async (c) => {
      const a = await ctxA.newPage();
      await a.goto(`${APP}/operations`, { waitUntil: 'networkidle' });
      await waitForPill(a, 'Live').catch(async () => c.fail('A /operations pill says Live', `pill is ${await currentPill(a)}`));
      c.ok('A /operations pill says Live');

      let stopped = false;
      try {
        docker('stop', REALTIME_CONTAINER);
        stopped = true;
        c.ok(`docker stop ${REALTIME_CONTAINER}`);
        await waitForPill(a, 'Reconnecting', PILL_MS).catch(async () => c.fail('A shows Reconnecting', `pill is ${await currentPill(a)}`));
        c.ok('A shows Reconnecting');
        await shot(a, 'degrade-reconnecting-A');
        await waitForPill(a, 'Degraded', 180_000).catch(async () => c.fail('A shows Degraded', `pill is ${await currentPill(a)}`));
        c.ok('A shows Degraded');
        await shot(a, 'degrade-degraded-A');

        // Something changes while the channel is down, so "catches up" is measurable.
        const kind = `${MARKER}.while-down`;
        const job = one(
          await rest('POST', 'core', 'jobs', { organization_id: org, kind, status: 'dead', attempts: 5, max_attempts: 5, last_error: `planted by ${MARKER} while realtime was down` }),
        );
        c.assert(job?.id, 'core.jobs holds a dead row written while realtime was down', JSON.stringify(job));
        c.dbReadBack.whileDown = job;
        cleanup.unshift(() => rest('DELETE', 'core', `jobs?id=eq.${job.id}`));

        docker('start', REALTIME_CONTAINER);
        stopped = false;
        c.ok(`docker start ${REALTIME_CONTAINER}`);
        await waitForPill(a, 'Live', 180_000).catch(async () => c.fail('A returns to Live', `pill is ${await currentPill(a)}`));
        c.ok('A returns to Live');
        await waitForText(a, kind, 60_000).catch(() => c.fail('A catches up: the row written while down is shown', 'not shown after 60 s'));
        c.ok('A catches up: the row written while down is shown');
        await shot(a, 'degrade-recovered-A');
      } finally {
        if (stopped) {
          try {
            docker('start', REALTIME_CONTAINER);
          } catch {
            /* reported by the scenario */
          }
        }
      }
      await a.close();
    });
  }

  summary.consoleErrors = consoleErrors;
} catch (error) {
  failed = true;
  summary.fatal = error?.message ?? String(error);
  console.error(summary.fatal);
} finally {
  for (const fn of cleanup) {
    try {
      await fn();
    } catch {
      /* best effort */
    }
  }
  await browser.close().catch(() => {});
  summary.finishedAt = new Date().toISOString();
  summary.screenshots = shots;
  summary.result = failed ? 'failed' : 'passed';
  writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ result: summary.result, summary: path.join(OUT_DIR, 'summary.json'), screenshots: shots.length }));
  if (!existsSync(path.join(OUT_DIR, 'summary.json'))) failed = true;
  process.exit(failed ? 1 : 0);
}
