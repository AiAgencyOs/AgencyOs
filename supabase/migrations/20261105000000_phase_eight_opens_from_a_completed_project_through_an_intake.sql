-- ═════════════════════════════════════════════════════════════════
-- Phase 8A (Customer Success, Support, Upsell, post-launch Sales): the workspace and its entry gate.
--
-- Phase 8 begins when a project has been COMPLETED and the relationship moves into support, maintenance, health, renewal and legitimate
-- expansion. The completed project stays historical truth: nothing in this file (or the three that follow) ever writes projects.projects,
-- projects.completion_records, projects.handovers or any scope version. New work is a maintenance item, a change request or a new project.
--
-- The entry gate reads ONE table this phase owns, projects.phase_eight_intake. A service-role door fills it from whatever completion facts
-- exist today (completion_records, handovers, release verifications, the approved Phase 6 candidate, invoices). Phase 7 is building a frozen
-- completion handoff in parallel; when it lands, ONLY projects.p8_build_intake changes (read its snapshot there and set source =
-- 'phase_seven_handoff', phase_seven_handoff_ref = its id). The gate and the workspace never read a Phase 7 table.
--
-- What is deliberately not here:
--   * no amount, price, quote or discount column anywhere in Phase 8A (ADM-22: every price is quoted per client by a person)
--   * no stored health score or status: health is a derived read (migration 20261105200000)
--   * no automatic send to a client: replies are drafts a person sends, check-ins are records a person completes
-- ═════════════════════════════════════════════════════════════════

-- ── shared wiring ───────────────────────────────────────────────────────────

-- A direct write to a Phase 8 record is refused unless a door announced itself in this transaction.
create or replace function projects.p8_guard_updates()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    -- a cascade from a deleted project or organization runs one trigger level down; a direct DELETE does not
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'a % record is history and is never deleted', tg_table_name using errcode = 'restrict_violation';
  end if;
  if coalesce(current_setting('projects.p8_sanctioned', true), '') <> 'on' then
    raise exception 'a % record is changed through its door, never by a direct write', tg_table_name using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

create or replace function projects.p8_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  raise exception 'a % record is history and is never edited or deleted', tg_table_name using errcode = 'restrict_violation';
end $$;

-- Row security, internal-only read, grants, tenancy freeze: the same block on every Phase 8A table.
create or replace function projects.p8_wire_table(p_schema text, p_table text, p_mutable boolean, p_history boolean)
returns void language plpgsql set search_path = '' as $$
begin
  execute format('alter table %I.%I enable row level security', p_schema, p_table);
  execute format('drop policy if exists %I on %I.%I', p_table || '_read', p_schema, p_table);
  execute format($p$create policy %I on %I.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))$p$,
                 p_table || '_read', p_schema, p_table);
  execute format('revoke all on %I.%I from public, anon', p_schema, p_table);
  execute format('revoke insert, update, delete on %I.%I from authenticated', p_schema, p_table);
  execute format('grant select on %I.%I to authenticated', p_schema, p_table);
  execute format('grant all on %I.%I to service_role', p_schema, p_table);
  execute format('drop trigger if exists %I on %I.%I', 'freeze_org_' || p_table, p_schema, p_table);
  execute format('create trigger %I before update of organization_id on %I.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || p_table, p_schema, p_table);
  if p_mutable then
    execute format('drop trigger if exists %I on %I.%I', p_table || '_updated_at', p_schema, p_table);
    execute format('create trigger %I before update on %I.%I for each row execute function core.set_updated_at()', p_table || '_updated_at', p_schema, p_table);
    execute format('drop trigger if exists %I on %I.%I', p_table || '_p8_guard', p_schema, p_table);
    execute format('create trigger %I before update or delete on %I.%I for each row execute function projects.p8_guard_updates()', p_table || '_p8_guard', p_schema, p_table);
  end if;
  if p_history then
    execute format('drop trigger if exists %I on %I.%I', p_table || '_append_only', p_schema, p_table);
    execute format('create trigger %I before update or delete on %I.%I for each row execute function projects.p8_append_only()', p_table || '_append_only', p_schema, p_table);
  end if;
end $$;
revoke all on function projects.p8_wire_table(text, text, boolean, boolean) from public, anon, authenticated;

create or replace function projects.p8_wire_parent(p_schema text, p_table text, p_col text, p_parent text)
returns void language plpgsql set search_path = '' as $$
begin
  execute format('drop trigger if exists %I on %I.%I', 'org_match_' || p_table || '_' || p_col, p_schema, p_table);
  execute format('create trigger %I before insert or update on %I.%I for each row execute function core.enforce_parent_org(%L, %L)',
                 'org_match_' || p_table || '_' || p_col, p_schema, p_table, p_col, p_parent);
end $$;
revoke all on function projects.p8_wire_parent(text, text, text, text) from public, anon, authenticated;

-- ── settings: the numbers a person confirms (defaults are a starting point, not a business decision) ──

create table if not exists projects.phase_eight_settings (
  organization_id uuid not null references core.organizations(id) on delete cascade,
  key             text not null check (key ~ '^[a-z0-9_]+$'),
  int_value       int not null,
  set_by          uuid references core.users(id) on delete set null,
  set_at          timestamptz not null default now(),
  primary key (organization_id, key)
);
comment on table projects.phase_eight_settings is
  'Phase 8A thresholds (SLA hours, health thresholds, renewal window, check-in gap). A missing row means the documented DEFAULT in projects.p8_setting, which is a starting point the owner confirms (docs/phase-8a-manual-actions.md), not a business rule.';

create or replace function projects.p8_setting(p_org uuid, p_key text)
returns int language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select s.int_value from projects.phase_eight_settings s where s.organization_id = p_org and s.key = p_key),
    case p_key
      when 'sla_response_hours_p1' then 4    when 'sla_response_hours_p2' then 8    when 'sla_response_hours_p3' then 24   when 'sla_response_hours_p4' then 72
      when 'sla_resolution_hours_p1' then 24 when 'sla_resolution_hours_p2' then 72 when 'sla_resolution_hours_p3' then 168 when 'sla_resolution_hours_p4' then 336
      when 'health_open_tickets_watch' then 3
      when 'health_open_tickets_at_risk' then 6
      when 'health_sla_breaches_at_risk' then 2
      when 'health_overdue_invoices_at_risk' then 1
      when 'renewal_window_days' then 45
      when 'checkin_post_handover_days' then 7
      when 'checkin_min_gap_days' then 14
    end);
$$;
revoke all on function projects.p8_setting(uuid, text) from public, anon;
grant execute on function projects.p8_setting(uuid, text) to authenticated, service_role;

create or replace function projects.set_phase_eight_setting(p_key text, p_value int)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_min int; v_max int;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  select case when p_key ~ '^sla_response_hours_p[1-4]$' then 1 when p_key ~ '^sla_resolution_hours_p[1-4]$' then 1
              when p_key in ('health_open_tickets_watch', 'health_open_tickets_at_risk', 'health_sla_breaches_at_risk', 'health_overdue_invoices_at_risk') then 1
              when p_key = 'renewal_window_days' then 7 when p_key = 'checkin_post_handover_days' then 1 when p_key = 'checkin_min_gap_days' then 1 end,
         case when p_key ~ '^sla_response_hours_p[1-4]$' then 720 when p_key ~ '^sla_resolution_hours_p[1-4]$' then 2160
              when p_key in ('health_open_tickets_watch', 'health_open_tickets_at_risk') then 200 when p_key in ('health_sla_breaches_at_risk', 'health_overdue_invoices_at_risk') then 50
              when p_key = 'renewal_window_days' then 180 when p_key = 'checkin_post_handover_days' then 60 when p_key = 'checkin_min_gap_days' then 180 end
    into v_min, v_max;
  if v_min is null then return query select 'unknown_key'::text; return; end if;
  if p_value is null or p_value < v_min or p_value > v_max then return query select 'out_of_range'::text; return; end if;
  insert into projects.phase_eight_settings (organization_id, key, int_value, set_by, set_at) values (v_org, p_key, p_value, v_actor, now())
  on conflict (organization_id, key) do update set int_value = excluded.int_value, set_by = excluded.set_by, set_at = excluded.set_at;
  perform core.record_audit(v_org, 'phase_eight.setting_set', 'phase_eight_setting', null, null, jsonb_build_object('key', p_key, 'value', p_value));
  return query select 'set'::text;
end $$;
revoke all on function projects.set_phase_eight_setting(text, int) from public, anon, service_role;
grant execute on function projects.set_phase_eight_setting(text, int) to authenticated;

-- ── the intake: what the completed project hands to Customer Success ────────

create table if not exists projects.phase_eight_intake (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references core.organizations(id) on delete cascade,
  project_id               uuid not null references projects.projects(id) on delete cascade,
  client_account_id        uuid not null references core.client_accounts(id) on delete restrict,
  -- where the facts came from: today the completion record; Phase 7's frozen snapshot replaces the reader in p8_build_intake, never the gate
  source                   text not null default 'completion_record' check (source in ('completion_record', 'phase_seven_handoff')),
  completion_record_id     uuid references projects.completion_records(id) on delete restrict,
  phase_seven_handoff_ref  text,
  handover_id              uuid references projects.handovers(id) on delete set null,
  scope_version_id         uuid references projects.scope_versions(id) on delete restrict,
  build_ref                text,
  gates                    jsonb not null default '[]'::jsonb check (jsonb_typeof(gates) = 'array'),
  blockers                 jsonb not null default '[]'::jsonb check (jsonb_typeof(blockers) = 'array'),
  package                  jsonb not null default '{}'::jsonb check (jsonb_typeof(package) = 'object'),
  status                   text not null default 'incomplete' check (status in ('incomplete', 'ready')),
  refreshed_at             timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (project_id),
  check (status <> 'ready' or jsonb_array_length(blockers) = 0)
);
comment on table projects.phase_eight_intake is
  'P8-GATE-001..008 evaluated for one completed project, with the Customer Success handoff package. Filled only by projects.fill_phase_eight_intake (service role) and refreshed until the workspace starts, then frozen. status = ready only with no blocker. A gate waived by the owner is recorded in phase_eight_gate_waivers and shown as waived.';

create table if not exists projects.phase_eight_gate_waivers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  gate_id          text not null check (gate_id in ('P8-GATE-002', 'P8-GATE-003', 'P8-GATE-004', 'P8-GATE-005', 'P8-GATE-007', 'P8-GATE-008')),
  reason           text not null check (length(btrim(reason)) >= 10),
  waived_by        uuid not null references core.users(id) on delete restrict,
  waived_at        timestamptz not null default now(),
  unique (project_id, gate_id)
);
comment on table projects.phase_eight_gate_waivers is 'An approved exception to a Phase 8 start gate: only the owner, with a reason, append-only. P8-GATE-001 (completion) and P8-GATE-006 (warranty, decided at start) cannot be waived.';

create table if not exists projects.phase_eight (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  project_id          uuid not null references projects.projects(id) on delete cascade,
  client_account_id   uuid not null references core.client_accounts(id) on delete restrict,
  intake_id           uuid not null references projects.phase_eight_intake(id) on delete restrict,
  state               text not null default 'active' check (state in ('active', 'paused', 'closed')),
  state_reason        text,
  cs_owner            uuid references core.users(id) on delete set null,
  warranty_starts_on  date,
  warranty_ends_on    date,
  warranty_coverage   text,
  warranty_exclusions text,
  no_warranty_reason  text,
  started_by          uuid references core.users(id) on delete set null,
  started_at          timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (project_id),
  -- P8-GATE-006: a warranty window with its coverage and exclusions, or an explicit decision that there is none (and why)
  constraint phase_eight_warranty_is_defined check (
    (warranty_starts_on is not null and warranty_ends_on is not null and warranty_ends_on >= warranty_starts_on
       and length(btrim(coalesce(warranty_coverage, ''))) > 0 and length(btrim(coalesce(warranty_exclusions, ''))) > 0)
    or (warranty_starts_on is null and warranty_ends_on is null and length(btrim(coalesce(no_warranty_reason, ''))) > 0)),
  check (state = 'active' or length(btrim(coalesce(state_reason, ''))) > 0)
);
comment on table projects.phase_eight is 'The Phase 8 workspace of one completed project: the warranty window a person defined, the Customer Success owner and whether automation (sweeps, check-ins) is running. Started once, from a ready intake.';

do $$
declare r record;
begin
  for r in select * from (values
    ('phase_eight_intake', 'project_id', 'projects.projects'), ('phase_eight_intake', 'completion_record_id', 'projects.completion_records'),
    ('phase_eight_intake', 'client_account_id', 'core.client_accounts'), ('phase_eight', 'client_account_id', 'core.client_accounts'),
    ('phase_eight_intake', 'handover_id', 'projects.handovers'), ('phase_eight_intake', 'scope_version_id', 'projects.scope_versions'),
    ('phase_eight_gate_waivers', 'project_id', 'projects.projects'),
    ('phase_eight', 'project_id', 'projects.projects'), ('phase_eight', 'intake_id', 'projects.phase_eight_intake')
  ) as t(tbl, col, parent) loop
    perform projects.p8_wire_parent('projects', r.tbl, r.col, r.parent);
  end loop;
  perform projects.p8_wire_table('projects', 'phase_eight_settings', false, false);
  perform projects.p8_wire_table('projects', 'phase_eight_intake', true, false);
  perform projects.p8_wire_table('projects', 'phase_eight_gate_waivers', false, true);
  perform projects.p8_wire_table('projects', 'phase_eight', true, false);
end $$;

insert into core.event_types (type, description, canonical) values
  ('project.phase_eight_started', 'Phase 8 (Customer Success) started for a completed project: the intake was ready, a person defined the warranty window, and the workspace opened. Emitted once.', true)
on conflict (type) do nothing;

-- The evaluation. No caller check here: only the two doors below reach it (execute is revoked from everyone else).
create or replace function projects.p8_build_intake(p_organization_id uuid, p_project_id uuid)
returns table (outcome text, intake_id uuid, intake_status text)
language plpgsql security definer set search_path = '' as $$
declare
  v_project projects.projects; v_c projects.completion_records; v_hand projects.handovers;
  v_build text; v_has_p6 boolean; v_verified boolean; v_unpaid int; v_contacts uuid[]; v_client text;
  v_gates jsonb := '[]'::jsonb; v_blockers jsonb := '[]'::jsonb; v_pkg jsonb; v_status text; v_id uuid; g record; v_w text;
begin
  select * into v_project from projects.projects p where p.id = p_project_id and p.organization_id = p_organization_id and p.deleted_at is null;
  if v_project.id is null then return query select 'unknown_project'::text, null::uuid, null::text; return; end if;
  if v_project.status <> 'completed' then return query select 'not_completed'::text, null::uuid, null::text; return; end if;
  select i.id into v_id from projects.phase_eight_intake i where i.project_id = v_project.id;
  if exists (select 1 from projects.phase_eight w where w.project_id = v_project.id) then
    return query select 'already_started'::text, v_id, (select i.status from projects.phase_eight_intake i where i.id = v_id); return;
  end if;

  select * into v_c from projects.completion_records c where c.project_id = v_project.id;
  select * into v_hand from projects.handovers h where h.project_id = v_project.id and h.status = 'accepted' order by h.accepted_at desc nulls last limit 1;
  select rc.commit_ref into v_build from qa.release_candidates rc where rc.project_id = v_project.id and rc.status = 'approved' limit 1;
  v_has_p6 := exists (select 1 from projects.phase_six s where s.project_id = v_project.id);
  v_verified := exists (select 1 from projects.release_verifications rv where rv.project_id = v_project.id and rv.environment = 'production' and rv.outcome = 'passed');
  select count(*) into v_unpaid from finance.invoices i where i.project_id = v_project.id and i.status in ('issued', 'partially_paid', 'overdue');
  select coalesce(array_agg(ct.id order by ct.created_at), '{}') into v_contacts from crm.contacts ct where ct.client_account_id = v_project.client_account_id and ct.organization_id = p_organization_id;
  select ca.name into v_client from core.client_accounts ca where ca.id = v_project.client_account_id;

  for g in select * from (values
    ('P8-GATE-001', 'a COMPLETED project with a completion record and, for a pipeline project, the approved release build',
       v_c.id is not null and (v_build is not null or not v_has_p6),
       case when v_c.id is null then 'no completion record exists' when v_build is null and v_has_p6 then 'no Admin-approved release candidate is recorded' else 'completed ' || v_c.completed_at::date::text || coalesce(', build ' || v_build, '') end),
    ('P8-GATE-002', 'production deployment and a passed live/smoke verification', v_verified,
       case when v_verified then 'a passed production verification is recorded' else 'no passed production verification is recorded (projects.release_verifications)' end),
    ('P8-GATE-003', 'client handover accepted', v_hand.id is not null,
       case when v_hand.id is not null then 'handover accepted ' || v_hand.accepted_at::date::text else 'no accepted handover' end),
    ('P8-GATE-004', 'final payment verified, or an approved exception', v_c.id is not null and v_c.verified_minor >= v_c.invoiced_minor and v_unpaid = 0,
       case when v_c.id is null then 'no completion record' when v_unpaid > 0 then v_unpaid || ' invoice(s) still outstanding' when v_c.verified_minor < v_c.invoiced_minor then 'verified payments are below the invoiced total' else 'every invoice is verified paid' end),
    ('P8-GATE-005', 'approved scope version locked and readable', v_c.scope_version_id is not null,
       case when v_c.scope_version_id is not null then 'scope version ' || coalesce(v_c.scope_version::text, '?') else 'no scope version is recorded on the completion' end),
    ('P8-GATE-007', 'known limitations recorded (a person writes "none" if there are none)', length(btrim(coalesce(v_c.known_limitations, ''))) > 0,
       case when length(btrim(coalesce(v_c.known_limitations, ''))) > 0 then 'recorded' else 'a person has not recorded known limitations' end),
    ('P8-GATE-008', 'Customer Success handoff package: client, project, at least one contact, production version', coalesce(array_length(v_contacts, 1), 0) > 0 and v_c.id is not null,
       case when coalesce(array_length(v_contacts, 1), 0) = 0 then 'the client has no contact on record' else coalesce(array_length(v_contacts, 1), 0) || ' contact(s) on record' end)
  ) as t(id, label, ok, detail) loop
    v_w := null;
    if not g.ok then
      select w.reason into v_w from projects.phase_eight_gate_waivers w where w.project_id = v_project.id and w.gate_id = g.id;
    end if;
    v_gates := v_gates || jsonb_build_array(jsonb_build_object('id', g.id, 'label', g.label, 'at', 'intake', 'passed', g.ok or v_w is not null, 'waived', v_w is not null,
                           'detail', case when v_w is not null then 'waived by the owner: ' || v_w else g.detail end));
    if not g.ok and v_w is null then v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('id', g.id, 'detail', g.detail)); end if;
  end loop;
  v_gates := v_gates || jsonb_build_array(jsonb_build_object('id', 'P8-GATE-006', 'label', 'warranty/free-support window, coverage and exclusions defined', 'at', 'start', 'passed', false, 'waived', false,
                         'detail', 'a person defines the window (or records that there is none) when Phase 8 is started'));

  v_pkg := jsonb_build_object('clientAccountId', v_project.client_account_id, 'clientName', v_client, 'contactIds', to_jsonb(v_contacts),
    'buildRef', v_build, 'scopeVersionId', v_c.scope_version_id, 'scopeVersion', v_c.scope_version, 'completedAt', v_c.completed_at,
    'knownLimitations', v_c.known_limitations, 'warrantyNote', v_c.warranty_note,
    'openMaintenanceItems', (select count(*) from projects.maintenance_items m where m.project_id = v_project.id and m.status in ('open', 'in_progress')),
    'openDefects', (select count(*) from qa.defects d where d.project_id = v_project.id and d.status = 'open'),
    'preferences', 'none recorded: AgencyOS holds WhatsApp consent per contact (crm.communication_consent) and no other channel or language preference');
  v_status := case when jsonb_array_length(v_blockers) = 0 then 'ready' else 'incomplete' end;

  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into projects.phase_eight_intake (organization_id, project_id, client_account_id, source, completion_record_id, handover_id, scope_version_id, build_ref, gates, blockers, package, status, refreshed_at)
  values (p_organization_id, v_project.id, v_project.client_account_id, 'completion_record', v_c.id, v_hand.id, v_c.scope_version_id, v_build, v_gates, v_blockers, v_pkg, v_status, now())
  on conflict (project_id) do update set completion_record_id = excluded.completion_record_id, handover_id = excluded.handover_id, scope_version_id = excluded.scope_version_id,
    build_ref = excluded.build_ref, gates = excluded.gates, blockers = excluded.blockers, package = excluded.package, status = excluded.status, refreshed_at = now()
  returning id into v_id;
  return query select case when v_status = 'ready' then 'ready' else 'incomplete' end::text, v_id, v_status;
end $$;
revoke all on function projects.p8_build_intake(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function projects.fill_phase_eight_intake(p_organization_id uuid, p_project_id uuid)
returns table (outcome text, intake_id uuid, intake_status text)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_service'::text, null::uuid, null::text; return; end if;
  return query select * from projects.p8_build_intake(p_organization_id, p_project_id);
end $$;
revoke all on function projects.fill_phase_eight_intake(uuid, uuid) from public, anon, authenticated;
grant execute on function projects.fill_phase_eight_intake(uuid, uuid) to service_role;

create or replace function projects.waive_phase_eight_gate(p_project_id uuid, p_gate_id text, p_reason text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_r record;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_owner()), false) then return query select 'not_authorized'::text; return; end if;
  if p_gate_id not in ('P8-GATE-002', 'P8-GATE-003', 'P8-GATE-004', 'P8-GATE-005', 'P8-GATE-007', 'P8-GATE-008') then return query select 'not_waivable'::text; return; end if;
  if v_reason is null or length(v_reason) < 10 then return query select 'reason_required'::text; return; end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org and p.status = 'completed') then return query select 'not_found'::text; return; end if;
  if exists (select 1 from projects.phase_eight w where w.project_id = p_project_id) then return query select 'already_started'::text; return; end if;
  insert into projects.phase_eight_gate_waivers (organization_id, project_id, gate_id, reason, waived_by) values (v_org, p_project_id, p_gate_id, v_reason, v_actor)
  on conflict (project_id, gate_id) do nothing;
  perform core.record_audit(v_org, 'phase_eight.gate_waived', 'project', p_project_id, null, jsonb_build_object('gate', p_gate_id, 'reason', v_reason));
  select * into v_r from projects.p8_build_intake(v_org, p_project_id);
  return query select 'waived'::text;
end $$;
revoke all on function projects.waive_phase_eight_gate(uuid, text, text) from public, anon, service_role;
grant execute on function projects.waive_phase_eight_gate(uuid, text, text) to authenticated;

-- ── the start ───────────────────────────────────────────────────────────────

create or replace function projects.start_phase_eight(
  p_project_id uuid, p_warranty_starts_on date default null, p_warranty_ends_on date default null,
  p_warranty_coverage text default null, p_warranty_exclusions text default null, p_no_warranty_reason text default null, p_owner uuid default null)
returns table (outcome text, phase_eight_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_project projects.projects; v_w projects.phase_eight; v_i record; v_owner uuid := coalesce(p_owner, (select auth.uid())); v_new uuid;
  v_cov text := nullif(btrim(coalesce(p_warranty_coverage, '')), ''); v_exc text := nullif(btrim(coalesce(p_warranty_exclusions, '')), ''); v_none text := nullif(btrim(coalesce(p_no_warranty_reason, '')), '');
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_project from projects.projects p where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null;
  if v_project.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  select * into v_w from projects.phase_eight w where w.project_id = p_project_id;
  if v_w.id is not null then return query select 'already_started'::text, v_w.id; return; end if;
  if v_project.status <> 'completed' then return query select 'not_completed'::text, null::uuid; return; end if;

  select * into v_i from projects.p8_build_intake(v_org, p_project_id);
  if v_i.intake_id is null then return query select 'intake_missing'::text, null::uuid; return; end if;
  if v_i.intake_status <> 'ready' then return query select 'intake_not_ready'::text, null::uuid; return; end if;

  if not ((p_warranty_starts_on is not null and p_warranty_ends_on is not null and p_warranty_ends_on >= p_warranty_starts_on and v_cov is not null and v_exc is not null and v_none is null)
          or (p_warranty_starts_on is null and p_warranty_ends_on is null and v_none is not null and v_cov is null and v_exc is null)) then
    return query select 'warranty_required'::text, null::uuid; return;
  end if;
  if not exists (select 1 from core.memberships m where m.organization_id = v_org and m.user_id = v_owner and m.status = 'active' and m.role in ('owner', 'ops_admin', 'delivery_lead', 'member')) then
    return query select 'owner_not_a_member'::text, null::uuid; return;
  end if;

  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into projects.phase_eight (organization_id, project_id, client_account_id, intake_id, cs_owner, warranty_starts_on, warranty_ends_on, warranty_coverage, warranty_exclusions, no_warranty_reason, started_by)
  values (v_org, p_project_id, v_project.client_account_id, v_i.intake_id, v_owner, p_warranty_starts_on, p_warranty_ends_on, v_cov, v_exc, v_none, v_actor)
  returning id into v_new;
  perform core.record_audit(v_org, 'phase_eight.started', 'phase_eight', v_new, null, jsonb_build_object('projectId', p_project_id, 'intakeId', v_i.intake_id, 'warranty', case when v_none is null then 'defined' else 'none' end));
  perform core.emit_event(v_org, 'project.phase_eight_started', 'phase_eight', v_new, jsonb_build_object('projectId', p_project_id));
  return query select 'started'::text, v_new;
end $$;
revoke all on function projects.start_phase_eight(uuid, date, date, text, text, text, uuid) from public, anon, service_role;
grant execute on function projects.start_phase_eight(uuid, date, date, text, text, text, uuid) to authenticated;

create or replace function projects.set_phase_eight_state(p_project_id uuid, p_state text, p_reason text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_w projects.phase_eight; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if p_state not in ('active', 'paused', 'closed') then return query select 'bad_state'::text; return; end if;
  select * into v_w from projects.phase_eight w where w.project_id = p_project_id and w.organization_id = v_org for update;
  if v_w.id is null then return query select 'not_found'::text; return; end if;
  if v_w.state = 'closed' then return query select 'closed'::text; return; end if;
  if p_state <> 'active' and v_reason is null then return query select 'reason_required'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.phase_eight set state = p_state, state_reason = case when p_state = 'active' then null else v_reason end where id = v_w.id;
  perform core.record_audit(v_org, 'phase_eight.state_set', 'phase_eight', v_w.id, jsonb_build_object('state', v_w.state), jsonb_build_object('state', p_state, 'reason', v_reason));
  return query select 'set'::text;
end $$;
revoke all on function projects.set_phase_eight_state(uuid, text, text) from public, anon, service_role;
grant execute on function projects.set_phase_eight_state(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
