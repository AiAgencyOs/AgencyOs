#!/usr/bin/env node
/**
 * A restore, rehearsed — because an untested backup is a hypothesis.
 *
 * The runbook's own words (docs/deployment/runbook.md, Rollback): "No backup
 * has ever been restored. Until a restore is rehearsed... recovery time is
 * unknown." This script is the rehearsal, against the only database that
 * needs no credential anybody has deferred: the LOCAL Supabase stack.
 *
 * ── what it proves, and what it deliberately does not ────────────────────
 *
 * PROVES: a pg_dump of the running local database restores completely into a
 * fresh, empty database in the SAME CLUSTER — row for row, counts and
 * contents, across every application schema — and how long that takes. The
 * dump is the artifact under test, not the migrations: the scratch database
 * is built from the dump alone.
 *
 * DOES NOT prove: production recovery. The runbook's definition-of-done box —
 * "a restore rehearsed on STAGING, with the measured recovery time written
 * down" — stays unticked. There is no staging project yet (ADM-60), and this
 * script must not pretend to be one. Same-cluster is also a bound worth
 * stating: roles and extension binaries pre-exist here, and a cross-server
 * restore would additionally need `pg_dumpall --globals`. The source database
 * is only read; the restore target is a scratch database, created and dropped
 * here, so the rehearsal is safe to run anywhere in a verification chain.
 *
 * ── mechanics ─────────────────────────────────────────────────────────────
 *
 * Everything runs inside this project's supabase_db container via docker
 * exec, so the client tools match the server version by construction and the
 * script is local-only by construction. The container name is matched exactly
 * against supabase/config.toml's project_id — a lone container from some
 * OTHER project's stack must be refused, not rehearsed.
 *
 * The source inventory and the dump share one MVCC snapshot: a session holds
 * `pg_export_snapshot()` open and `pg_dump --snapshot` reuses it, so a write
 * landing mid-rehearsal cannot make a perfect backup look torn. Tables are
 * compared by exact count AND an md5 over their ordered row text — count
 * equality alone would call a same-size corruption a success.
 *
 * Supabase-managed schemas (auth, storage, realtime…) are restored with
 * everything else and counted structurally, but not row-compared: the
 * platform writes to them on its own schedule, and a moving target cannot
 * anchor an exactness claim.
 *
 * Known boundary, stated rather than solved speculatively: the day a
 * migration adopts pg_cron, `create extension pg_cron` will refuse to run in
 * a database not named by cron.database_name and the restore step will need
 * a TOC filter (pg_restore -l / -L). No machinery for that exists here
 * because no such migration exists.
 *
 * ── the red proof ─────────────────────────────────────────────────────────
 *
 * A comparison that cannot fail is not evidence. REHEARSE_RESTORE_TAMPER
 * names one application table (schema.table); after the restore, exactly one
 * row is deleted from it IN THE SCRATCH DATABASE, and the run must then exit
 * nonzero with that table named in the diff. The target is validated first —
 * it must be a row-compared application table that actually has rows, so a
 * typo, a managed-schema table, or an empty table is a bad target, not a
 * silently green rehearsal — and if a tamper was requested and every check
 * still passes, the run fails on that alone: a tamper that goes undetected
 * means the detector is decorative.
 *
 * The first tamper attempt here picked core.organizations and was refused —
 * the cascade reached approvals.approval_requests, whose no-delete trigger
 * fired IN THE RESTORED COPY. That refusal is its own small proof (the dump
 * brings triggers back alive), and the hook reports it as a refusal rather
 * than a rehearsal verdict.
 */

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SCRATCH = 'rehearse_restore';
const DUMP = '/tmp/rehearse-restore.dump';

/** Supabase-managed schemas: restored, structurally counted, not row-compared. */
const MANAGED = [
  'auth', 'storage', 'realtime', '_realtime', 'supabase_functions',
  'supabase_migrations', 'extensions', 'graphql', 'graphql_public',
  'pgbouncer', 'pgsodium', 'pgsodium_masks', 'vault', 'net', '_analytics',
  'cron', 'pgmq', 'pgtle', 'dbdev', 'information_schema',
];

let failures = 0;
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const bad = (msg) => { failures += 1; console.log(`  \x1b[31m✗\x1b[0m ${msg}`); };
const fail = (msg) => { console.error(`\x1b[31m${msg}\x1b[0m`); process.exitCode = 1; throw new Error('rehearsal aborted'); };

function docker(args, opts = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64, ...opts });
}

/** The container this project's config names — a lone foreign stack must be refused. */
function findContainer() {
  const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
  const m = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m);
  if (!m) fail('supabase/config.toml has no project_id — cannot name the container to rehearse.');
  const expected = `supabase_db_${m[1]}`;
  let names;
  try {
    names = docker(['ps', '--filter', `name=^${expected}$`, '--format', '{{.Names}}']).trim();
  } catch {
    fail('docker is not reachable. The rehearsal needs the local Supabase stack: npm run verify:db:up');
  }
  if (names !== expected) {
    fail(`Container ${expected} is not running (docker ps found ${names || 'nothing matching'}). ` +
      'Start THIS project\'s local stack first: npm run verify:db:up');
  }
  return expected;
}

const oneShot = (container, dbName, text) => docker([
  'exec', container, 'psql', '-U', 'supabase_admin', '-d', dbName,
  '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', text,
]).trim();

/**
 * A psql session that stays open, so `pg_export_snapshot()` stays valid while
 * pg_dump and the inventory queries all read the same instant. One-shot
 * psql calls cannot do this — each is its own transaction, and four separate
 * instants straddling a busy stack produced exactly the false-mismatch race
 * this exists to close.
 */
function openSession(container) {
  const child = spawn('docker', [
    'exec', '-i', container, 'psql', '-U', 'supabase_admin', '-d', 'postgres',
    '-Atq', '-v', 'ON_ERROR_STOP=1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let buffer = '';
  let stderr = '';
  const waiters = [];
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (d) => {
    buffer += d;
    let at;
    while ((at = buffer.indexOf('__DONE__\n')) !== -1) {
      const chunk = buffer.slice(0, at);
      buffer = buffer.slice(at + '__DONE__\n'.length);
      waiters.shift()?.resolve(chunk.split('\n').filter(Boolean));
    }
  });
  child.on('close', (code) => {
    for (const w of waiters.splice(0)) {
      w.reject(new Error(`psql session ended (exit ${code}): ${stderr.trim()}`));
    }
  });

  return {
    query: (text) => new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
      child.stdin.write(`${text}\n\\echo __DONE__\n`);
    }),
    end: () => { child.stdin.end(); },
  };
}

/** `schema.table|count|md5-of-ordered-row-text` for every base table in the schemas. */
const INVENTORY_SQL = (schemas) => `
  select table_schema || '.' || table_name || '|' ||
    (xpath('/row/cnt/text()', x))[1]::text || '|' ||
    (xpath('/row/ck/text()', x))[1]::text
  from (
    select table_schema, table_name,
      query_to_xml(format(
        'select count(*) as cnt, coalesce(md5(string_agg(t::text, chr(10) order by t::text)), ''empty'') as ck from %I.%I t',
        table_schema, table_name), false, true, '') as x
    from information_schema.tables
    where table_type = 'BASE TABLE' and table_schema in (${schemas.map((s) => `'${s}'`).join(',')})
  ) tables
  order by 1;`;

const TOTAL_TABLES_SQL = `
  select count(*) from information_schema.tables
  where table_type = 'BASE TABLE'
    and table_schema not in ('pg_catalog', 'information_schema');`;

const APP_SCHEMAS_SQL = `
  select nspname from pg_namespace
  where nspname not like 'pg\\_%'
    and nspname not in (${MANAGED.map((s) => `'${s}'`).join(',')})
  order by 1;`;

const parseInventory = (lines) => {
  const map = new Map();
  for (const line of lines) {
    const [table, count, checksum] = [
      line.slice(0, line.indexOf('|')),
      ...line.slice(line.indexOf('|') + 1).split('|'),
    ];
    map.set(table, { count: Number(count), checksum });
  }
  return map;
};

const container = findContainer();

console.log('Restore rehearsal — LOCAL stack only. This does not tick the runbook\'s staging box.');
console.log(`  container ${container} · source database "postgres" · scratch database "${SCRATCH}"`);
console.log(`  server ${oneShot(container, 'postgres', 'show server_version;')}`);

let session;
try {
  // ── 1. one snapshot: the inventory and the dump see the same instant ────
  session = openSession(container);
  await session.query('begin transaction isolation level repeatable read;');
  const [snapshot] = await session.query('select pg_export_snapshot();');

  const schemas = (await session.query(APP_SCHEMAS_SQL)).filter(Boolean);
  // The floor that keeps "every application schema" from being vacuously
  // true — and a wrong database from rehearsing quietly.
  if (!schemas.includes('core') || !schemas.includes('crm')) {
    fail(`Application schemas core and crm are missing (found: ${schemas.join(', ') || 'none'}) — is this the right database?`);
  }

  console.log(`\n1. Dump — the artifact under test, snapshot ${snapshot}`);
  console.log(`  application schemas row-compared: ${schemas.join(', ')}`);
  const before = parseInventory(await session.query(INVENTORY_SQL(schemas)));
  const [sourceTables] = await session.query(TOTAL_TABLES_SQL);
  if (before.size === 0) fail('No application tables found — nothing to rehearse is a failure, not a success.');

  const t0 = Date.now();
  docker(['exec', container, 'pg_dump', '-U', 'supabase_admin', '--snapshot', snapshot, '-Fc', '-f', DUMP, 'postgres']);
  const dumpSeconds = (Date.now() - t0) / 1000;
  await session.query('commit;');
  session.end();
  session = null;
  const size = docker(['exec', container, 'stat', '-c', '%s', DUMP]).trim();
  ok(`pg_dump -Fc in ${dumpSeconds.toFixed(1)}s — ${(Number(size) / 1024 / 1024).toFixed(1)} MiB`);

  // ── 2. restore into an empty database ───────────────────────────────────
  console.log('\n2. Restore — into a database the dump must build alone');
  oneShot(container, 'postgres', `drop database if exists ${SCRATCH} with (force);`);
  docker(['exec', container, 'createdb', '-U', 'supabase_admin', SCRATCH]);

  const t1 = Date.now();
  docker(['exec', container, 'pg_restore', '-U', 'supabase_admin', '-d', SCRATCH, '--exit-on-error', DUMP]);
  const restoreSeconds = (Date.now() - t1) / 1000;
  ok(`pg_restore --exit-on-error in ${restoreSeconds.toFixed(1)}s`);
  console.log(`  \x1b[1mmeasured recovery time (local): dump ${dumpSeconds.toFixed(1)}s + restore ${restoreSeconds.toFixed(1)}s = ${(dumpSeconds + restoreSeconds).toFixed(1)}s\x1b[0m`);

  // ── red-proof hook: prove the detector detects ───────────────────────────
  const tamper = process.env.REHEARSE_RESTORE_TAMPER;
  if (tamper) {
    const dot = tamper.indexOf('.');
    const [ts, tt] = dot > 0 ? [tamper.slice(0, dot), tamper.slice(dot + 1)] : [null, null];
    const target = before.get(tamper);
    if (!ts || !tt || !schemas.includes(ts) || !target) {
      fail(`Tamper target "${tamper}" is not a row-compared application table — a tamper the comparison cannot see proves nothing. One of: ${[...before.keys()].slice(0, 8).join(', ')}…`);
    }
    if (target.count === 0) {
      fail(`Tamper target ${tamper} has no rows — deleting nothing detects nothing. Pick a populated table.`);
    }
    console.log(`\n  ⚠ TAMPER: deleting one row from ${tamper} in the scratch database — this run MUST fail`);
    try {
      oneShot(container, SCRATCH, `delete from "${ts}"."${tt}" where ctid in (select ctid from "${ts}"."${tt}" limit 1);`);
    } catch (e) {
      fail(`Tamper target ${tamper} refused the delete. If the refusal is a no-delete trigger, the restored copy's ` +
        `triggers are alive — good, but the red proof needs a deletable table; pick another.\n${e.stderr ?? e.message}`);
    }
  }

  // ── 3. compare — counts AND contents ────────────────────────────────────
  console.log('\n3. Compare — the restored database against what was dumped');
  const after = parseInventory(oneShot(container, SCRATCH, INVENTORY_SQL(schemas)).split('\n').filter(Boolean));
  const scratchTables = oneShot(container, SCRATCH, TOTAL_TABLES_SQL);

  if (scratchTables === sourceTables) ok(`structural: ${scratchTables} tables restored across all schemas`);
  else bad(`structural: source had ${sourceTables} tables at the snapshot, restore has ${scratchTables}`);

  if (after.size === before.size) ok(`application tables: ${after.size} of ${before.size} present`);
  else bad(`application tables: ${after.size} restored, expected ${before.size}`);

  let rows = 0; let mismatches = 0;
  for (const [table, { count, checksum }] of before) {
    const got = after.get(table);
    rows += count;
    if (!got) { mismatches += 1; bad(`${table}: dumped ${count} rows, restored nothing`); continue; }
    if (got.count !== count) { mismatches += 1; bad(`${table}: dumped ${count} rows, restored ${got.count}`); continue; }
    if (got.checksum !== checksum) { mismatches += 1; bad(`${table}: ${count} rows restored but the contents differ`); }
  }
  if (mismatches === 0) ok(`row counts and contents: every application table matches exactly — ${rows} rows, checksummed`);

  if (tamper && failures === 0) {
    bad(`TAMPER WENT UNDETECTED: a row was deleted from ${tamper} and every check still passed — the detector is decorative.`);
  }
} catch (e) {
  if (e.message !== 'rehearsal aborted') {
    console.error(`\x1b[31mThe rehearsal itself failed — not a verdict on the backup:\x1b[0m ${e.message.split('\n')[0]}`);
    if (e.stderr) console.error(String(e.stderr).trim());
    process.exitCode = 1;
  }
} finally {
  session?.end();
  // ── 4. leave nothing behind ──────────────────────────────────────────────
  try {
    oneShot(container, 'postgres', `drop database if exists ${SCRATCH} with (force);`);
    if (failures === 0 && process.exitCode !== 1) docker(['exec', container, 'rm', '-f', DUMP]);
    else console.log(`  dump kept for inspection: ${DUMP} inside ${container}`);
  } catch {
    console.error(`  cleanup incomplete — drop database ${SCRATCH} and remove ${DUMP} in ${container} by hand.`);
  }
}

if (failures > 0) {
  console.error(`\n\x1b[31m✖ ${failures} failure(s) — the backup did not restore completely.\x1b[0m`);
  process.exitCode = 1;
} else if (process.exitCode !== 1) {
  console.log('\n\x1b[32m✔ The dump alone rebuilt the database in the same cluster, row for row — counts and contents. Recovery is rehearsed — locally.\x1b[0m');
}
