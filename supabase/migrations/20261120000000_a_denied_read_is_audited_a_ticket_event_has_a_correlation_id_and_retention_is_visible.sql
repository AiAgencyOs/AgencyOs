-- ═════════════════════════════════════════════════════════════════
-- Phase 8A gaps log 1 (part 1): security, audit and governance rows of the 8A traceability that a database can close without any external dependency.
--
--   P8-SEC-004  a ticket event had actor, states, note and evidence but no correlation id. Every event now carries one: all the events one request writes share it
--               (a transaction-local id), so a reviewer can say which rows were written by the same act. Rows written before this migration keep NULL: nothing is
--               back-filled, because inventing a correlation for history would be a false statement about it.
--   E2E-13      a cross-tenant read was DENIED (RLS returns nothing) but the denial was not audited. `projects.guard_phase_eight_project` is the check a page calls
--               before it renders a Phase 8 project: if the caller's organization (or, for a client, the client's own portal) does not own the project it records a
--               denial in the CALLER's own organization and answers 'denied'. It answers the same way for a project that does not exist and a project in another
--               tenant, and it never reads or reveals the other tenant's row. Admins read the log; nobody can edit or delete it.
--   P8-SEC-006  `projects.phase_eight_retention_status` states, for every Phase 8 record set, the Admin-set retention class that covers it (the Phase 7 policy table
--               projects.p7b_retention_policies), whether a policy exists, and how many rows are held and since when. It deletes NOTHING and decides nothing: where no
--               record class covers a data set (the communication ledger, client feedback) it says so instead of pretending a class does.
-- ═════════════════════════════════════════════════════════════════

-- ── shared wiring (dropped at the end of the LAST 20261120 migration, which still needs them) ──────────────────────────────────────────

create or replace function projects.p8g_wire_table(p_table text, p_mutable boolean, p_history boolean, p_admin_only boolean default false)
returns void language plpgsql set search_path = '' as $$
begin
  execute format('alter table projects.%I enable row level security', p_table);
  execute format('drop policy if exists %I on projects.%I', p_table || '_read', p_table);
  if p_admin_only then
    execute format($p$create policy %I on projects.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()) and (select core.is_admin()))$p$, p_table || '_read', p_table);
  else
    execute format($p$create policy %I on projects.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))$p$, p_table || '_read', p_table);
  end if;
  execute format('revoke all on projects.%I from public, anon', p_table);
  execute format('revoke insert, update, delete on projects.%I from authenticated', p_table);
  execute format('grant select on projects.%I to authenticated', p_table);
  execute format('grant all on projects.%I to service_role', p_table);
  execute format('drop trigger if exists %I on projects.%I', 'freeze_org_' || p_table, p_table);
  execute format('create trigger %I before update of organization_id on projects.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || p_table, p_table);
  if p_mutable then
    execute format('drop trigger if exists %I on projects.%I', p_table || '_updated_at', p_table);
    execute format('create trigger %I before update on projects.%I for each row execute function core.set_updated_at()', p_table || '_updated_at', p_table);
    execute format('drop trigger if exists %I on projects.%I', p_table || '_p8_guard', p_table);
    execute format('create trigger %I before update or delete on projects.%I for each row execute function projects.p8_guard_updates()', p_table || '_p8_guard', p_table);
  end if;
  if p_history then
    execute format('drop trigger if exists %I on projects.%I', p_table || '_append_only', p_table);
    execute format('create trigger %I before update or delete on projects.%I for each row execute function projects.p8_append_only()', p_table || '_append_only', p_table);
  end if;
end $$;

create or replace function projects.p8g_wire_parent(p_table text, p_col text, p_parent text)
returns void language plpgsql set search_path = '' as $$
begin
  execute format('drop trigger if exists %I on projects.%I', 'org_match_' || p_table || '_' || p_col, p_table);
  execute format('create trigger %I before insert or update on projects.%I for each row execute function core.enforce_parent_org(%L, %L)',
                 'org_match_' || p_table || '_' || p_col, p_table, p_col, p_parent);
end $$;

-- ── the correlation id: one per request (transaction), shared by every row that request writes ──────────────────────────────────────────────────

create or replace function projects.p8g_correlation()
returns uuid language plpgsql volatile set search_path = '' as $$
declare v text := nullif(current_setting('projects.p8_correlation', true), '');
begin
  if v is null then v := gen_random_uuid()::text; perform set_config('projects.p8_correlation', v, true); end if;
  return v::uuid;
end $$;
revoke all on function projects.p8g_correlation() from public, anon;
grant execute on function projects.p8g_correlation() to authenticated, service_role;

alter table projects.support_ticket_events add column if not exists correlation_id uuid;
comment on column projects.support_ticket_events.correlation_id is 'Shared by every event one request wrote (P8-SEC-004). NULL on rows written before this column existed: history is not back-filled.';
create index if not exists support_ticket_events_correlation_idx on projects.support_ticket_events (correlation_id) where correlation_id is not null;

create or replace function projects.p8g_stamp_correlation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.correlation_id is null then new.correlation_id := projects.p8g_correlation(); end if;
  return new;
end $$;
drop trigger if exists support_ticket_events_correlation on projects.support_ticket_events;
create trigger support_ticket_events_correlation before insert on projects.support_ticket_events for each row execute function projects.p8g_stamp_correlation();

-- ── the denial log ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

create table if not exists projects.phase_eight_access_denials (
  id               uuid primary key default gen_random_uuid(),
  seq              bigint generated always as identity,
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  actor_user       uuid references core.users(id) on delete set null,
  actor_kind       text not null check (actor_kind in ('staff', 'client')),
  surface          text not null check (surface in ('project_workspace', 'support_tickets', 'customer_360', 'communication_ledger', 'value_report', 'opportunity', 'check_in', 'feedback', 'knowledge_base', 'other')),
  subject_id       uuid,
  reason           text not null check (reason in ('not_in_your_organization_or_does_not_exist', 'not_your_clients_project')),
  correlation_id   uuid not null,
  created_at       timestamptz not null default clock_timestamp()
);
create index if not exists phase_eight_access_denials_org_idx on projects.phase_eight_access_denials (organization_id, seq desc);
comment on table projects.phase_eight_access_denials is
  'APPEND-ONLY. A caller asked for a Phase 8 subject their organization (or, for a client, their own portal) does not own. Stored in the CALLER''s organization; the row never says whether the subject exists elsewhere. Readable by Admins only.';

do $$ begin
  perform projects.p8g_wire_table('phase_eight_access_denials', false, true, true);
end $$;

-- The check a page runs before rendering a Phase 8 project. SECURITY DEFINER so that the denial can be written; it reads only the caller's OWN organization
-- (or the client's own portal), so a foreign project is simply "not there", exactly as RLS shows it, and no foreign row is read.
create or replace function projects.guard_phase_eight_project(p_project_id uuid, p_surface text default 'project_workspace')
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_client boolean := coalesce((select core.is_client()), false);
  v_ok boolean; v_surface text := coalesce(p_surface, 'other'); v_reason text;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if v_surface not in ('project_workspace', 'support_tickets', 'customer_360', 'communication_ledger', 'value_report', 'opportunity', 'check_in', 'feedback', 'knowledge_base', 'other') then v_surface := 'other'; end if;
  if v_client then
    v_ok := p_project_id is not null and (select pp.id from projects.p7b_portal_project(p_project_id) pp) is not null;
    v_reason := 'not_your_clients_project';
  else
    v_ok := p_project_id is not null and coalesce((select core.is_internal()), false)
            and exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null);
    v_reason := 'not_in_your_organization_or_does_not_exist';
  end if;
  if v_ok then return query select 'allowed'::text; return; end if;
  -- the same caller asking for the same subject again inside a minute is one denial, so a refreshing page cannot flood the log
  if not exists (select 1 from projects.phase_eight_access_denials d
                  where d.organization_id = v_org and d.actor_user = v_actor and d.surface = v_surface and d.subject_id is not distinct from p_project_id and d.created_at > clock_timestamp() - interval '1 minute') then
    insert into projects.phase_eight_access_denials (organization_id, actor_user, actor_kind, surface, subject_id, reason, correlation_id)
    values (v_org, v_actor, case when v_client then 'client' else 'staff' end, v_surface, p_project_id, v_reason, projects.p8g_correlation());
  end if;
  return query select 'denied'::text;
end $$;
revoke all on function projects.guard_phase_eight_project(uuid, text) from public, anon, service_role;
grant execute on function projects.guard_phase_eight_project(uuid, text) to authenticated;

-- ── retention visibility (reads; deletes nothing) ──────────────────────────────────────────────────────────────────────────────────────────────

create or replace function projects.phase_eight_retention_status()
returns table (data_set text, record_class text, policy_set boolean, policy_version int, indefinite boolean, retention_days int, rows_held bigint, oldest_at timestamptz)
language plpgsql stable security invoker set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  return query
  with held(data_set, record_class, n, oldest) as (
    select 'support_tickets'::text, 'support_warranty_records'::text, (select count(*) from projects.support_tickets x where x.organization_id = v_org), (select min(x.raised_at) from projects.support_tickets x where x.organization_id = v_org)
    union all select 'support_ticket_events', 'support_warranty_records', (select count(*) from projects.support_ticket_events x where x.organization_id = v_org), (select min(x.at) from projects.support_ticket_events x where x.organization_id = v_org)
    union all select 'support_reply_drafts', 'support_warranty_records', (select count(*) from projects.support_reply_drafts x where x.organization_id = v_org), (select min(x.created_at) from projects.support_reply_drafts x where x.organization_id = v_org)
    union all select 'customer_health_snapshots', 'support_warranty_records', (select count(*) from projects.customer_health_snapshots x where x.organization_id = v_org), (select min(x.computed_at) from projects.customer_health_snapshots x where x.organization_id = v_org)
    union all select 'cs_check_ins', 'support_warranty_records', (select count(*) from projects.cs_check_ins x where x.organization_id = v_org), (select min(x.created_at) from projects.cs_check_ins x where x.organization_id = v_org)
    union all select 'recovery_plans', 'support_warranty_records', (select count(*) from projects.recovery_plans x where x.organization_id = v_org), (select min(x.created_at) from projects.recovery_plans x where x.organization_id = v_org)
    union all select 'phase_eight_opportunities', null::text, (select count(*) from sales.phase_eight_opportunities x where x.organization_id = v_org), (select min(x.created_at) from sales.phase_eight_opportunities x where x.organization_id = v_org)
    union all select 'client_communication_ledger', null::text, (select count(*) from projects.client_communication_ledger x where x.organization_id = v_org), (select min(x.created_at) from projects.client_communication_ledger x where x.organization_id = v_org)
    union all select 'value_report_drafts', null::text, (select count(*) from projects.value_report_drafts x where x.organization_id = v_org), (select min(x.built_at) from projects.value_report_drafts x where x.organization_id = v_org)
    union all select 'phase_eight_access_denials', null::text, (select count(*) from projects.phase_eight_access_denials x where x.organization_id = v_org and (select core.is_admin())), (select min(x.created_at) from projects.phase_eight_access_denials x where x.organization_id = v_org and (select core.is_admin()))
  )
  select h.data_set, h.record_class, p.id is not null, p.version, p.indefinite, p.retention_days, h.n, h.oldest
    from held h
    left join lateral (select rp.id, rp.version, rp.indefinite, rp.retention_days from projects.p7b_retention_policies rp
                        where rp.organization_id = v_org and rp.record_class = h.record_class order by rp.version desc limit 1) p on true
   order by h.data_set;
end $$;
revoke all on function projects.phase_eight_retention_status() from public, anon, service_role;
grant execute on function projects.phase_eight_retention_status() to authenticated;
comment on function projects.phase_eight_retention_status() is
  'Read-only. For each Phase 8 data set: the Admin-set record class that covers it (null = no class covers it, an Admin decision), whether a policy exists, and rows held with the oldest timestamp. It deletes nothing.';

notify pgrst, 'reload schema';
