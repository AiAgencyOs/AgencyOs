-- ════════════════════════════════════════════════════════════════════════════
-- W6 / SCR-064 "Set model budget/cap": a model has a monthly budget of its own.
--
-- 20261001150000 capped a PROVIDER per calendar month. The PDF's routing
-- screen also asks for a cap per MODEL (an expensive model can be limited
-- while a cheap one from the same provider is not). Same shape, one level
-- down:
--   * ai.model_budgets        the cap, per (organization, model id). RLS by
--                             organization, internal readers only, no direct
--                             write grant to authenticated.
--   * ai.model_spend_this_month  what the model has cost since the first of
--                             the month, from ai.agent_steps
--                             (request ->> 'model'). Never estimated.
--   * ai.set_model_budget     owner only, audited (model_budget.set / .cleared).
--                             The model must be a row of the owner's registry.
--   * ai.model_budget_status  the cap beside its spend, for the page.
--   * a refusal of kind model_budget_exceeded is recorded like the provider's.
-- Additive and idempotent: safe to apply twice.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists ai.model_budgets (
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  model_id          text not null check (length(btrim(model_id)) > 0),
  monthly_cap_minor bigint not null check (monthly_cap_minor > 0),
  set_by            uuid references core.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (organization_id, model_id)
);

comment on table ai.model_budgets is
  'The most one model may cost this organisation in a calendar month, in minor units (SCR-064 "Set model budget/cap"). The runner asks ai.model_spend_this_month before every call and refuses once the cap is reached, recorded as a policy refusal of kind model_budget_exceeded. Written only through ai.set_model_budget (owner, audited).';

drop trigger if exists set_updated_at on ai.model_budgets;
create trigger set_updated_at before update on ai.model_budgets
  for each row execute function core.set_updated_at();

drop trigger if exists freeze_org_model_budgets on ai.model_budgets;
create trigger freeze_org_model_budgets
  before update of organization_id on ai.model_budgets
  for each row execute function core.freeze_organization_id();

alter table ai.model_budgets enable row level security;
alter table ai.model_budgets force row level security;

drop policy if exists model_budgets_select on ai.model_budgets;
create policy model_budgets_select on ai.model_budgets
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on ai.model_budgets to authenticated;
grant select, insert, update, delete on ai.model_budgets to service_role;

create or replace function ai.model_spend_this_month(p_organization_id uuid, p_model_id text)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(s.cost_minor), 0)::bigint
    from ai.agent_steps s
   where s.organization_id = p_organization_id
     and s.kind = 'model_call'
     and s.request ->> 'model' = p_model_id
     and s.created_at >= date_trunc('month', now());
$$;

comment on function ai.model_spend_this_month(uuid, text) is
  'Sum of ai.agent_steps.cost_minor for one model since the first of this month — what a model budget is measured against. Never estimated.';

revoke all on function ai.model_spend_this_month(uuid, text) from public, anon;
grant execute on function ai.model_spend_this_month(uuid, text) to authenticated, service_role;

create or replace function ai.set_model_budget(p_model_id text, p_monthly_cap_minor bigint)
returns table (
  -- 'set' | 'cleared'
  -- refusals: 'no_actor' | 'not_owner' | 'unknown_model' | 'bad_cap' | 'unchanged'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_before jsonb;
  v_after  jsonb;
  v_model  text := btrim(coalesce(p_model_id, ''));
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_owner()), false) then
    return query select 'not_owner'::text; return;
  end if;
  if v_model = '' or not exists (select 1 from ai.models m where m.organization_id = v_org and m.model_id = v_model) then
    return query select 'unknown_model'::text; return;
  end if;
  if p_monthly_cap_minor is not null and (p_monthly_cap_minor < 0 or p_monthly_cap_minor > 100000000000) then
    return query select 'bad_cap'::text; return;
  end if;

  select to_jsonb(b.*) into v_before
    from ai.model_budgets b
   where b.organization_id = v_org and b.model_id = v_model;

  if coalesce(p_monthly_cap_minor, 0) = 0 then
    if v_before is null then
      return query select 'unchanged'::text; return;
    end if;
    delete from ai.model_budgets where organization_id = v_org and model_id = v_model;
    perform core.record_audit(v_org, 'model_budget.cleared', 'model_budget', null,
                              v_before, jsonb_build_object('model', v_model));
    return query select 'cleared'::text; return;
  end if;

  if v_before is not null and (v_before ->> 'monthly_cap_minor')::bigint = p_monthly_cap_minor then
    return query select 'unchanged'::text; return;
  end if;

  insert into ai.model_budgets (organization_id, model_id, monthly_cap_minor, set_by)
  values (v_org, v_model, p_monthly_cap_minor, v_actor)
  on conflict (organization_id, model_id) do update
     set monthly_cap_minor = excluded.monthly_cap_minor, set_by = excluded.set_by, updated_at = now()
  returning to_jsonb(ai.model_budgets.*) into v_after;

  perform core.record_audit(v_org, 'model_budget.set', 'model_budget', null, v_before, v_after);

  return query select 'set'::text;
end;
$$;

comment on function ai.set_model_budget(text, bigint) is
  'Sets (or, with 0 / null, clears) a model''s monthly cap in minor units (SCR-064). Owner only, audited as model_budget.set / model_budget.cleared. The model must be in the owner''s registry.';

revoke all on function ai.set_model_budget(text, bigint) from public, anon;
grant execute on function ai.set_model_budget(text, bigint) to authenticated;

create or replace view ai.model_budget_status
with (security_invoker = on) as
  select b.organization_id,
         b.model_id,
         b.monthly_cap_minor,
         ai.model_spend_this_month(b.organization_id, b.model_id) as spent_minor,
         b.updated_at
    from ai.model_budgets b;

comment on view ai.model_budget_status is
  'Each model budget beside what the model has cost this month (SCR-064). Read-only.';

grant select on ai.model_budget_status to authenticated, service_role;

-- A model-budget refusal is recorded like the provider's: same table, one more kind.
alter table ai.agent_policy_refusals drop constraint if exists agent_policy_refusals_kind_check;
alter table ai.agent_policy_refusals
  add constraint agent_policy_refusals_kind_check
  check (kind in ('tool_denied', 'tool_unrecorded', 'project_unassigned', 'provider_budget_exceeded', 'model_budget_exceeded'));

alter table ai.agent_policy_refusals drop constraint if exists agent_policy_refusals_names_its_subject;
alter table ai.agent_policy_refusals
  add constraint agent_policy_refusals_names_its_subject check (
    (kind in ('tool_denied', 'tool_unrecorded') and tool_key is not null)
    or (kind = 'project_unassigned' and project_id is not null)
    or (kind in ('provider_budget_exceeded', 'model_budget_exceeded'))
  );
