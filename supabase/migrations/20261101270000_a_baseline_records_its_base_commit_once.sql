-- P5-BASE-02: the baseline names a repository and a base commit, but nothing could ever populate them (the baseline is frozen whole). One
-- sanctioned exception: a door may FILL base_commit and repository_id ONCE, while they are still null. Never invented, never edited afterwards.
create or replace function projects.freeze_development_baseline()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE'
     and coalesce(current_setting('projects.baseline_fill', true), '') = 'on'
     and old.base_commit is null and old.repository_id is null
     and new.base_commit is not null and new.repository_id is not null
     and (to_jsonb(new) - 'base_commit' - 'repository_id') = (to_jsonb(old) - 'base_commit' - 'repository_id') then
    return new;
  end if;
  raise exception 'a locked development baseline is never edited: a changed scope is a Change Request and a new baseline' using errcode = 'restrict_violation';
end $$;

create or replace function projects.record_baseline_commit(p_project_id uuid, p_repository_id uuid, p_base_commit text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_b projects.development_baselines;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_base_commit is null or p_base_commit !~ '^[0-9a-f]{7,40}$' then return query select 'bad_commit'::text; return; end if;
  select * into v_b from projects.development_baselines b where b.project_id = p_project_id and b.organization_id = v_org for update;
  if v_b.id is null then return query select 'no_baseline'::text; return; end if;
  if v_b.base_commit is not null or v_b.repository_id is not null then return query select 'already_recorded'::text; return; end if;
  if not exists (select 1 from projects.repositories r where r.id = p_repository_id and r.project_id = p_project_id and r.organization_id = v_org) then return query select 'repository_not_on_project'::text; return; end if;
  perform set_config('projects.baseline_fill', 'on', true);
  update projects.development_baselines set base_commit = p_base_commit, repository_id = p_repository_id where id = v_b.id;
  perform set_config('projects.baseline_fill', 'off', true);
  perform core.record_audit(v_org, 'baseline.base_commit_recorded', 'development_baseline', v_b.id, null, jsonb_build_object('baseCommit', p_base_commit, 'repositoryId', p_repository_id));
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_baseline_commit(uuid, uuid, text) from public, anon;
grant execute on function projects.record_baseline_commit(uuid, uuid, text) to authenticated;
notify pgrst, 'reload schema';
