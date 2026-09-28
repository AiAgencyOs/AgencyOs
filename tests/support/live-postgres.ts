/**
 * A live, scratch Postgres instance for a test file to drive through real SQL.
 *
 * Every "Live-verified on scratch Postgres" claim in
 * `docs/phase-4-implementation-traceability.md` before this file existed was a
 * ONE-OFF MANUAL session: run `KEEP=1 scripts/apply-migrations-locally.sh`,
 * drive it by hand with interactive `psql`, and write a static regex against
 * the migration source as the committed test. This repo's own documented
 * lesson ("40 review defects passed every regex" — see that script's header)
 * is that a regex cannot substitute for executing real SQL. This helper makes
 * the manual session into something a `node:test` file can do for itself,
 * automatically, torn down whether the test passes or throws.
 *
 * It deliberately does NOT reimplement `apply-migrations-locally.sh`'s
 * initdb/migration-application logic: it invokes that script as a subprocess
 * with `KEEP=1`, which boots the scratch server, applies every migration and
 * the seed in order, reports, and — because KEEP=1 — leaves the server
 * running and prints the exact `psql -h ... -p ... -U postgres -d ...`
 * connection line a developer would type by hand. This helper parses that
 * line rather than inventing a second source of truth for the port/socket
 * strategy.
 *
 * `queryAs` shells out to `psql` per call — exactly how developers have been
 * driving this scratch instance by hand — and simulates what PostgREST does
 * for a request: `SET ROLE <anon|authenticated|service_role>` (so `to
 * authenticated` RLS policies apply) plus a `request.jwt.claims` GUC (so
 * `auth.uid()` / `auth.role()` / `core.current_organization_id()` /
 * `core.current_user_role()` / `core.current_client_account_id()` — all
 * defined in `supabase/migrations/20260807120001_schemas_and_helpers.sql` and
 * the platform stub in `apply-migrations-locally.sh` — see the claim the
 * caller intends).
 *
 * Kept deliberately small and boring: no connection pooling, no retries, no
 * general-purpose query builder. It exists to serve
 * `tests/phase4-full-pipeline-e2e.test.ts`, not to be a framework.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APPLY_SCRIPT = join(ROOT, 'scripts', 'apply-migrations-locally.sh');

/** The three Postgres roles PostgREST would switch a request into. */
export type PgRole = 'anon' | 'authenticated' | 'service_role';

/** The JWT claims a real PostgREST request would carry for this call. */
export interface Claims {
  /** `auth.uid()` — the signed-in user's id. */
  sub?: string;
  /** `app_metadata.role` — `core.current_user_role()` (owner, client_admin, ...). */
  appRole?: string;
  /** `app_metadata.organization_id` — `core.current_organization_id()`. */
  organizationId?: string;
  /** `app_metadata.client_account_id` — `core.current_client_account_id()`. */
  clientAccountId?: string;
}

export interface LivePostgres {
  /** Unix-socket directory `psql -h` connects to (also the scratch work dir). */
  readonly host: string;
  readonly port: number;
  readonly db: string;
  /** `pg_ctl -D <dataDir>` for this instance. */
  readonly dataDir: string;

  /**
   * Run SQL as the `postgres` superuser — bypasses RLS entirely. For fixture
   * setup, schema introspection, and assertions that are not themselves
   * about who is allowed to see or write a row.
   *
   * Returns raw `psql -qtA` output: one line per result row, columns
   * separated by `|`. Use `parseRows` to split it.
   */
  admin(sql: string): string;

  /**
   * Run SQL the way PostgREST would run it for an authenticated (or
   * anonymous, or service-role) request: `SET ROLE <pgRole>` plus a
   * `request.jwt.claims` GUC built from `claims`. Every door this test suite
   * drives reads its actor through `auth.uid()`/`auth.role()` and its
   * tenancy through `core.current_organization_id()` — both fed by this GUC,
   * never by request data.
   */
  queryAs(pgRole: PgRole, sql: string, claims?: Claims): string;

  /**
   * Stop the scratch server and remove its work directory. Safe to call more
   * than once. Call from a `node:test` `after()`/`finally` — those run even
   * when an earlier test in the same file threw.
   */
  stop(): void;
}

/** Splits `psql -qtA` output into rows of trimmed string columns. */
export function parseRows(output: string): string[][] {
  return output
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => line.split('|'));
}

/** A single scalar from a one-row/one-column `psql -qtA` result. */
export function parseScalar(output: string): string | null {
  const rows = parseRows(output);
  if (rows.length === 0) return null;
  return rows[0]![0] ?? null;
}

/** Escapes a value for embedding inside a SQL `'...'` string literal. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A dollar-quoted jsonb literal — avoids single-quote escaping entirely. */
export function sqlJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json.includes('$sqljson$')) {
    throw new Error('sqlJson payload collides with the dollar-quote delimiter');
  }
  return `$sqljson$${json}$sqljson$::jsonb`;
}

function runPsql(
  host: string,
  port: number,
  db: string,
  sql: string,
  opts: { timeoutMs?: number } = {},
): string {
  const args = [
    '-h', host,
    '-p', String(port),
    '-U', 'postgres',
    '-d', db,
    '-v', 'ON_ERROR_STOP=1',
    '-qtA',
    '-f', '-',
  ];
  const res = spawnSync('psql', args, {
    input: sql,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 30_000,
  });
  if (res.error) {
    throw new Error(`psql could not run:\n${res.error.message}\n--- sql ---\n${sql}`);
  }
  if (res.status !== 0) {
    throw new Error(
      `psql exited ${res.status}:\n${res.stdout ?? ''}${res.stderr ?? ''}\n--- sql ---\n${sql}`,
    );
  }
  return res.stdout ?? '';
}

function buildJwtClaims(pgRole: PgRole, claims: Claims): string {
  const appMetadata: Record<string, string> = {};
  if (claims.appRole !== undefined) appMetadata.role = claims.appRole;
  if (claims.organizationId !== undefined) appMetadata.organization_id = claims.organizationId;
  if (claims.clientAccountId !== undefined) appMetadata.client_account_id = claims.clientAccountId;
  const payload: Record<string, unknown> = { role: pgRole, app_metadata: appMetadata };
  if (claims.sub !== undefined) payload.sub = claims.sub;
  return JSON.stringify(payload);
}

/**
 * Boots a scratch Postgres by invoking `scripts/apply-migrations-locally.sh`
 * with `KEEP=1`, applying every migration in `supabase/migrations/` in order
 * exactly as that script already does, then parses the connection line it
 * prints on success.
 */
export function startLivePostgres(opts: { timeoutMs?: number } = {}): LivePostgres {
  if (!existsSync(APPLY_SCRIPT)) {
    throw new Error(`apply-migrations-locally.sh not found at ${APPLY_SCRIPT}`);
  }

  const result = spawnSync('bash', [APPLY_SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, KEEP: '1' },
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 180_000,
  });

  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  if (result.error) {
    throw new Error(`KEEP=1 apply-migrations-locally.sh could not run:\n${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`KEEP=1 apply-migrations-locally.sh failed:\n${combined}`);
  }

  const m = /server left running:\s*psql -h (\S+) -p (\d+) -U postgres -d (\S+)/.exec(combined);
  if (!m) {
    throw new Error(
      `could not find the "server left running" connection line in script output:\n${combined}`,
    );
  }
  const host = m[1]!;
  const portStr = m[2]!;
  const db = m[3]!;
  const port = Number(portStr);
  const dataDir = join(host, 'data');

  let stopped = false;

  return {
    host,
    port,
    db,
    dataDir,
    admin(sql: string): string {
      return runPsql(host, port, db, sql);
    },
    queryAs(pgRole: PgRole, sql: string, claims: Claims = {}): string {
      const jwt = buildJwtClaims(pgRole, claims);
      // The `\o /dev/null` bracket hides the SET/set_config setup statements'
      // own output; only the caller's SQL below it is printed. Same
      // connection throughout, so `set role` and the GUC apply to it.
      const wrapped = `
\\o /dev/null
set role ${pgRole};
do $$ begin perform set_config('request.jwt.claims', ${sqlJson(JSON.parse(jwt))}::text, false); end $$;
\\o
${sql}
`;
      return runPsql(host, port, db, wrapped);
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      spawnSync('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { encoding: 'utf8', timeout: 30_000 });
      try {
        rmSync(host, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    },
  };
}
