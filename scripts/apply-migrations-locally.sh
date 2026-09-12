#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Apply every migration to a scratch Postgres on this machine — no Docker, no
# Supabase CLI, no network.
#
# ── why this exists ────────────────────────────────────────────────────────
#
# On 2026-09-11 seven migrations (≈1,900 lines of plpgsql) were written in one
# session with no Postgres reachable. Every unit test of them passed, because
# every unit test matched TEXT with a regular expression. An adversarial
# review then found:
#
#   • a column referenced by the wrong name  (a.status; the column is a.state)
#   • two SECURITY INVOKER functions writing a table whose RLS admits no such
#     write, so no caller on earth could reach their success branch
#   • a tenancy check that refused the service role on every call
#
# All three fail on the FIRST execution. None fails a regex. A regex can say a
# string is present; only Postgres can say the file is a program.
#
# The migrations are deliberately written to apply on a plain Postgres — the
# first one says "no extensions required", the schema-exposure one says "no
# authenticator role: nothing to expose (a plain Postgres, not a Supabase
# project)" — so the platform surface they need is a stub of a few lines:
# an `auth` schema with `auth.users`, `auth.uid()` and `auth.jwt()`, and the
# three roles. This script provides that stub, applies every migration in
# order with ON_ERROR_STOP, applies the seed, and reports.
#
# It does NOT run the live verifiers: those speak PostgREST, which is not
# here. It answers one question — DO THE MIGRATIONS APPLY — and that is the
# question nothing else on this machine could answer.
#
#   scripts/apply-migrations-locally.sh            apply, report, tear down
#   KEEP=1 scripts/apply-migrations-locally.sh     leave the server running for psql
#
# Needs a local Postgres 16+ install (initdb, pg_ctl, psql on PATH or under
# /opt/homebrew/opt/postgresql@16). Uses a unix socket in a temp directory and
# an unused port, so it cannot collide with anything else.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

for candidate in /opt/homebrew/opt/postgresql@17/bin /opt/homebrew/opt/postgresql@16/bin; do
  if [ -x "$candidate/postgres" ]; then export PATH="$candidate:$PATH"; break; fi
done
command -v initdb >/dev/null || { echo "✖ no local Postgres (initdb) found"; exit 2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/agencyos-pg.XXXXXX")"
PORT=55432
DB=agencyos_local
export LC_ALL=C LANG=C

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    echo
    echo "  server left running:  psql -h $WORK -p $PORT -U postgres -d $DB"
    echo "  stop it with:         pg_ctl -D $WORK/data stop"
    return
  fi
  pg_ctl -D "$WORK/data" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "▶ initdb → $WORK/data"
initdb -D "$WORK/data" -U postgres -A trust >/dev/null 2>&1
pg_ctl -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses='' -c log_min_messages=warning" \
       -l "$WORK/postgres.log" start >/dev/null 2>&1
for _ in $(seq 1 30); do
  pg_isready -h "$WORK" -p "$PORT" -U postgres >/dev/null 2>&1 && break
  sleep 0.2
done
psql -h "$WORK" -p "$PORT" -U postgres -d postgres -qc "create database $DB" >/dev/null

PSQL="psql -h $WORK -p $PORT -U postgres -d $DB -v ON_ERROR_STOP=1 -q"

echo "▶ platform stub (auth schema, roles) — the only thing Supabase provides that the migrations assume"
$PSQL <<'SQL'
-- The three request roles PostgREST switches into. NOLOGIN: nothing here
-- connects as them; RLS policies and GRANTs merely need them to exist.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role nologin bypassrls; end if;
  -- The role Supabase Auth runs its access-token hook as. The auth-hook
  -- migration grants execute on core.custom_access_token_hook to it
  -- unconditionally, so it has to exist even though nothing here signs in.
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
end $$;

create schema if not exists auth;
create schema if not exists extensions;
grant usage on schema auth, extensions to anon, authenticated, service_role;

-- What core.users mirrors and the auth hook trigger binds to.
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb,
  created_at         timestamptz not null default now()
);

-- Supabase's real definitions, verbatim in effect: the JWT PostgREST sets as
-- a transaction-local GUC, and the subject claim out of it.
create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(coalesce(
    current_setting('request.jwt.claim.sub', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  ), '')::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select nullif(coalesce(
    current_setting('request.jwt.claim.role', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  ), '')
$$;

grant execute on function auth.jwt(), auth.uid(), auth.role() to anon, authenticated, service_role;
SQL

echo "▶ applying $(ls "$ROOT"/supabase/migrations/*.sql | wc -l | tr -d ' ') migrations in order"
applied=0
for f in "$ROOT"/supabase/migrations/*.sql; do
  name="$(basename "$f")"
  if ! out="$($PSQL -f "$f" 2>&1)"; then
    echo
    echo "✖ FAILED at $name (after $applied applied)"
    echo "$out" | grep -vE "^(NOTICE|psql:.*NOTICE)" | tail -25
    exit 1
  fi
  applied=$((applied + 1))
done
echo "  ✓ $applied/$applied applied"

echo "▶ seed"
$PSQL -f "$ROOT/supabase/seed.sql" >/dev/null
echo "  ✓ seed applied"

echo "▶ sanity"
$PSQL -tA <<'SQL'
select '  tables with RLS: ' || count(*) filter (where c.relrowsecurity) || ' / ' || count(*)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind = 'r' and n.nspname in ('core','audit','crm','sales','projects','finance','ai','approvals','qa');
select '  invoker writes without a policy: ' || count(*) from core.audit_invoker_writes_without_policy();
SQL

echo
echo "✔ every migration applies on a plain Postgres $(postgres --version | grep -oE '[0-9]+\.[0-9]+')"
