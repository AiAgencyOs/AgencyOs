-- A model id is only unique WITHIN a provider.
--
-- `ai.models` was keyed by (organization, model_id), so one model id could belong to only one provider. Found live: a gateway in front
-- of Claude lists `claude-sonnet-5`, the same id the built-in Anthropic provider serves. Discovery silently kept the first copy, and
-- a copy switched off under one provider switched the id off for both. The key is now (organization, provider, model_id): each
-- provider has its own row for a model - its own enabled flag, price, tiers and health of the offer - and a provider can be chosen
-- (MANUAL) or ranked (AUTO) independently of another that happens to serve the same id.
--
-- Additive for every existing row: each already had a provider, so each is still unique under the wider key.

alter table ai.models drop constraint if exists models_pkey;
alter table ai.models add constraint models_pkey primary key (organization_id, provider, model_id);

-- ── the doors that took only a model id now take the provider too (optional while it is unambiguous) ──

drop function if exists ai.set_model_enabled(text, boolean);
create or replace function ai.set_model_enabled(p_model_id text, p_enabled boolean, p_provider text default null)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := ai._provider_actor(false);
  v_org   uuid := (select core.current_organization_id());
  v_n     int;
  v_m     ai.models;
begin
  if v_actor <> 'ok' then return query select v_actor; return; end if;
  select count(*) into v_n from ai.models where organization_id = v_org and model_id = p_model_id and (p_provider is null or provider = p_provider);
  if v_n = 0 then return query select 'unknown_model'::text; return; end if;
  -- The same id under two providers is two offers: say which, rather than switch both.
  if v_n > 1 then return query select 'ambiguous'::text; return; end if;
  select * into v_m from ai.models where organization_id = v_org and model_id = p_model_id and (p_provider is null or provider = p_provider) for update;
  update ai.models set enabled = p_enabled where organization_id = v_org and model_id = p_model_id and provider = v_m.provider;
  perform core.record_audit(v_org, case when p_enabled then 'ai_model.enabled' else 'ai_model.disabled' end, 'ai_model', null,
    jsonb_build_object('model', p_model_id, 'provider', v_m.provider, 'enabled', v_m.enabled), jsonb_build_object('model', p_model_id, 'provider', v_m.provider, 'enabled', p_enabled));
  return query select case when p_enabled then 'enabled' else 'disabled' end::text;
end;
$$;
revoke all on function ai.set_model_enabled(text, boolean, text) from public, anon;
grant execute on function ai.set_model_enabled(text, boolean, text) to authenticated;

drop function if exists ai.retire_model(text, text);
create or replace function ai.retire_model(p_model_id text, p_reason text, p_provider text default null)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_n      int;
  v_prov   text;
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_owner()), false) then return query select 'not_owner'::text; return; end if;
  if v_reason is null then return query select 'no_reason'::text; return; end if;

  select count(*), min(m.provider) into v_n, v_prov from ai.models m where m.organization_id = v_org and m.model_id = p_model_id and (p_provider is null or m.provider = p_provider);
  if v_n = 0 then return query select 'not_found'::text; return; end if;
  if v_n > 1 then return query select 'ambiguous'::text; return; end if;

  select to_jsonb(m.*) into v_before from ai.models m where m.organization_id = v_org and m.model_id = p_model_id and m.provider = v_prov for update;
  if (v_before ->> 'status') = 'retired' then return query select 'already_retired'::text; return; end if;

  -- A model a fallback chain still names cannot be retired out from under it (unless another provider still serves the same id).
  if exists (select 1 from ai.fallback_chains fc where fc.organization_id = v_org and p_model_id = any (fc.model_ids))
     and not exists (select 1 from ai.models m where m.organization_id = v_org and m.model_id = p_model_id and m.provider <> v_prov and m.status = 'available') then
    return query select 'in_a_chain'::text; return;
  end if;

  update ai.models set status = 'retired', updated_at = now() where organization_id = v_org and model_id = p_model_id and provider = v_prov
  returning to_jsonb(ai.models.*) into v_after;
  perform core.record_audit(v_org, 'model.retired', 'model', null, v_before, v_after || jsonb_build_object('reason', v_reason));
  return query select 'retired'::text;
end;
$$;
revoke all on function ai.retire_model(text, text, text) from public, anon;
grant execute on function ai.retire_model(text, text, text) to authenticated;

-- ── discovery, manual registration and the owner's add-a-model door key on (provider, model) ──

create or replace function ai._assignment_target_ok(p_org uuid, p_provider text, p_model text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_m ai.models;
begin
  if not exists (select 1 from ai.providers where provider_id = p_provider and archived_at is null) then return 'unknown_provider'; end if;
  select * into v_m from ai.models where organization_id = p_org and provider = p_provider and model_id = p_model;
  if v_m.model_id is null then
    -- Registered, but under a different provider: name that, it is the likelier mistake.
    if exists (select 1 from ai.models where organization_id = p_org and model_id = p_model) then return 'provider_mismatch'; end if;
    return 'unknown_model';
  end if;
  -- MANUAL mode may only select a model the Admin has enabled and the vendor still serves.
  if not v_m.enabled or v_m.status <> 'available' then return 'model_not_enabled'; end if;
  return 'ok';
end;
$$;

do $$
declare
  v_sig text;
  v_def text;
  v_new text;
begin
  foreach v_sig in array array[
    'ai.register_manual_model(text, text, text, text[], integer, boolean, boolean)',
    'ai._apply_discovery(uuid, text, jsonb)',
    'ai.add_model(text, text, text[], integer, bigint, bigint)'
  ] loop
    v_def := pg_get_functiondef(v_sig::regprocedure);
    v_new := replace(v_def, 'on conflict (organization_id, model_id)', 'on conflict (organization_id, provider, model_id)');
    -- existence checks that looked a model up by id alone now look it up under its provider
    v_new := replace(v_new, 'x.organization_id = p_org and x.model_id = v_id)', 'x.organization_id = p_org and x.provider = p_provider_id and x.model_id = v_id)');
    v_new := replace(v_new, 'where m.organization_id = v_org and m.model_id = v_model;', 'where m.organization_id = v_org and m.provider = v_provider and m.model_id = v_model;');
    if v_new = v_def then
      raise exception 'expected to find a model keyed by id alone in %, found none - the function changed since this migration was written', v_sig;
    end if;
    execute v_new;
  end loop;
end
$$;

notify pgrst, 'reload schema';
