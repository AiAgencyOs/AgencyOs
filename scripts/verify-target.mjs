/**
 * Which database the verification scripts run against.
 *
 * The scripts plant fixtures, drive the real job runner and assert on what the
 * application did. That was safe while nothing else touched the database. It
 * stopped being safe the moment Vercel Cron went live: production now calls
 * `/api/jobs/run` every sixty seconds against the same Supabase project that
 * `.env.local` points at, so a verification run and the production runner
 * compete for the same queue.
 *
 * The fix is a target, chosen explicitly:
 *
 *   .env.verify.local present  →  that database. Isolated: nothing else is
 *                                 draining its queue, so a run is deterministic
 *                                 and fast.
 *   otherwise                  →  .env.local, i.e. whatever the app uses. Still
 *                                 correct — the scripts assert on settled
 *                                 database state rather than on which
 *                                 invocation happened to do the work — but a
 *                                 run shares its queue with the live cron.
 *
 * Both paths are honest. Only the isolated one is quiet.
 *
 * See .env.verify.local.example for the two ways to fill it in: the local
 * Supabase stack (`npm run verify:db:up`), or a second cloud project.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const ISOLATED_FILE = '.env.verify.local';
const DEFAULT_FILE = '.env.local';

/**
 * Reads a dotenv file into a plain object.
 *
 * Surrounding quotes are stripped, because `node --env-file` strips them and
 * that is the loader the dev server these scripts drive is started with. A
 * parser that disagrees with it is not merely stricter — it is pointed at a
 * different database than the app it is asserting against.
 *
 * Leaving them in failed quietly and late: a quoted URL yields the string
 * `"http://…"` with the quotes still attached, so every request built by
 * concatenation dies in `new URL`, and `announceTarget` below reports the host
 * as "unknown" rather than naming the file that is wrong.
 *
 * Only a *matched* leading/trailing pair is removed, so a value that genuinely
 * contains a quote character keeps it.
 */
function parse(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const raw = m[2].trim();
    const quoted = /^(["'])(.*)\1$/.exec(raw);
    env[m[1]] = quoted ? quoted[2] : raw;
  }
  return env;
}

/**
 * Resolves the target. `fail` is the caller's own exit function so that a
 * missing file reports in the script's voice rather than throwing.
 *
 * `needs` names the credentials this particular script cannot run without, so
 * a script that never calls the runner is not made to invent a CRON_SECRET and
 * one that never tests RLS is not made to supply a publishable key.
 */
export function resolveTarget(fail, needs = { cron: true, anon: false }) {
  const isolatedPath = join(root, ISOLATED_FILE);
  const isolated = existsSync(isolatedPath);
  const path = isolated ? isolatedPath : join(root, DEFAULT_FILE);

  if (!existsSync(path)) {
    fail(`${DEFAULT_FILE} not found. Copy .env.example and fill it in.`);
  }

  const env = parse(path);
  const target = {
    file: isolated ? ISOLATED_FILE : DEFAULT_FILE,
    isolated,
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    anonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    cronSecret: env.CRON_SECRET,
    whatsappVerifyToken: env.WHATSAPP_VERIFY_TOKEN,
    whatsappAppSecret: env.WHATSAPP_APP_SECRET,
    jwtSecret: env.SUPABASE_JWT_SECRET,
    app: env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  };

  if (!target.url || !target.serviceKey) {
    fail(`NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in ${target.file}.`);
  }
  if (needs.anon && !target.anonKey) {
    fail(`NEXT_PUBLIC_SUPABASE_ANON_KEY must be set in ${target.file} to test row level security.`);
  }
  if (needs.cron && !target.cronSecret) {
    fail(`CRON_SECRET must be set in ${target.file} — the job runner is inert without it.`);
  }
  if (needs.jwt && !target.jwtSecret) {
    fail(
      `SUPABASE_JWT_SECRET must be set in ${target.file} to mint role-scoped tokens. ` +
        `For the local stack it is the JWT_SECRET printed by \`supabase start\`.`,
    );
  }
  if (needs.whatsapp && (!target.whatsappVerifyToken || !target.whatsappAppSecret)) {
    fail(
      `WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET must both be set in ${target.file} — ` +
        `the inbound webhook answers 503 without them, and a script cannot sign a delivery it has no secret for.`,
    );
  }

  return target;
}

/**
 * One line saying where this run is pointed, and whether anything else can
 * touch it. Printed before any fixture is written, because "which database am
 * I about to plant rows in" is the first thing a reader needs.
 *
 * The host is shown, never a key.
 */
export function announceTarget(target) {
  const host = (() => {
    try {
      return new URL(target.url).host;
    } catch {
      return 'unknown host';
    }
  })();

  if (target.isolated) {
    console.log(
      `  \x1b[32m◆\x1b[0m target: ${host} (${target.file}) — isolated, no other runner drains this queue`,
    );
  } else {
    console.log(
      `  \x1b[33m◆\x1b[0m target: ${host} (${target.file}) — shared with the live Vercel cron;` +
        ` assertions settle on database state rather than on one tick's response`,
    );
  }
}

/**
 * Refuses to drive an application pointed at a different database.
 *
 * Gap G-083. `resolveTarget` above is careful about which database *this
 * script* writes to, and four of the scripts then drive the running
 * application as well — planting a job and asking `/api/jobs/run` to work it,
 * or posting a webhook and waiting for the row to appear. Nothing checked that
 * the application was talking to the same place.
 *
 * That is not theoretical. `next build` inlines NEXT_PUBLIC_SUPABASE_URL, so a
 * build run without the verify environment sourced produces an app aimed at
 * whatever `.env.local` holds — which in a working copy is usually a real
 * project. It happened during this audit. The only reason nothing landed in
 * that project is that the local service key did not match the remote URL, so
 * every call the app made failed. With a matching pair it would have drained a
 * production queue.
 *
 * The comparison is a fingerprint of the URL, served by /api/health. Matching
 * it proves the two agree without either side handling the other's secrets.
 *
 * An app that predates the `target` field is refused rather than assumed
 * compatible: "I could not tell" and "they match" are different answers, and
 * this exists precisely for the case where the answer is not obvious.
 */
export async function assertAppTarget(target, fail) {
  const fingerprint = createHash('sha256').update(target.url).digest('hex').slice(0, 12);

  let body;
  try {
    const res = await fetch(`${target.app}/api/health`, { cache: 'no-store' });
    body = await res.json();
  } catch (error) {
    fail(
      `could not reach ${target.app}/api/health to check which database the app is using: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  if (typeof body?.target !== 'string') {
    fail(
      `${target.app} did not report which database it is using. Rebuild it with the same\n` +
        `  environment this script uses (\`set -a && . ./${target.file} && set +a && npm run build\`),\n` +
        `  because NEXT_PUBLIC_SUPABASE_URL is inlined at build time.`,
    );
    return;
  }

  if (body.target !== fingerprint) {
    fail(
      `the app at ${target.app} is talking to a DIFFERENT database than this script.\n` +
        `  script: ${fingerprint}  app: ${body.target}\n` +
        `  Almost always this means the app was built without ${target.file} sourced —\n` +
        `  NEXT_PUBLIC_SUPABASE_URL is inlined by \`next build\`. Rebuild and restart it.\n` +
        `  Refusing to continue: driving that app would write to the wrong database.`,
    );
  }
}
