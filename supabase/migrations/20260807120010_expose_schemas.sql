-- ═══════════════════════════════════════════════════════════════════════════
-- 010 — Expose the module schemas to PostgREST
--
-- PostgREST serves only the schemas on its exposed list. Without this the
-- tables exist but every query fails with PGRST106, which reads like a missing
-- table and wastes an afternoon.
--
-- Doing it in SQL rather than leaving it as a dashboard step means a fresh
-- environment comes up correctly from migrations alone.
--
-- Guarded: altering the `authenticator` role requires elevated privileges that
-- some environments withhold. If it is not permitted we warn and continue —
-- the fallback is Project Settings → API → Exposed schemas.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  target_schemas constant text :=
    'public, graphql_public, core, audit, crm, sales, projects, finance, ai';
begin
  execute format('alter role authenticator set pgrst.db_schemas = %L', target_schemas);
  perform pg_notify('pgrst', 'reload config');
  raise notice 'PostgREST exposed schemas set to: %', target_schemas;
exception
  when insufficient_privilege or undefined_object then
    raise warning
      'Could not set exposed schemas automatically (%). Add them manually: Project Settings -> API -> Exposed schemas.',
      sqlerrm;
end;
$$;
