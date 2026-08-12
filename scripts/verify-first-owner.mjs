#!/usr/bin/env node
/**
 * The first owner is decided once — verified against a real database.
 *
 * Audit finding D19. `core.bootstrap_first_owner` counted memberships, counted
 * organizations, then inserted, with nothing held across the three. Two
 * different people signing in at the same moment on a fresh install both read
 * zero and both insert. The `on conflict (organization_id, user_id)` clause
 * dedupes the *same* user retrying and says nothing about two different ones.
 *
 * `owner` is the top of the matrix in src/lib/authz/permissions.ts — the only
 * role holding proposal.approve, refund.issue, agent.configure and
 * organization.settings — and nothing in the application demotes a membership.
 * A second owner acquired this way is permanent.
 *
 * This drives the real RPC over PostgREST, concurrently, exactly as two
 * simultaneous sign-ins would. It needs no fixture juggling: the seed creates
 * no users and no memberships, so a freshly reset database is precisely the
 * unclaimed deployment the function exists for.
 *
 * What it creates and removes: N auth users per round, through the Auth admin
 * API, and whatever memberships the race produces. Both are deleted in the
 * `finally` block, so an interrupted run does not leave the deployment claimed
 * — which would silently disable the bootstrap for every later run.
 *
 *   node scripts/verify-first-owner.mjs
 */

import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

/** Everything this run creates carries this, so cleanup can find it. */
const MARKER = 'zztest-d19';

/**
 * How many sign-ins race, and how many times.
 *
 * Eight rather than two because this is a real HTTP race, not a controlled
 * interleaving: the window between the count and the insert is a few hundred
 * microseconds, and more simultaneous callers is the only lever that makes
 * landing inside it likely.
 *
 * Five rounds because **the first one is not representative**. Measured
 * against the unfixed function, round 1 passes and rounds 2–5 fail — the
 * first call of a run pays for connection setup and the eight requests end up
 * serialised by accident. A single-round version of this check would have
 * reported the defect as absent. When it does land it lands completely: all
 * eight callers were provisioned as owner, not two.
 *
 * The rate is printed at the end rather than assumed, so a future change that
 * makes the race harder to hit shows up as a weaker check rather than as
 * silence.
 *
 * What this cannot do, stated plainly: PostgREST cannot pin an interleaving —
 * each request is its own transaction and none can be held open across
 * requests — so section 1 *samples* the race and can never prove the absence
 * of one. At the measured pre-fix rate it would take roughly one run in six
 * hundred to pass five rounds on broken code. The deterministic halves are
 * section 3 here, which does not depend on timing at all, and
 * tests/first-owner.test.ts, which asserts the lock in the migration CI
 * applies.
 */
const RACERS = 8;
const ROUNDS = 5;

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const target = resolveTarget(fail, { cron: false, anon: false, jwt: true });
const URL_BASE = target.url;
const SECRET = target.serviceKey;

/**
 * This one refuses a shared target outright, unlike its siblings.
 *
 * They write marker-scoped fixtures into an existing tenant. This creates
 * real auth users — forty-two of them — and, for the duration of a round,
 * claims the deployment. On a fresh hosted project, which is the exact and
 * only state D19 describes, an unguarded run would race a production Auth
 * project and could leave it owned by a test account.
 *
 * Gap G-083 is the general form of this: nothing else stops a verification run
 * being aimed at production. Here it is cheap to stop, so it is stopped.
 */
if (!target.isolated) {
  fail(
    'refusing to run against a shared or unnamed target: this script creates real auth users\n' +
      '  and claims the deployment while it runs. Point it at .env.verify.local.',
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

async function rest(method, schema, path, { body, prefer } = {}) {
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
    /* reported through `text` */
  }
  return { status: res.status, ok: res.ok, json, text };
}

async function auth(method, path, body) {
  const res = await fetch(`${URL_BASE}/auth/v1/${path}`, {
    method,
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  try {
    return { ok: res.ok, json: text ? JSON.parse(text) : null };
  } catch {
    return { ok: res.ok, json: null };
  }
}

/** One sign-in's bootstrap call, through the public wrapper the app uses. */
const bootstrap = (userId) =>
  rest('POST', 'public', 'rpc/bootstrap_first_owner', { body: { p_user_id: userId } });

const memberships = async () => {
  const res = await rest('GET', 'core', 'memberships?select=id,user_id,role,status,organization_id');
  return Array.isArray(res.json) ? res.json : [];
};

// ── reporting ──────────────────────────────────────────────────────────────

let failures = 0;
const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  failures++;
};
const check = (condition, message, detail) =>
  condition ? pass(message) : bad(`${message}${detail ? ` — ${detail}` : ''}`);

// ── run ────────────────────────────────────────────────────────────────────

console.log('\n\x1b[1mAgencyOS — the first owner is decided once (D19)\x1b[0m');
announceTarget(target);

const createdUserIds = [];

async function createUser(tag) {
  const res = await auth('POST', 'admin/users', {
    email: `${MARKER}-${tag}-${Date.now()}@example.invalid`,
    password: `${MARKER}-not-a-real-secret-${tag}`,
    email_confirm: true,
  });
  const id = res.json?.id ?? null;
  if (id) createdUserIds.push(id);
  return id;
}

async function cleanup() {
  // Memberships first and unconditionally: a leftover one leaves the
  // deployment "claimed", which makes bootstrap_first_owner decline forever
  // after — so a failed run would quietly disable the thing under test.
  for (const userId of createdUserIds) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${userId}`);
  }
  for (const userId of createdUserIds) {
    await auth('DELETE', `admin/users/${userId}`);
  }
}

/** Rounds in which more than one owner was provisioned. */
const doubled = [];

/**
 * Ctrl-C must not leave the deployment claimed.
 *
 * `finally` does not run on SIGINT, and a leftover membership makes
 * bootstrap_first_owner decline for every later run — permanently disabling
 * the thing under test. `memberships_write` requires `core.is_owner()`, so
 * nothing but the service key could repair it.
 */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    console.log(`\n  interrupted — clearing ${createdUserIds.length} test user(s) first`);
    try {
      await cleanup();
    } finally {
      process.exit(130);
    }
  });
}

try {
  // ── 0. preflight ─────────────────────────────────────────────────────────
  console.log('\n0. Preflight');
  {
    const existing = await memberships();
    check(
      existing.length === 0,
      'the deployment is unclaimed, so the bootstrap is live',
      `${existing.length} membership(s) already exist — reset the database first`,
    );
    if (existing.length > 0) throw new Error('cannot verify a bootstrap that will decline');

    const orgs = await rest('GET', 'core', 'organizations?select=id');
    check(
      (orgs.json ?? []).length === 1,
      'exactly one organization exists, which is the guard the function requires',
      `${(orgs.json ?? []).length} organizations`,
    );
  }

  // ── 1. the race ──────────────────────────────────────────────────────────
  console.log(`\n1. ${RACERS} simultaneous first sign-ins, ${ROUNDS} times`);
  {
    for (let round = 1; round <= ROUNDS; round += 1) {
      const users = [];
      for (let i = 0; i < RACERS; i += 1) {
        const id = await createUser(`r${round}u${i}`);
        if (id) users.push(id);
      }

      if (users.length !== RACERS) {
        bad(`round ${round}: only ${users.length}/${RACERS} users could be created`);
        continue;
      }

      // Fired together. Not a controlled interleaving — that is the point;
      // this is the shape the defect actually takes.
      const results = await Promise.all(users.map((id) => bootstrap(id)));

      const rows = await memberships();
      // A PostgREST error body is a non-null object, so `json !== null` would
      // count a 500 or a pool-exhaustion 503 as a caller that was provisioned.
      // The function returns a uuid, so a success is a 200 carrying a string.
      const provisioned = results.filter((r) => r.status === 200 && typeof r.json === 'string').length;
      const errored = results.filter((r) => r.status !== 200).length;
      if (errored > 0) bad(`round ${round}: ${errored} call(s) failed outright`);

      if (rows.length > 1) doubled.push(round);

      check(
        rows.length === 1,
        `round ${round}: exactly one membership exists`,
        `${rows.length} were created — ${rows.map((m) => m.role).join(', ')}`,
      );
      check(
        provisioned === 1,
        `round ${round}: exactly one caller was told it had been provisioned`,
        `${provisioned} of ${RACERS} got an organization id back`,
      );
      check(
        rows[0]?.role === 'owner' && rows[0]?.status === 'active',
        `round ${round}: and that one is an active owner`,
        `${rows[0]?.role}/${rows[0]?.status}`,
      );

      // Clear the claim so the next round starts from an unclaimed deployment.
      for (const id of users) {
        await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
      }
    }
  }

  // ── 2. the guard still declines once the deployment is claimed ───────────
  console.log('\n2. A claimed deployment is not re-claimed');
  {
    const first = await createUser('claimed-a');
    const second = await createUser('claimed-b');

    const claimed = await bootstrap(first);
    check(claimed.json !== null, 'the first sign-in is provisioned', claimed.text);

    const later = await bootstrap(second);
    check(
      later.json === null,
      'a later sign-in is declined rather than made a second owner',
      `returned ${later.text}`,
    );

    const rows = await memberships();
    check(rows.length === 1, 'and the membership count is still one', `${rows.length}`);

    // The same user asking twice is the case the conflict clause was for, and
    // it must still be a no-op rather than an error.
    const again = await bootstrap(first);
    check(
      again.json === null && (await memberships()).length === 1,
      'the same user signing in again changes nothing',
      `returned ${again.text}`,
    );

    for (const id of [first, second]) {
      await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    }
  }

  // ── 2b. a caller may claim it for itself, and for nobody else ────────────
  //
  // Gap G-084. `p_user_id` arrived unvalidated and `execute` is granted to
  // `authenticated`, so on an unclaimed deployment any signed-in user could
  // name somebody else's id and hand them the deployment. D19 fixed how many
  // owners result; this is which one.
  //
  // Driven with a minted token rather than the service key, because the check
  // binds only callers that have an identity — the service key carries `role`
  // and no `sub`, so `auth.uid()` is null under it and every section above
  // exercises the exempt path.
  console.log('\n2b. A caller names only itself (G-084)');
  {
    const mint = (userId) => {
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const header = b64({ alg: 'HS256', typ: 'JWT' });
      const body = b64({
        sub: userId,
        aud: 'authenticated',
        role: 'authenticated',
        iat: now,
        exp: now + 600,
      });
      const sig = createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url');
      return `${header}.${body}.${sig}`;
    };

    const asUser = (token, userId) =>
      fetch(`${URL_BASE}/rest/v1/rpc/bootstrap_first_owner`, {
        method: 'POST',
        headers: {
          apikey: token,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
        body: JSON.stringify({ p_user_id: userId }),
      }).then(async (r) => ({ status: r.status, text: await r.text() }));

    const caller = await createUser('g84-caller');
    const victim = await createUser('g84-victim');
    const token = mint(caller);

    // The control first: without it, "declined" below could mean the token was
    // simply rejected and the section would pass while proving nothing.
    const naming = await asUser(token, victim);
    check(
      naming.status === 200,
      'control: the minted token is accepted, so a decline below is the rule and not the token',
      `status ${naming.status}, ${naming.text.slice(0, 120)}`,
    );
    check(
      naming.text.trim() === 'null',
      'a signed-in caller naming somebody else is declined',
      `returned ${naming.text.slice(0, 120)}`,
    );
    check(
      (await memberships()).length === 0,
      'and provisions nobody',
      `${(await memberships()).length} membership(s)`,
    );

    // …and the same caller, naming itself, still works — so the check narrows
    // rather than breaks the bootstrap.
    const itself = await asUser(token, caller);
    check(
      itself.status === 200 && itself.text.trim() !== 'null',
      'while naming itself still provisions',
      `status ${itself.status}, returned ${itself.text.slice(0, 120)}`,
    );
    const rows = await memberships();
    check(
      rows.length === 1 && rows[0]?.user_id === caller,
      'and the owner is the caller, not the one it tried to name',
      `${rows.length} membership(s), user ${rows[0]?.user_id}`,
    );

    for (const id of [caller, victim]) {
      await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    }
  }

  // ── 3. the narrowness guard, which is deterministic ──────────────────────
  //
  // The race above is sampled and can only ever be sampled — PostgREST cannot
  // pin an interleave, so a run that happens not to collide proves nothing on
  // its own. This section does not depend on timing: the function must decline
  // when the organization count is anything but one, and that is checkable
  // exactly.
  console.log('\n3. The guard is narrow, whatever the timing');
  {
    const user = await createUser('narrow');
    let spareOrgId = null;

    try {
      const spare = await rest('POST', 'core', 'organizations', {
        body: { name: `${MARKER} spare organization`, slug: `${MARKER}-spare-${Date.now()}` },
        prefer: 'return=representation',
      });
      spareOrgId = spare.json?.[0]?.id ?? null;
      check(Boolean(spareOrgId), 'a second organization can be created for the check', spare.text);

      if (spareOrgId) {
        const declined = await bootstrap(user);
        check(
          declined.status === 200 && declined.json === null,
          'with two organizations the bootstrap declines rather than picking one',
          `status ${declined.status}, returned ${declined.text}`,
        );
        check(
          (await memberships()).length === 0,
          'and provisions nobody',
          `${(await memberships()).length} membership(s)`,
        );
      }
    } finally {
      if (spareOrgId) await rest('DELETE', 'core', `organizations?id=eq.${spareOrgId}`);
    }

    // …and with the second one gone it works again, so the decline above was
    // the guard rather than something else being broken.
    const provisioned = await bootstrap(user);
    check(
      provisioned.status === 200 && typeof provisioned.json === 'string',
      'and once there is one organization again, the same call provisions',
      `status ${provisioned.status}, returned ${provisioned.text}`,
    );
    await rest('DELETE', 'core', `memberships?user_id=eq.${user}`);
  }
} catch (error) {
  bad(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  console.log('\n4. Cleanup');
  try {
    await cleanup();
    const left = await memberships();
    check(
      left.length === 0,
      'no membership left behind — the deployment is unclaimed again',
      `${left.length} remain, so the bootstrap would decline for every later run`,
    );
  } catch (error) {
    bad(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (doubled.length > 0) {
  console.log(
    `\n\x1b[33m  note: ${doubled.length}/${ROUNDS} round(s) provisioned more than one owner ` +
      `(rounds ${doubled.join(', ')}).\x1b[0m`,
  );
}

if (failures > 0) {
  console.error(`\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32m✔ All checks passed\x1b[0m\n');
