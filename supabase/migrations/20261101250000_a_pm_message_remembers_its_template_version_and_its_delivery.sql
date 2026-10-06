-- P5-PM-01 / P6-PM-01: the PM milestone messages had delivery state (the outbound message's metadata.delivery) but no record of WHICH wording
-- was sent. A template changes; the message that went out must stay explainable. One row per announced milestone message: its milestone key, the
-- template version it was built from, and the project. Delivery state stays on the message and is joined at read time, never copied.
create table if not exists crm.pm_message_log (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  message_id       uuid not null unique references crm.conversation_messages(id) on delete cascade,
  project_id       uuid references projects.projects(id) on delete cascade,
  milestone_key    text not null check (length(btrim(milestone_key)) > 0),
  template_version integer not null check (template_version >= 1),
  created_at       timestamptz not null default now()
);
create index if not exists pm_message_log_project_idx on crm.pm_message_log (organization_id, project_id, created_at desc);
alter table crm.pm_message_log enable row level security;
drop policy if exists pm_message_log_select on crm.pm_message_log;
create policy pm_message_log_select on crm.pm_message_log for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on crm.pm_message_log from public, anon;
revoke insert, update, delete on crm.pm_message_log from authenticated;
grant select on crm.pm_message_log to authenticated;
grant all on crm.pm_message_log to service_role;

drop trigger if exists pm_message_log_parent_org_message on crm.pm_message_log;
create trigger pm_message_log_parent_org_message before insert or update of message_id on crm.pm_message_log
  for each row execute function core.enforce_parent_org('message_id', 'crm.conversation_messages');
drop trigger if exists pm_message_log_parent_org_project on crm.pm_message_log;
create trigger pm_message_log_parent_org_project before insert or update of project_id on crm.pm_message_log
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
drop trigger if exists freeze_org_pm_message_log on crm.pm_message_log;
create trigger freeze_org_pm_message_log before update of organization_id on crm.pm_message_log
  for each row execute function core.freeze_organization_id();

-- append-only: a record of what was sent is never rewritten
create or replace function crm.pm_message_log_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'the PM message log is append-only' using errcode = 'restrict_violation';
end $$;
drop trigger if exists pm_message_log_append_only on crm.pm_message_log;
create trigger pm_message_log_append_only before update on crm.pm_message_log for each row execute function crm.pm_message_log_guard();

-- the runner records it (service_role only); the organization comes from the MESSAGE, never from the caller
create or replace function crm.record_pm_message(p_message_id uuid, p_milestone text, p_template_version integer, p_project_id uuid default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text; return; end if;
  select m.organization_id into v_org from crm.conversation_messages m where m.id = p_message_id;
  if v_org is null then return query select 'not_found'::text; return; end if;
  if p_milestone is null or length(btrim(p_milestone)) = 0 or p_template_version is null or p_template_version < 1 then return query select 'bad_input'::text; return; end if;
  insert into crm.pm_message_log (organization_id, message_id, project_id, milestone_key, template_version)
  values (v_org, p_message_id, p_project_id, p_milestone, p_template_version)
  on conflict (message_id) do nothing;
  return query select 'recorded'::text;
end $$;
revoke all on function crm.record_pm_message(uuid, text, integer, uuid) from public, anon, authenticated;
grant execute on function crm.record_pm_message(uuid, text, integer, uuid) to service_role;

-- the history of a project's PM messages: milestone, template version and the message's own delivery state (internal staff only)
create or replace function projects.pm_message_history(p_project_id uuid)
returns table (milestone_key text, template_version integer, delivery text, sent_at timestamptz)
language sql stable set search_path = '' as $$
  select l.milestone_key, l.template_version, coalesce(m.metadata ->> 'delivery', 'pending'), m.occurred_at
    from crm.pm_message_log l join crm.conversation_messages m on m.id = l.message_id
   where l.project_id = p_project_id and l.organization_id = (select core.current_organization_id()) and (select core.is_internal())
   order by m.occurred_at desc
$$;
revoke all on function projects.pm_message_history(uuid) from public, anon;
grant execute on function projects.pm_message_history(uuid) to authenticated, service_role;
notify pgrst, 'reload schema';
