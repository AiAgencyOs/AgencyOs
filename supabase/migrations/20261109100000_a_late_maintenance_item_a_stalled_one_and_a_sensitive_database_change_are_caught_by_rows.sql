-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 8 (part C), post-launch scheduling and the migration/destructive-change control.
--
--   1. SLA breach sweep. For each live maintenance work item, the priority is derived (the same rule as src/modules/orchestrator/maintenance-route.ts), the
--      resolution target comes from the SLA policy an Admin set (projects.maintenance_sla_policies, none seeded), and a breach is RECORDED once, append-only,
--      and announced. It ESCALATES TO A PERSON: an Admin acknowledges it through a door. No hours are invented: a priority with no policy is skipped and
--      counted, never called late.
--   2. Stall detection. A derived read says why a work item cannot move (no independent approver exists, no independent QA exists, its authorization is no
--      longer valid, or it has not changed for as long as an Admin-set stall policy says), and a sweep records each stall once with its reason. The work item's
--      own state machine is NOT changed ("stalled" is a record about the item, never a status a door could set).
--   3. The data-safety control. A change the author marked sensitive that touches the database (area = database) needs, before release approval, a recorded
--      rollback plan and a backup-confirmed evidence reference (a REFERENCE, never a file or a secret) for the exact commit, recorded by someone other than the
--      commit's author. It is an eleventh gate in projects.evaluate_maintenance_gates; it is satisfied trivially for everything else and for work opened before
--      this migration (projects.maintenance_c_cutover).
-- ═══════════════════════════════════════════════════════════════════════════

-- the day the new control began: work opened earlier is outside it
create table if not exists projects.maintenance_c_cutover (
  singleton         boolean primary key default true check (singleton),
  data_safety_from  timestamptz not null
);
insert into projects.maintenance_c_cutover (singleton, data_safety_from) values (true, clock_timestamp()) on conflict (singleton) do nothing;
alter table projects.maintenance_c_cutover enable row level security;
revoke all on projects.maintenance_c_cutover from public, anon, authenticated;
grant select on projects.maintenance_c_cutover to service_role;

create table if not exists projects.maintenance_data_safety_records (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references core.organizations(id) on delete cascade,
  work_item_id         uuid not null references projects.maintenance_work_items(id) on delete cascade,
  commit_ref           text not null check (commit_ref ~ '^[0-9a-f]{40}$'),
  rollback_plan        text not null check (length(btrim(rollback_plan)) > 0 and length(rollback_plan) <= 4000),
  backup_evidence_ref  text not null check (length(btrim(backup_evidence_ref)) > 0 and length(backup_evidence_ref) <= 500),
  destructive          boolean not null default false,
  recorded_by          uuid not null references core.users(id) on delete restrict,
  recorded_at          timestamptz not null default clock_timestamp()
);
create index if not exists maintenance_data_safety_item_idx on projects.maintenance_data_safety_records (work_item_id, recorded_at desc);

create table if not exists projects.maintenance_stall_policies (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  version             int not null check (version > 0),
  stalled_after_hours int not null check (stalled_after_hours between 1 and 2160),
  set_by              uuid not null references core.users(id) on delete restrict,
  created_at          timestamptz not null default clock_timestamp(),
  unique (organization_id, version)
);

create table if not exists projects.maintenance_sla_breaches (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  work_item_id        uuid not null unique references projects.maintenance_work_items(id) on delete cascade,
  project_id          uuid not null references projects.projects(id) on delete cascade,
  priority            text not null check (priority in ('p0', 'p1', 'p2', 'p3')),
  policy_id           uuid not null references projects.maintenance_sla_policies(id) on delete restrict,
  policy_version      int not null,
  resolution_due_at   timestamptz not null,
  detected_at         timestamptz not null default clock_timestamp()
);

create table if not exists projects.maintenance_sla_breach_acknowledgements (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  breach_id        uuid not null unique references projects.maintenance_sla_breaches(id) on delete cascade,
  note             text not null check (length(btrim(note)) > 0 and length(note) <= 2000),
  acknowledged_by  uuid not null references core.users(id) on delete restrict,
  acknowledged_at  timestamptz not null default clock_timestamp()
);

create table if not exists projects.maintenance_work_stalls (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  work_item_id     uuid not null references projects.maintenance_work_items(id) on delete cascade,
  reason_code      text not null check (reason_code in ('no_independent_approver', 'no_independent_qa', 'authorization_invalid', 'inactive')),
  fingerprint      text not null check (length(fingerprint) > 0),
  detail           text not null,
  detected_at      timestamptz not null default clock_timestamp(),
  unique (work_item_id, reason_code, fingerprint)
);

create or replace function projects.maintenance_c2_history_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'a % record is history and is never edited or deleted', tg_table_name using errcode = 'restrict_violation'; end $$;

do $$
declare r record;
begin
  for r in select * from (values
    ('maintenance_data_safety_records', 'work_item_id', 'projects.maintenance_work_items'),
    ('maintenance_sla_breaches', 'work_item_id', 'projects.maintenance_work_items'), ('maintenance_sla_breaches', 'project_id', 'projects.projects'), ('maintenance_sla_breaches', 'policy_id', 'projects.maintenance_sla_policies'),
    ('maintenance_sla_breach_acknowledgements', 'breach_id', 'projects.maintenance_sla_breaches'),
    ('maintenance_work_stalls', 'work_item_id', 'projects.maintenance_work_items')
  ) as t(tbl, col, parent) loop
    execute format('drop trigger if exists %I on projects.%I', r.tbl || '_parent_org_' || r.col, r.tbl);
    execute format('create trigger %I before insert or update of %I on projects.%I for each row execute function core.enforce_parent_org(%L, %L)', r.tbl || '_parent_org_' || r.col, r.col, r.tbl, r.col, r.parent);
  end loop;
  for r in select unnest(array['maintenance_data_safety_records', 'maintenance_stall_policies', 'maintenance_sla_breaches', 'maintenance_sla_breach_acknowledgements', 'maintenance_work_stalls']) as tbl loop
    execute format('alter table projects.%I enable row level security', r.tbl);
    execute format('drop policy if exists %I on projects.%I', r.tbl || '_read', r.tbl);
    execute format($p$create policy %I on projects.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))$p$, r.tbl || '_read', r.tbl);
    execute format('revoke all on projects.%I from public, anon', r.tbl);
    execute format('revoke insert, update, delete on projects.%I from authenticated', r.tbl);
    execute format('grant select on projects.%I to authenticated', r.tbl);
    execute format('grant all on projects.%I to service_role', r.tbl);
    execute format('drop trigger if exists %I on projects.%I', 'freeze_org_' || r.tbl, r.tbl);
    execute format('create trigger %I before update of organization_id on projects.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || r.tbl, r.tbl);
    execute format('drop trigger if exists %I on projects.%I', r.tbl || '_append_only', r.tbl);
    execute format('create trigger %I before update or delete on projects.%I for each row execute function projects.maintenance_c2_history_append_only()', r.tbl || '_append_only', r.tbl);
  end loop;
end $$;

insert into core.event_types (type, description, canonical) values
  ('project.maintenance_sla_breached', 'A post-launch maintenance work item passed the resolution target an Admin set. It is recorded once and an Admin is asked to acknowledge it.', true),
  ('project.maintenance_work_stalled', 'A post-launch maintenance work item cannot move, for a reason read from rows. Its state is unchanged; a person decides what to do.', true)
on conflict (type) do nothing;

-- ═════════ the data-safety door, and the gate that reads it ═════════
create or replace function projects.record_maintenance_data_safety(p_work_item_id uuid, p_commit_ref text, p_rollback_plan text, p_backup_evidence_ref text, p_destructive boolean default false)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_i projects.maintenance_work_items;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_i from projects.maintenance_work_items w where w.id = p_work_item_id and w.organization_id = v_org for update;
  if v_i.id is null then return query select 'not_found'::text; return; end if;
  if not (v_i.sensitive and v_i.area = 'database') then return query select 'not_a_sensitive_database_change'::text; return; end if;
  if v_i.status in ('release_approved', 'released', 'cancelled') then return query select 'closed_for_changes'::text; return; end if;
  if v_i.commit_ref is null then return query select 'no_commit_yet'::text; return; end if;
  -- evidence about any other commit is not evidence about this one
  if p_commit_ref is distinct from v_i.commit_ref then return query select 'stale_commit'::text; return; end if;
  if length(btrim(coalesce(p_rollback_plan, ''))) = 0 then return query select 'rollback_plan_required'::text; return; end if;
  if length(btrim(coalesce(p_backup_evidence_ref, ''))) = 0 then return query select 'backup_evidence_required'::text; return; end if;
  if projects.p8c_has_secret(coalesce(p_rollback_plan, '') || ' ' || coalesce(p_backup_evidence_ref, '')) then return query select 'secret_in_text'::text; return; end if;
  -- the author of the commit does not confirm their own backup
  if v_actor = v_i.commit_submitted_by then return query select 'self_confirmation'::text; return; end if;
  insert into projects.maintenance_data_safety_records (organization_id, work_item_id, commit_ref, rollback_plan, backup_evidence_ref, destructive, recorded_by)
  values (v_org, v_i.id, v_i.commit_ref, btrim(p_rollback_plan), btrim(p_backup_evidence_ref), coalesce(p_destructive, false), v_actor);
  perform core.record_audit(v_org, 'maintenance_work.data_safety_recorded', 'maintenance_work_item', v_i.id, null, jsonb_build_object('commit', v_i.commit_ref, 'destructive', coalesce(p_destructive, false)));
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_maintenance_data_safety(uuid, text, text, text, boolean) from public, anon;
grant execute on function projects.record_maintenance_data_safety(uuid, text, text, text, boolean) to authenticated;

-- the gate list, now with data_safety (the earlier ten are unchanged, and unchanged for everything that is not a sensitive database change)
create or replace function projects.evaluate_maintenance_gates(p_work_item_id uuid)
returns table (gate text, passed boolean, detail text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_i projects.maintenance_work_items; v_cr projects.change_requests; v_d qa.defects; v_t projects.maintenance_items; v_inv finance.invoices;
  g text; v_ok boolean; v_det text; v_n int; v_res record; v_cat text; v_ds record; v_cut timestamptz;
begin
  select * into v_i from projects.maintenance_work_items w where w.id = p_work_item_id;
  if v_i.id is null then return; end if;
  if coalesce((select auth.role()), '') <> 'service_role' and v_i.organization_id is distinct from (select core.current_organization_id()) then return; end if;
  if v_i.change_request_id is not null then select * into v_cr from projects.change_requests c where c.id = v_i.change_request_id; end if;
  if v_i.defect_id is not null then select * into v_d from qa.defects x where x.id = v_i.defect_id; end if;
  if v_i.ticket_id is not null then select * into v_t from projects.maintenance_items m where m.id = v_i.ticket_id; end if;

  for g in select unnest(array['bound_record', 'scope_authorized', 'exact_commit', 'targeted_qa', 'regression_qa', 'security_qa', 'defect_verified', 'no_other_s0_s1', 'data_safety', 'rollback', 'admin_approval']) loop
    v_ok := false; v_det := '';
    if g = 'bound_record' then
      v_ok := (v_i.defect_id is null or (v_d.id is not null and v_d.classification = 'product_defect' and v_d.status <> 'wontfix'))
          and (v_i.change_request_id is null or (v_cr.id is not null and v_cr.status in ('approved', 'implemented') and v_cr.classification in ('in_scope', 'free_change', 'paid_change')))
          and (v_i.ticket_id is null or (v_t.id is not null and v_t.coverage in ('warranty', 'maintenance')));
      v_det := case when v_ok then 'the defect, covered ticket or approved change request this work answers to is still valid' else 'the defect, ticket or change request that authorizes this work is no longer valid (closed, declined, reclassified or not approved)' end;
    elsif g = 'scope_authorized' then
      -- a PAID change is paid for before it is built: its invoice is paid on verified money
      if v_cr.id is not null and v_cr.classification = 'paid_change' then
        select * into v_inv from finance.invoices i where i.id = v_cr.invoice_id;
        v_ok := v_inv.id is not null and v_inv.status = 'paid' and v_inv.total_minor > 0 and finance.net_verified_minor(v_inv.id) >= v_inv.total_minor;
        v_det := case when v_ok then 'the paid change''s invoice is paid on verified money' else 'the paid change request has no invoice that is paid and verified' end;
      else v_ok := true; v_det := 'no payment is needed for this authorization'; end if;
    elsif g = 'exact_commit' then
      v_ok := v_i.commit_ref is not null;
      v_det := case when v_ok then 'the work is one exact commit: ' || v_i.commit_ref else 'no commit has been submitted' end;
    elsif g in ('targeted_qa', 'regression_qa', 'security_qa') then
      v_cat := case g when 'targeted_qa' then 'targeted' when 'regression_qa' then 'regression' else 'security' end;
      if g = 'security_qa' and not v_i.sensitive then
        v_ok := true; v_det := 'the author did not mark the change security-sensitive';
      else
        select r.status, r.recorded_by into v_res from projects.maintenance_qa_results r
         where r.work_item_id = v_i.id and r.category = v_cat and r.commit_ref = v_i.commit_ref order by r.recorded_at desc, r.id desc limit 1;
        v_ok := v_res.status = 'pass' and v_res.recorded_by is distinct from v_i.commit_submitted_by;
        v_det := case when v_res.status is null then v_cat || ' QA has no result on this exact commit (unknown is not a pass)'
                      when v_res.status <> 'pass' then v_cat || ' QA is ' || v_res.status || ' on this commit'
                      when v_ok then v_cat || ' QA passed on this exact commit, independently'
                      else v_cat || ' QA was recorded by the person who submitted the commit' end;
      end if;
    elsif g = 'defect_verified' then
      if v_d.id is null then v_ok := true; v_det := 'no defect is linked';
      else
        v_ok := v_d.status = 'verified' and (v_d.retest_commit is null or v_d.retest_commit = v_i.commit_ref);
        v_det := case when v_ok then 'the linked defect was verified by an independent retest' when v_d.status = 'verified' then 'the defect was retested on a different commit' else 'the linked defect is ' || v_d.status || ', not verified' end;
      end if;
    elsif g = 'no_other_s0_s1' then
      select count(*) into v_n from qa.unresolved_product_defects(v_i.project_id) u where u.s_level <= 1 and u.defect_id is distinct from v_i.defect_id;
      v_ok := v_n = 0;
      v_det := case when v_ok then 'no other unresolved S0/S1 product defect on the project' else v_n || ' other unresolved S0/S1 product defect(s)' end;
    elsif g = 'data_safety' then
      -- a sensitive change that touches the database needs a recorded rollback plan and a backup-confirmed evidence reference, for THIS exact commit, by someone
      -- other than the commit's author. Items that entered before this control existed are outside it (the new rule is for new work).
      select c.data_safety_from into v_cut from projects.maintenance_c_cutover c where c.singleton;
      if not (v_i.sensitive and v_i.area = 'database') or v_cut is null or v_i.created_at < v_cut then
        v_ok := true; v_det := 'not a sensitive database change: no data-safety record is required';
      else
        select r.* into v_ds from projects.maintenance_data_safety_records r where r.work_item_id = v_i.id and r.commit_ref = v_i.commit_ref order by r.recorded_at desc, r.id desc limit 1;
        v_ok := v_ds.id is not null and length(btrim(v_ds.rollback_plan)) > 0 and length(btrim(v_ds.backup_evidence_ref)) > 0 and v_ds.recorded_by is distinct from v_i.commit_submitted_by;
        v_det := case when v_ds.id is null then 'a sensitive database change has no data-safety record (rollback plan and backup evidence) on this exact commit'
                      when v_ok then 'a rollback plan and a backup-confirmed evidence reference are recorded on this exact commit, independently'
                      else 'the data-safety record was made by the person who submitted the commit' end;
      end if;
    elsif g = 'rollback' then
      v_ok := length(btrim(coalesce(v_i.rollback_plan, ''))) > 0 and length(btrim(coalesce(v_i.rollback_owner, ''))) > 0;
      v_det := case when v_ok then 'a rollback plan with an owner is recorded' else 'no rollback plan and owner' end;
    elsif g = 'admin_approval' then
      v_ok := v_i.status in ('release_approved', 'released') and v_i.approved_commit = v_i.commit_ref;
      v_det := case when v_ok then 'an Admin approved this exact commit' else 'awaiting an Admin''s approval of this exact commit' end;
    end if;
    return query select g, v_ok, v_det;
  end loop;
end $$;
revoke all on function projects.evaluate_maintenance_gates(uuid) from public, anon;
grant execute on function projects.evaluate_maintenance_gates(uuid) to authenticated, service_role;
-- ═════════ SLA breach: derived priority, an Admin-set target, recorded once, escalated to a person ═════════
create or replace function projects.maintenance_priority(p_work_item_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_i projects.maintenance_work_items; v_s smallint;
begin
  select * into v_i from projects.maintenance_work_items w where w.id = p_work_item_id;
  if v_i.id is null then return null; end if;
  if coalesce((select auth.role()), '') <> 'service_role' and v_i.organization_id is distinct from (select core.current_organization_id()) then return null; end if;
  if v_i.defect_id is not null then select d.s_level into v_s from qa.defects d where d.id = v_i.defect_id; end if;
  -- the same class as classifyMaintenancePriority: a class, not a commitment
  if v_i.emergency then return 'p0'; end if;
  if v_i.kind = 'hotfix' and ((v_s is not null and v_s <= 1) or v_i.sensitive) then return 'p1'; end if;
  if v_i.kind in ('hotfix', 'patch') then return 'p2'; end if;
  return 'p3';
end $$;
revoke all on function projects.maintenance_priority(uuid) from public, anon;
grant execute on function projects.maintenance_priority(uuid) to authenticated, service_role;

create or replace function projects.sweep_maintenance_sla(p_organization_id uuid default null, p_now timestamptz default null, p_limit int default 500)
returns table (checked int, breached int, skipped_no_policy int)
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := coalesce(p_now, clock_timestamp()); r record; v_pr text; v_pol projects.maintenance_sla_policies; v_due timestamptz; v_id uuid; v_checked int := 0; v_b int := 0; v_skip int := 0;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 0, 0, 0; return; end if;
  for r in select w.* from projects.maintenance_work_items w
            where (p_organization_id is null or w.organization_id = p_organization_id) and w.status not in ('released', 'cancelled')
              and not exists (select 1 from projects.maintenance_sla_breaches b where b.work_item_id = w.id)
            order by w.created_at asc limit greatest(coalesce(p_limit, 500), 1) loop
    v_checked := v_checked + 1;
    v_pr := projects.maintenance_priority(r.id);
    select * into v_pol from projects.maintenance_sla_policies p where p.organization_id = r.organization_id and p.priority = v_pr order by p.version desc limit 1;
    -- no policy means no target: nothing is called late and no hours are made up
    if v_pol.id is null then v_skip := v_skip + 1; continue; end if;
    v_due := r.created_at + make_interval(hours => v_pol.resolution_hours);
    if v_now < v_due then continue; end if;
    v_id := null;
    insert into projects.maintenance_sla_breaches (organization_id, work_item_id, project_id, priority, policy_id, policy_version, resolution_due_at, detected_at)
    values (r.organization_id, r.id, r.project_id, v_pr, v_pol.id, v_pol.version, v_due, v_now) on conflict (work_item_id) do nothing returning id into v_id;
    if v_id is not null then
      perform core.record_audit(r.organization_id, 'maintenance_work.sla_breached', 'maintenance_work_item', r.id, null, jsonb_build_object('priority', v_pr, 'policyVersion', v_pol.version, 'dueAt', v_due));
      perform core.emit_event(r.organization_id, 'project.maintenance_sla_breached', 'maintenance_work_item', r.id, jsonb_build_object('projectId', r.project_id, 'workItemId', r.id, 'priority', v_pr));
      v_b := v_b + 1;
    end if;
  end loop;
  return query select v_checked, v_b, v_skip;
end $$;
revoke all on function projects.sweep_maintenance_sla(uuid, timestamptz, int) from public, anon, authenticated;
grant execute on function projects.sweep_maintenance_sla(uuid, timestamptz, int) to service_role;

create or replace function projects.acknowledge_maintenance_sla_breach(p_breach_id uuid, p_note text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_b projects.maintenance_sla_breaches;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if length(btrim(coalesce(p_note, ''))) = 0 then return query select 'note_required'::text; return; end if;
  select * into v_b from projects.maintenance_sla_breaches b where b.id = p_breach_id and b.organization_id = v_org;
  if v_b.id is null then return query select 'not_found'::text; return; end if;
  if exists (select 1 from projects.maintenance_sla_breach_acknowledgements a where a.breach_id = v_b.id) then return query select 'already_acknowledged'::text; return; end if;
  insert into projects.maintenance_sla_breach_acknowledgements (organization_id, breach_id, note, acknowledged_by) values (v_org, v_b.id, btrim(p_note), v_actor);
  perform core.record_audit(v_org, 'maintenance_work.sla_breach_acknowledged', 'maintenance_work_item', v_b.work_item_id, null, jsonb_build_object('breachId', v_b.id));
  return query select 'acknowledged'::text;
end $$;
revoke all on function projects.acknowledge_maintenance_sla_breach(uuid, text) from public, anon;
grant execute on function projects.acknowledge_maintenance_sla_breach(uuid, text) to authenticated;

-- ═════════ stall detection ═════════
create or replace function projects.set_maintenance_stall_policy(p_stalled_after_hours int)
returns table (outcome text, policy_version int)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_next int;
begin
  if v_actor is null then return query select 'no_actor'::text, 0; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, 0; return; end if;
  if p_stalled_after_hours is null or p_stalled_after_hours not between 1 and 2160 then return query select 'bad_hours'::text, 0; return; end if;
  perform pg_advisory_xact_lock(hashtext('maintenance_stall:' || v_org::text));
  select coalesce(max(version), 0) + 1 into v_next from projects.maintenance_stall_policies where organization_id = v_org;
  insert into projects.maintenance_stall_policies (organization_id, version, stalled_after_hours, set_by) values (v_org, v_next, p_stalled_after_hours, v_actor);
  perform core.record_audit(v_org, 'maintenance_stall_policy.set', 'maintenance_stall_policy', null, null, jsonb_build_object('version', v_next, 'hours', p_stalled_after_hours));
  return query select 'set'::text, v_next;
end $$;
revoke all on function projects.set_maintenance_stall_policy(int) from public, anon;
grant execute on function projects.set_maintenance_stall_policy(int) to authenticated;

create or replace function projects.maintenance_work_stall_reasons(p_work_item_id uuid, p_now timestamptz default null)
returns table (reason_code text, fingerprint text, detail text)
language plpgsql stable security definer set search_path = '' as $$
declare v_now timestamptz := coalesce(p_now, clock_timestamp()); v_i projects.maintenance_work_items; v_pol projects.maintenance_stall_policies; v_fp text;
begin
  select * into v_i from projects.maintenance_work_items w where w.id = p_work_item_id;
  if v_i.id is null or v_i.status in ('released', 'cancelled') then return; end if;
  if coalesce((select auth.role()), '') <> 'service_role' and v_i.organization_id is distinct from (select core.current_organization_id()) then return; end if;
  v_fp := v_i.status || ':' || coalesce(v_i.commit_ref, '-');
  -- release review needs an Admin who is not the author, the builder or the requester; if none exists, nobody can ever approve it
  if v_i.status = 'release_review' and not exists (
       select 1 from core.memberships m where m.organization_id = v_i.organization_id and m.status = 'active' and m.role in ('owner', 'ops_admin')
          and m.user_id not in (v_i.created_by, coalesce(v_i.commit_submitted_by, v_i.created_by), coalesce(v_i.release_requested_by, v_i.created_by))) then
    return query select 'no_independent_approver'::text, v_fp, 'release review needs an Admin who did not open, build or request this change, and none is active'::text;
  end if;
  -- QA is independent of the commit's author; if the author is the only person who can write, no independent result can exist
  if v_i.status in ('fix_submitted', 'changes_requested') and v_i.commit_submitted_by is not null and not exists (
       select 1 from core.memberships m where m.organization_id = v_i.organization_id and m.status = 'active' and m.role in ('owner', 'ops_admin', 'delivery_lead', 'member') and m.user_id <> v_i.commit_submitted_by) then
    return query select 'no_independent_qa'::text, v_fp, 'independent QA is required and nobody other than the commit''s author can record it'::text;
  end if;
  -- the defect, ticket or change request that authorized the work is no longer valid: the work can only be cancelled
  if exists (select 1 from projects.evaluate_maintenance_gates(v_i.id) g where g.gate = 'bound_record' and not g.passed) then
    return query select 'authorization_invalid'::text, v_fp, 'the defect, ticket or change request that authorized this work is no longer valid: cancel it or re-authorize'::text;
  end if;
  -- inactivity counts only against a threshold an Admin set (none is assumed)
  select * into v_pol from projects.maintenance_stall_policies p where p.organization_id = v_i.organization_id order by p.version desc limit 1;
  if v_pol.id is not null and v_now - v_i.updated_at >= make_interval(hours => v_pol.stalled_after_hours) then
    return query select 'inactive'::text, v_fp || ':' || extract(epoch from v_i.updated_at)::text, 'no change for at least ' || v_pol.stalled_after_hours || ' hours (stall policy v' || v_pol.version || ')';
  end if;
end $$;
revoke all on function projects.maintenance_work_stall_reasons(uuid, timestamptz) from public, anon;
grant execute on function projects.maintenance_work_stall_reasons(uuid, timestamptz) to authenticated, service_role;

create or replace function projects.sweep_maintenance_stalls(p_organization_id uuid default null, p_now timestamptz default null, p_limit int default 500)
returns table (checked int, marked int)
language plpgsql security definer set search_path = '' as $$
declare r record; s record; v_id uuid; v_checked int := 0; v_marked int := 0;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 0, 0; return; end if;
  for r in select w.id, w.organization_id, w.project_id from projects.maintenance_work_items w
            where (p_organization_id is null or w.organization_id = p_organization_id) and w.status not in ('released', 'cancelled')
            order by w.updated_at asc limit greatest(coalesce(p_limit, 500), 1) loop
    v_checked := v_checked + 1;
    for s in select * from projects.maintenance_work_stall_reasons(r.id, p_now) loop
      v_id := null;
      insert into projects.maintenance_work_stalls (organization_id, work_item_id, reason_code, fingerprint, detail) values (r.organization_id, r.id, s.reason_code, s.fingerprint, s.detail)
      on conflict (work_item_id, reason_code, fingerprint) do nothing returning id into v_id;
      if v_id is not null then
        perform core.record_audit(r.organization_id, 'maintenance_work.stalled', 'maintenance_work_item', r.id, null, jsonb_build_object('reason', s.reason_code));
        perform core.emit_event(r.organization_id, 'project.maintenance_work_stalled', 'maintenance_work_item', r.id, jsonb_build_object('projectId', r.project_id, 'workItemId', r.id, 'reason', s.reason_code));
        v_marked := v_marked + 1;
      end if;
    end loop;
  end loop;
  return query select v_checked, v_marked;
end $$;
revoke all on function projects.sweep_maintenance_stalls(uuid, timestamptz, int) from public, anon, authenticated;
grant execute on function projects.sweep_maintenance_stalls(uuid, timestamptz, int) to service_role;

notify pgrst, 'reload schema';
