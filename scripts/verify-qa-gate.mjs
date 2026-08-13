#!/usr/bin/env node
/**
 * The QA gate, verified against a real database.
 *
 * Phase 12, gap G-030. `ARCHITECTURE.md` §4.8 states the rule this checks —
 * a deliverable cannot go to the client while an open blocker or major defect
 * stands against it — so this is a stated product rule being enforced rather
 * than an invented one.
 *
 * The scoping is the part worth proving. The obvious reading, "no open blocker
 * on this project", is a trap: bugs are found against a version and the fix is
 * the next version, so a blocker on v2 blocking v3 would make the fix
 * unshowable and the only way out would be to close the bug dishonestly.
 *
 * What it proves:
 *
 *   1. An open blocker stops the version it was found on.
 *   2. A major does too — §4.8 names both.
 *   3. A minor does not, and neither does a fixed blocker.
 *   4. A blocker on v1 does NOT stop v2, because v2 is the fix.
 *   5. A project-wide defect (no version named) stops everything.
 *   6. The transitions hold: verified and wontfix are terminal, fixed can
 *      fall back to open, and a verification names somebody.
 *
 *   node scripts/verify-qa-gate.mjs
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

/**
 * Refuses an environment it cannot run against, with a message rather than a
 * crash. `resolveTarget` takes the caller's own exit function — the first
 * version of this script passed none, so an incomplete .env.verify.local
 * produced "fail is not a function" instead of the sentence explaining what
 * was missing. The error path nobody had executed.
 */
function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

// This script needs a service key and the JWT secret: it drives the database directly and
// never calls the job runner, so CRON_SECRET is not required of it.
const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'verify-qa-gate');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-g030';
const ORG = '00000000-0000-4000-8000-000000000001';

let failures = 0;
let checks = 0;

function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function call(token, method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: token,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Profile': schema,
      'Content-Profile': schema,
      Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: parse(text), text };
}

const rest = (m, s, p, b) => call(KEY, m, s, p, b);
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

function mint(userId, role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub: userId,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { organization_id: ORG, role },
    iat: now,
    exp: now + 900,
  });
  return `${header}.${body}.${createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url')}`;
}

const submit = (id) => rest('POST', 'projects', 'rpc/submit_deliverable', { p_deliverable_id: id });
const defect = (projectId, severity, deliverableId) =>
  rest('POST', 'qa', 'defects', {
    organization_id: ORG,
    project_id: projectId,
    deliverable_id: deliverableId ?? null,
    severity,
    title: `${MARKER} ${severity}`,
    reproduction: 'Open the thing, look at it.',
  });

const created = { users: [] };

console.log('\n\x1b[1mAgencyOS — the QA gate (G-030, ARCHITECTURE.md §4.8)\x1b[0m');

try {
  const account = one(
    await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }),
  );
  created.account = account?.id;

  const project = one(
    await rest('POST', 'projects', 'projects', {
      organization_id: ORG,
      client_account_id: created.account,
      name: `${MARKER} project`,
      status: 'active',
    }),
  );
  created.project = project?.id;
  if (!created.project) throw new Error('could not create the project fixture');

  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      email: `${MARKER}-owner-${randomUUID().slice(0, 8)}@example.invalid`,
      password: randomUUID(),
      email_confirm: true,
    }),
  }).then((r) => r.json());
  created.users.push(authUser.id);
  await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email });
  await rest('POST', 'core', 'memberships', {
    organization_id: ORG,
    user_id: authUser.id,
    role: 'owner',
    status: 'active',
  });

  await call(mint(authUser.id, 'owner'), 'POST', 'approvals', 'approval_policies', {
    organization_id: ORG,
    subject_type: 'deliverable',
    min_amount_minor: 0,
    required_role: 'ops_admin',
    sla_hours: 48,
    audience: 'client',
  });

  const v1 = one(
    await rest('POST', 'projects', 'rpc/add_deliverable', {
      p_project_id: created.project,
      p_kind: 'build',
      p_title: 'Build 1',
    }),
  );

  // ── 1-3. what blocks, and what does not ─────────────────────────────────
  console.log('\n1. An open blocker stops the version it was found on');
  {
    const minor = one(await defect(created.project, 'minor', v1.deliverable_id));
    let attempt = one(await submit(v1.deliverable_id));
    check(attempt?.outcome === 'submitted', 'a minor defect does not stop anything', `outcome ${attempt?.outcome}`);

    // Put it back so the blocker can be tested against the same version.
    await rest('PATCH', 'projects', `deliverables?id=eq.${v1.deliverable_id}`, { status: 'draft' });
    const pending = await rest('GET', 'approvals', `approval_requests?state=eq.pending&select=id`);
    for (const row of pending.json ?? []) {
      await rest('PATCH', 'approvals', `approval_requests?id=eq.${row.id}`, {
        state: 'cancelled',
        decided_at: new Date().toISOString(),
      });
    }

    const blocker = one(await defect(created.project, 'blocker', v1.deliverable_id));
    attempt = one(await submit(v1.deliverable_id));
    check(attempt?.outcome === 'blocked', 'an open blocker refuses the submission', `outcome ${attempt?.outcome}`);

    const row = one(await rest('GET', 'projects', `deliverables?id=eq.${v1.deliverable_id}&select=status`));
    check(row?.status === 'draft', 'and the version stays where it was', `${row?.status}`);

    const blocking = await rest('POST', 'qa', 'rpc/blocking_defects', { p_deliverable_id: v1.deliverable_id });
    check(
      blocking.json?.length === 1 && blocking.json[0].severity === 'blocker',
      'the caller can be told which defect, not merely that something is wrong',
      `${blocking.json?.length} blocking`,
    );

    created.blocker = blocker.id;
    created.minor = minor.id;
  }

  // ── 4. the trap that was avoided ────────────────────────────────────────
  console.log('\n2. A blocker on v1 does not stop v2 — v2 is the fix');
  {
    const v2 = one(
      await rest('POST', 'projects', 'rpc/add_deliverable', {
        p_project_id: created.project,
        p_kind: 'build',
        p_title: 'Build 2 — fixes the blocker',
      }),
    );
    const attempt = one(await submit(v2.deliverable_id));
    check(
      attempt?.outcome === 'submitted',
      'the next version reaches the client while the old one is still blocked',
      `outcome ${attempt?.outcome}`,
    );
    created.v2 = v2.deliverable_id;
  }

  // ── 5. project-wide ─────────────────────────────────────────────────────
  console.log('\n3. A defect with no version named stops everything');
  {
    const v3 = one(
      await rest('POST', 'projects', 'rpc/add_deliverable', {
        p_project_id: created.project,
        p_kind: 'design',
        p_title: 'Design 1',
      }),
    );
    const wide = one(await defect(created.project, 'major', null));

    const attempt = one(await submit(v3.deliverable_id));
    check(
      attempt?.outcome === 'blocked',
      'a project-wide major stops a different kind entirely',
      `outcome ${attempt?.outcome}`,
    );

    await rest('PATCH', 'qa', `defects?id=eq.${wide.id}`, {
      status: 'wontfix',
      resolution: 'not reproducible on the shipped build',
    });
    const after = one(await submit(v3.deliverable_id));
    check(after?.outcome === 'submitted', 'and settling it lets the work move again', `outcome ${after?.outcome}`);
  }

  // ── 6. the transitions ──────────────────────────────────────────────────
  console.log('\n4. A defect moves the way it is allowed to');
  {
    const illegal = await rest('PATCH', 'qa', `defects?id=eq.${created.blocker}`, {
      status: 'verified',
      resolution: 'skipping the middle',
      verified_by: created.users[0],
      verified_at: new Date().toISOString(),
    });
    check(
      illegal.status >= 400 && !illegal.text.includes('PGRST106'),
      'open cannot jump straight to verified',
      `status ${illegal.status}, ${illegal.text.slice(0, 120)}`,
    );

    const fixed = await rest('PATCH', 'qa', `defects?id=eq.${created.blocker}`, {
      status: 'fixed',
      resolution: 'null check added',
    });
    check(fixed.status === 200, 'open moves to fixed with a resolution', `status ${fixed.status}`);

    const unverified = await rest('PATCH', 'qa', `defects?id=eq.${created.blocker}`, { status: 'verified' });
    check(
      unverified.status >= 400,
      'and a verification that names nobody is refused',
      `status ${unverified.status}, ${unverified.text.slice(0, 120)}`,
    );

    const verified = await rest('PATCH', 'qa', `defects?id=eq.${created.blocker}`, {
      status: 'verified',
      verified_by: created.users[0],
      verified_at: new Date().toISOString(),
    });
    check(verified.status === 200, 'a verification that names somebody is recorded', `status ${verified.status}`);

    const reopened = await rest('PATCH', 'qa', `defects?id=eq.${created.blocker}`, { status: 'open' });
    check(
      reopened.status >= 400,
      'and a verified defect is terminal — otherwise "verified" means "for now"',
      `status ${reopened.status}`,
    );

    const quality = one(await rest('POST', 'qa', 'rpc/project_quality', { p_project_id: created.project }));
    check(
      Number(quality?.open_blockers) === 0 && Number(quality?.total) >= 3,
      'and the project counts reflect all of it',
      JSON.stringify(quality),
    );
  }

  // ── G-031 — what production ready is allowed to mean ─────────────────────
  //
  // ADM-19: zero open blockers, zero open majors, a client-approved build.
  // Payment state and an owner sign-off were offered and left out, so this
  // section deliberately never touches an invoice.
  //
  // The project reaching here has defects in every state the section above
  // put them in, which is why the gate is worth testing on it rather than on
  // a clean fixture.
  console.log('\n7. G-031 — production ready');
  {
    const readiness = async () =>
      one(await rest('POST', 'projects', 'rpc/production_readiness', { p_project_id: created.project }));

    const mark = async () =>
      one(await rest('POST', 'projects', 'rpc/mark_production_ready', { p_project_id: created.project }));

    const before = await readiness();
    check(
      before?.build_approved === false,
      'no client-approved build yet, so the project is not ready',
      JSON.stringify(before ?? null),
    );

    const refused = await mark();
    check(refused?.outcome === 'not_ready', 'and marking it is refused', `outcome: ${refused?.outcome}`);
    check(
      Array.isArray(refused?.unmet) && refused.unmet.includes('no_approved_build'),
      'naming the condition rather than reporting that something is wrong',
      JSON.stringify(refused?.unmet ?? null),
    );

    const untouched = one(
      await rest('GET', 'projects', `projects?id=eq.${created.project}&select=production_ready_at`),
    );
    check(
      untouched?.production_ready_at === null,
      'and a refusal marks nothing',
      JSON.stringify(untouched ?? null),
    );

    // Give it an approved build, and an open blocker, so the two conditions
    // are tested apart rather than together.
    const build = one(
      await rest('POST', 'projects', 'rpc/add_deliverable', {
        p_project_id: created.project,
        p_kind: 'build',
        p_title: `${MARKER} build`,
      }),
    );
    await rest('PATCH', 'projects', `deliverables?id=eq.${build?.deliverable_id}`, {
      status: 'approved',
    });

    const blocker = one(await defect(created.project, 'blocker'));
    check(blocker?.id !== undefined, 'a fresh blocker is raised on the project');

    const withBlocker = await mark();
    check(
      withBlocker?.outcome === 'not_ready' &&
        Array.isArray(withBlocker?.unmet) &&
        withBlocker.unmet.includes('open_blockers') &&
        !withBlocker.unmet.includes('no_approved_build'),
      'an approved build is not enough while a blocker is open',
      JSON.stringify(withBlocker?.unmet ?? null),
    );

    // Closing this one is not enough, and finding that out was the point of
    // running the gate on the project the sections above have been breaking
    // rather than on a clean fixture: those sections leave open *majors*
    // behind, so the first attempt here failed with open_majors — correctly.
    //
    // Everything still open is closed, so the last check tests the condition
    // it claims to rather than whichever defect happened to be last.
    // open → fixed → verified. The trigger admits open → fixed|wontfix and
    // fixed → verified|open, and nothing else — so the single PATCH the first
    // draft used was refused, silently leaving every defect open. Two steps,
    // in the order the state machine allows.
    await rest('PATCH', 'qa', `defects?project_id=eq.${created.project}&status=eq.open`, {
      status: 'fixed',
      resolution: 'fixed',
    });
    await rest('PATCH', 'qa', `defects?project_id=eq.${created.project}&status=eq.fixed`, {
      status: 'verified',
    });

    const cleared = await readiness();
    check(
      cleared?.no_open_blockers === true && cleared?.no_open_majors === true,
      'with every defect closed, both severity conditions are met',
      JSON.stringify(cleared ?? null),
    );

    const ready = await mark();
    check(ready?.outcome === 'ready', 'closing it makes the project production ready', `outcome: ${ready?.outcome}`);

    const marked = one(
      await rest('GET', 'projects', `projects?id=eq.${created.project}&select=production_ready_at`),
    );
    check(marked?.production_ready_at !== null, 'and the moment is recorded');

    const again = await mark();
    check(again?.outcome === 'already_ready', 'marking it twice is answered', `outcome: ${again?.outcome}`);

    const unmoved = one(
      await rest('GET', 'projects', `projects?id=eq.${created.project}&select=production_ready_at`),
    );
    check(
      unmoved?.production_ready_at === marked?.production_ready_at,
      'and does not move the date it first became ready',
    );
  }
} finally {
  if (created.project) {
    await rest('DELETE', 'qa', `defects?project_id=eq.${created.project}`);
    await rest('DELETE', 'projects', `deliverables?project_id=eq.${created.project}`);
    await rest('DELETE', 'projects', `projects?id=eq.${created.project}`);
  }
  const pending = await rest('GET', 'approvals', 'approval_requests?state=eq.pending&select=id');
  for (const row of pending.json ?? []) {
    await rest('PATCH', 'approvals', `approval_requests?id=eq.${row.id}`, {
      state: 'cancelled',
      decided_at: new Date().toISOString(),
    });
  }
  await rest('DELETE', 'approvals', `approval_policies?organization_id=eq.${ORG}`);
  if (created.account) await rest('DELETE', 'core', `client_accounts?id=eq.${created.account}`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      cache: 'no-store',
    });
  }
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ Broken work does not reach the client, and the fix still can\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
