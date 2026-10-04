-- The AI Provider Manager, part 4: a provider is checked, and its model list refreshed, without anyone pressing a button.
--
-- Until now health changed only when a real call happened or somebody pressed Test, and models were listed only when somebody pressed
-- Refresh. A key revoked at the vendor, an exhausted quota or a model withdrawn would be noticed by the first run to meet it. The
-- cron tick now asks which providers are due, probes them, and records what it learned through the same doors a person's Test
-- uses. Nothing here decides anything about routing: a discovered model still arrives DISABLED, and health is a condition the
-- planner already reads.

-- ── discovery, applied to one organization's registry (the body of the owner's Refresh, moved so a system sweep can share it) ──

create or replace function ai._apply_discovery(p_org uuid, p_provider_id text, p_models jsonb)
returns table (added int, refreshed int, gone int)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  m       jsonb;
  v_id    text;
  v_added int := 0; v_refreshed int := 0; v_gone int;
  v_seen  text[] := '{}';
begin
  for m in select * from jsonb_array_elements(p_models) loop
    v_id := btrim(coalesce(m->>'id', ''));
    if v_id = '' or length(v_id) > 200 then continue; end if;
    v_seen := v_seen || v_id;
    if exists (select 1 from ai.models x where x.organization_id = p_org and x.model_id = v_id) then
      -- Never overwrite what an Admin set by hand (enabled, tiers, prices, a manual registration's own metadata).
      update ai.models
         set last_seen_at = now(),
             status = case when status = 'deprecated' and source = 'discovered' then 'available' else status end,
             context_tokens = coalesce(context_tokens, nullif(m->>'contextTokens', '')::int),
             display_name = coalesce(display_name, nullif(m->>'displayName', ''))
       where organization_id = p_org and model_id = v_id and provider = p_provider_id;
      v_refreshed := v_refreshed + 1;
    else
      -- New models arrive DISABLED: the Admin chooses what becomes routable. Nothing a vendor lists is routed to by itself.
      insert into ai.models (organization_id, model_id, provider, capabilities, context_tokens, status, enabled, source, display_name, discovered_at, last_seen_at)
      values (p_org, v_id, p_provider_id, '{}', nullif(m->>'contextTokens', '')::int, 'available', false, 'discovered', nullif(m->>'displayName', ''), now(), now())
      on conflict (organization_id, model_id) do nothing;
      v_added := v_added + 1;
    end if;
  end loop;

  update ai.models set status = 'deprecated'
   where organization_id = p_org and provider = p_provider_id and source = 'discovered' and status = 'available' and not (model_id = any (v_seen));
  get diagnostics v_gone = row_count;

  perform core.record_audit(p_org, 'ai_model.discovery_recorded', 'ai_provider', null, null, jsonb_build_object('provider', p_provider_id, 'added', v_added, 'refreshed', v_refreshed, 'gone', v_gone));
  return query select v_added, v_refreshed, v_gone;
end;
$$;
revoke all on function ai._apply_discovery(uuid, text, jsonb) from public, anon, authenticated;

create or replace function ai.record_discovered_models(p_provider_id text, p_models jsonb)
returns table (outcome text, added int, refreshed int, gone int)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := ai._provider_actor(false);
  v_org   uuid := (select core.current_organization_id());
  r       record;
begin
  if v_actor <> 'ok' then return query select v_actor, 0, 0, 0; return; end if;
  if not exists (select 1 from ai.providers where provider_id = p_provider_id) then return query select 'unknown_provider'::text, 0, 0, 0; return; end if;
  if jsonb_typeof(p_models) <> 'array' or jsonb_array_length(p_models) > 2000 then return query select 'invalid'::text, 0, 0, 0; return; end if;
  select * into r from ai._apply_discovery(v_org, p_provider_id, p_models);
  return query select 'recorded'::text, r.added, r.refreshed, r.gone;
end;
$$;
revoke all on function ai.record_discovered_models(text, jsonb) from public, anon;
grant execute on function ai.record_discovered_models(text, jsonb) to authenticated;

-- ── the sweep's doors (service role only) ──

create or replace function ai.record_discovered_models_system(p_provider_id text, p_models jsonb)
returns table (outcome text, organizations int)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_n   int := 0;
begin
  if not exists (select 1 from ai.providers where provider_id = p_provider_id) then return query select 'unknown_provider'::text, 0; return; end if;
  if jsonb_typeof(p_models) <> 'array' or jsonb_array_length(p_models) > 2000 then return query select 'invalid'::text, 0; return; end if;
  -- The provider is shared; each organization keeps its own registry, so each learns what the vendor lists.
  for v_org in select id from core.organizations loop
    perform ai._apply_discovery(v_org, p_provider_id, p_models);
    v_n := v_n + 1;
  end loop;
  return query select 'recorded'::text, v_n;
end;
$$;
revoke all on function ai.record_discovered_models_system(text, jsonb) from public, anon, authenticated;
grant execute on function ai.record_discovered_models_system(text, jsonb) to service_role;

-- Which providers are due for a probe. Enabled and not archived only: a provider the Admin turned off is left alone.
create or replace function ai.due_provider_maintenance(p_health_minutes int default 15, p_sync_minutes int default 360, p_limit int default 3)
returns table (provider_id text, need_health boolean, need_sync boolean, health_state text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.provider_id,
         (p.health_checked_at is null or p.health_checked_at < now() - make_interval(mins => greatest(p_health_minutes, 1))),
         (p.last_model_sync_at is null or p.last_model_sync_at < now() - make_interval(mins => greatest(p_sync_minutes, 1))),
         p.health_state
    from ai.providers p
   where p.enabled and p.archived_at is null
     and (p.health_checked_at is null or p.health_checked_at < now() - make_interval(mins => greatest(p_health_minutes, 1))
          or p.last_model_sync_at is null or p.last_model_sync_at < now() - make_interval(mins => greatest(p_sync_minutes, 1)))
   order by coalesce(p.health_checked_at, 'epoch'::timestamptz), p.provider_id
   limit greatest(p_limit, 1);
$$;
revoke all on function ai.due_provider_maintenance(int, int, int) from public, anon, authenticated;
grant execute on function ai.due_provider_maintenance(int, int, int) to service_role;

notify pgrst, 'reload schema';
