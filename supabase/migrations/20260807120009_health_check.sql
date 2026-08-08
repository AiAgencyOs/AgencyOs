-- ═══════════════════════════════════════════════════════════════════════════
-- 009 — public.health_check()
--
-- Upgrades /api/health from its "schema-cache" fallback probe to a genuine
-- database round trip. The route already prefers this function and falls back
-- only when it is absent, so no application change is needed: the probe field
-- flips from "schema-cache" to "rpc" the moment this migration lands.
--
-- Lives in `public` because that schema is exposed to PostgREST by default,
-- so the health check keeps working even if the module schemas are not yet
-- added to the project's exposed-schema list.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.health_check()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', true,
    'server_time', now(),
    'database', current_database()
  );
$$;

comment on function public.health_check() is
  'Liveness probe for /api/health. Executes in Postgres, so a successful reply proves the database is serving queries — not merely that PostgREST is running.';

grant execute on function public.health_check() to anon, authenticated, service_role;
