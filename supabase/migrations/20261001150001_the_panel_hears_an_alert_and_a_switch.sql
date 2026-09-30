-- ═══════════════════════════════════════════════════════════════════════════
-- The panel hears an alert and a switch.
--
-- Companion to 20261001150000 (stream F-F): the two tables the incident
-- banner listens to join the realtime publication, on the shape
-- 20260929100000 established. Kept in its own file because a publication
-- file names tables and nothing else — tests/realtime-topics.test.ts reads
-- every quoted schema.table in a file that mentions the publication as a
-- table it must find created somewhere.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the panel hears the new tables ─────────────────────────────────────────

do $$
declare
  t text;
  tables constant text[] := array[
    'core.alerts',
    'core.kill_switches'
  ];
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  if (select puballtables from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;

  foreach t in array tables loop
    if to_regclass(t) is null then
      raise exception 'realtime publication: table % does not exist', t;
    end if;
    if not exists (
      select 1
        from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname || '.' || tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %s', t);
    end if;
  end loop;
end $$;

