-- ═══════════════════════════════════════════════════════════════════════════
-- The runner holds an agent to its policy, and a lead earns its score.
--
-- Three of the owner's decisions of 2026-09-29 (bucket D), each one a rule
-- the schema either could not hold or was holding the other way round:
--
--   Decision 3  The runner ENFORCES agent tool permissions and project
--               assignments. `ai.agent_tool_permissions` and
--               `ai.agent_project_assignments` (20260929170000) were written
--               as "a policy record the orchestrator does not yet read". It
--               reads them now: a tool call with no allowing row is refused
--               at call time, an agent with any active assignment acts only
--               on those projects (none = all), and every refusal is a row
--               in `ai.agent_policy_refusals` with an audit entry beside it,
--               so the agent's page can list what it was stopped from doing.
--
--   ADM-82      Decision: reversed by the owner on 2026-09-29. The owner may
--               enable/disable an agent and set max_steps / max_cost_minor
--               from the panel, audited. `ai.agents` stays what
--               20260815380000 made it — no end-user write policy, no table
--               grants for authenticated — and the two doors below are
--               SECURITY DEFINER functions that check core.is_owner()
--               themselves and record the change through core.record_audit.
--               The registry is global; the audit row lands in the acting
--               owner's tenant, naming the key, so who changed a shared row
--               is never in doubt.
--
--   ADM-88      Decision: reversed by the owner on 2026-09-29. A numeric
--               0–100 lead score WITH reasons, computed deterministically by
--               a pure function from stated inputs and stored by a door.
--               20260821220000 constrained `crm.leads.score` and
--               `score_reasons` to null; that constraint is dropped and
--               replaced by a stricter one in the opposite direction: a
--               score never travels without the reasons that produced it,
--               the inputs it was computed from, and the moment it was
--               computed. A bare number is still refused — now because it
--               is incomplete, not because it is forbidden.
--
-- Rules held here rather than by convention:
--   · a refusal is written only by the service-role runner
--     (`ai.record_agent_policy_refusal`, granted to service_role alone) and
--     is readable by any internal role of the tenant — nobody edits one.
--   · enabling/disabling and the caps are OWNER-ONLY, and a disable must say
--     why (`agents_disabled_reason_together` from 20260814120002 still holds;
--     the door takes the reason and the constraint refuses a silent disable).
--   · a lead score is written only through `crm.set_lead_score`, which
--     refuses a score without a non-empty reasons array and an inputs
--     object, and `leads_score_carries_its_reasons` refuses it again.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Decision 3: the refusal record ──────────────────────────────────────────

create table if not exists ai.agent_policy_refusals (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  agent_key        text not null references ai.agents(key) on delete cascade,
  run_id           uuid references ai.agent_runs(id) on delete set null,
  kind             text not null check (kind in ('tool_denied', 'tool_unrecorded', 'project_unassigned')),
  tool_key         text check (tool_key is null or tool_key ~ '^[a-z][a-zA-Z0-9_.]{1,80}$'),
  project_id       uuid references projects.projects(id) on delete set null,
  reason           text not null check (length(trim(reason)) > 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- A refusal names the thing it refused.
  constraint agent_policy_refusals_names_its_subject check (
    (kind in ('tool_denied', 'tool_unrecorded') and tool_key is not null)
    or (kind = 'project_unassigned' and project_id is not null)
  )
);

comment on table ai.agent_policy_refusals is
  'What the runner stopped an agent from doing under this tenant''s policy (decision 3, 2026-09-29): a tool call with no allowing ai.agent_tool_permissions row, or work on a project the agent is not assigned to. Written by the service-role runner only, read on the agent detail page.';

create index if not exists agent_policy_refusals_agent_idx
  on ai.agent_policy_refusals (organization_id, agent_key, created_at desc);

drop trigger if exists set_updated_at on ai.agent_policy_refusals;
create trigger set_updated_at before update on ai.agent_policy_refusals
  for each row execute function core.set_updated_at();

alter table ai.agent_policy_refusals enable row level security;
alter table ai.agent_policy_refusals force row level security;

drop policy if exists agent_policy_refusals_select on ai.agent_policy_refusals;
create policy agent_policy_refusals_select on ai.agent_policy_refusals
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

-- No end-user write policy: the runner writes with the service role, which
-- RLS does not see, and a refusal is a record of what happened, not a form.
grant select on ai.agent_policy_refusals to authenticated;
grant select, insert on ai.agent_policy_refusals to service_role;

drop trigger if exists freeze_org_agent_policy_refusals on ai.agent_policy_refusals;
create trigger freeze_org_agent_policy_refusals
  before update of organization_id on ai.agent_policy_refusals
  for each row execute function core.freeze_organization_id();

drop trigger if exists org_match_agent_policy_refusals_run on ai.agent_policy_refusals;
create trigger org_match_agent_policy_refusals_run
  before insert or update of run_id, organization_id on ai.agent_policy_refusals
  for each row execute function core.enforce_parent_org('run_id', 'ai.agent_runs');

drop trigger if exists org_match_agent_policy_refusals_project on ai.agent_policy_refusals;
create trigger org_match_agent_policy_refusals_project
  before insert or update of project_id, organization_id on ai.agent_policy_refusals
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

-- The one door. Service role only: the runner is the only thing that can
-- know a call was refused, and it has no auth.uid(), so core.record_audit
-- files the entry as 'system' — which is what it is.
create or replace function ai.record_agent_policy_refusal(
  p_organization_id uuid,
  p_agent_key       text,
  p_kind            text,
  p_reason          text,
  p_run_id          uuid default null,
  p_tool_key        text default null,
  p_project_id      uuid default null
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id    uuid;
  v_after jsonb;
begin
  insert into ai.agent_policy_refusals (organization_id, agent_key, run_id, kind, tool_key, project_id, reason)
  values (p_organization_id, p_agent_key, p_run_id, p_kind, p_tool_key, p_project_id, p_reason)
  returning id, to_jsonb(ai.agent_policy_refusals.*) into v_id, v_after;

  perform core.record_audit(
    p_organization_id,
    'agent.policy_refused',
    'agent_policy_refusal',
    v_id,
    null,
    v_after
  );

  return v_id;
end;
$$;

comment on function ai.record_agent_policy_refusal(uuid, text, text, text, uuid, text, uuid) is
  'Records one thing the runner refused an agent under this tenant''s policy, and the audit entry beside it, in one transaction. Service role only.';

revoke all on function ai.record_agent_policy_refusal(uuid, text, text, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function ai.record_agent_policy_refusal(uuid, text, text, text, uuid, text, uuid) to service_role;

-- The two policy tables no longer describe themselves as unread.
comment on table ai.agent_tool_permissions is
  'This tenant''s record of which tools an agent may use (SCR-063). Read by the runner since decision 3 of 2026-09-29: a call with no row, or a row with allowed = false, is refused at call time and recorded in ai.agent_policy_refusals. ai.agents itself is global and not tenant-writable.';

comment on table ai.agent_project_assignments is
  'Which projects an agent is assigned to in this tenant (SCR-063). Deactivated rather than deleted, so an assignment that was withdrawn is still visible as one. Read by the runner since decision 3 of 2026-09-29: an agent with any active assignment works only on those projects; none means all.';

-- ── ADM-82, reversed: the owner enables, disables and caps an agent ────────
--
-- Decision: reversed by the owner on 2026-09-29.
--
-- SECURITY DEFINER because ai.agents has no UPDATE grant for authenticated
-- (20260815380000) and an INVOKER write would be filtered to nothing. The
-- caller guard inside is therefore the whole guard: an actor, in an
-- organisation, holding the owner role.

create or replace function ai.set_agent_status(
  p_agent_key text,
  p_enabled   boolean,
  p_reason    text default null
)
returns table (
  -- 'set'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'reason_required' | 'unchanged'
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
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.is_owner()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  select jsonb_build_object('key', a.key, 'enabled', a.enabled, 'disabled_reason', a.disabled_reason)
    into v_before
    from ai.agents a
   where a.key = p_agent_key;

  if v_before is null then
    return query select 'not_found'::text; return;
  end if;

  if (v_before ->> 'enabled')::boolean = p_enabled then
    return query select 'unchanged'::text; return;
  end if;

  -- agents_disabled_reason_together (20260814120002): an agent disabled for
  -- an unrecorded reason is one somebody turns back on.
  if not p_enabled and v_reason is null then
    return query select 'reason_required'::text; return;
  end if;

  update ai.agents
     set enabled         = p_enabled,
         disabled_reason = case when p_enabled then null else v_reason end
   where key = p_agent_key
  returning jsonb_build_object('key', key, 'enabled', enabled, 'disabled_reason', disabled_reason)
    into v_after;

  perform core.record_audit(
    v_org,
    case when p_enabled then 'agent.enabled' else 'agent.disabled' end,
    'agent',
    null,
    v_before,
    v_after
  );

  return query select 'set'::text;
end;
$$;

comment on function ai.set_agent_status(text, boolean, text) is
  'Enables or disables a registry agent from the panel (ADM-82, reversed by the owner on 2026-09-29). Owner only; a disable must carry a reason. SECURITY DEFINER because ai.agents is not tenant-writable; audited as agent.enabled / agent.disabled in the acting owner''s tenant.';

revoke all on function ai.set_agent_status(text, boolean, text) from public, anon;
grant execute on function ai.set_agent_status(text, boolean, text) to authenticated;

create or replace function ai.set_agent_caps(
  p_agent_key      text,
  p_max_steps      int,
  p_max_cost_minor bigint
)
returns table (
  -- 'set'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'bad_caps' | 'unchanged'
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
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.is_owner()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  -- The column CHECKs say > 0; said here too so the caller reads a word
  -- rather than a constraint violation.
  if p_max_steps is null or p_max_steps <= 0 or p_max_steps > 1000
     or p_max_cost_minor is null or p_max_cost_minor <= 0 or p_max_cost_minor > 100000000 then
    return query select 'bad_caps'::text; return;
  end if;

  select jsonb_build_object('key', a.key, 'max_steps', a.max_steps, 'max_cost_minor', a.max_cost_minor)
    into v_before
    from ai.agents a
   where a.key = p_agent_key;

  if v_before is null then
    return query select 'not_found'::text; return;
  end if;

  if (v_before ->> 'max_steps')::int = p_max_steps
     and (v_before ->> 'max_cost_minor')::bigint = p_max_cost_minor then
    return query select 'unchanged'::text; return;
  end if;

  update ai.agents
     set max_steps      = p_max_steps,
         max_cost_minor = p_max_cost_minor
   where key = p_agent_key
  returning jsonb_build_object('key', key, 'max_steps', max_steps, 'max_cost_minor', max_cost_minor)
    into v_after;

  perform core.record_audit(v_org, 'agent.caps_set', 'agent', null, v_before, v_after);

  return query select 'set'::text;
end;
$$;

comment on function ai.set_agent_caps(text, int, bigint) is
  'Sets a registry agent''s max_steps and max_cost_minor from the panel (ADM-82, reversed by the owner on 2026-09-29). Owner only. SECURITY DEFINER because ai.agents is not tenant-writable; audited as agent.caps_set in the acting owner''s tenant.';

revoke all on function ai.set_agent_caps(text, int, bigint) from public, anon;
grant execute on function ai.set_agent_caps(text, int, bigint) to authenticated;

-- ── ADM-88, reversed: a lead score that carries its reasons and inputs ─────
--
-- Decision: reversed by the owner on 2026-09-29.

alter table crm.leads drop constraint if exists leads_no_invented_score;

alter table crm.leads
  add column if not exists score_inputs jsonb,
  add column if not exists scored_at    timestamptz;

-- All four together, or none. A score with no reasons is the invented weight
-- the old rule refused; a score with reasons but no inputs cannot be checked
-- against the lead; a score with no time cannot be told from a stale one.
alter table crm.leads drop constraint if exists leads_score_carries_its_reasons;
alter table crm.leads add constraint leads_score_carries_its_reasons
  check (
    (score is null and score_reasons is null and score_inputs is null and scored_at is null)
    or (
      score is not null
      and score_reasons is not null and jsonb_typeof(score_reasons) = 'array' and jsonb_array_length(score_reasons) > 0
      and score_inputs is not null and jsonb_typeof(score_inputs) = 'object'
      and scored_at is not null
    )
  );

comment on column crm.leads.score is
  'A 0-100 lead score computed deterministically by src/modules/crm/lead-score.ts from the inputs in score_inputs (ADM-88, reversed by the owner on 2026-09-29). Written only by crm.set_lead_score, never without score_reasons, score_inputs and scored_at (leads_score_carries_its_reasons).';

comment on column crm.leads.score_reasons is
  'The non-empty array of {code, points, detail} that add up to score. A score never travels without it.';

comment on column crm.leads.score_inputs is
  'The recorded facts the score was computed from — source, status, ages, qualification, coverage, replies, deal value — as the door received them, so a reader can recompute the number.';

comment on column crm.leads.scored_at is
  'When the score was computed. Moves with score and never alone.';

comment on constraint leads_score_carries_its_reasons on crm.leads is
  'ADM-88 as reversed on 2026-09-29: a score is stored with its reasons, its inputs and its time, or not at all.';

create or replace function crm.set_lead_score(
  p_lead_id uuid,
  p_score   int,
  p_reasons jsonb,
  p_inputs  jsonb
)
returns table (
  -- 'scored'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'bad_score' | 'no_reasons' | 'no_inputs'
  outcome text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.is_internal()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  if p_score is null or p_score < 0 or p_score > 100 then
    return query select 'bad_score'::text; return;
  end if;

  if p_reasons is null or jsonb_typeof(p_reasons) <> 'array' or jsonb_array_length(p_reasons) = 0 then
    return query select 'no_reasons'::text; return;
  end if;

  if p_inputs is null or jsonb_typeof(p_inputs) <> 'object' then
    return query select 'no_inputs'::text; return;
  end if;

  select jsonb_build_object('score', l.score, 'scored_at', l.scored_at)
    into v_before
    from crm.leads l
   where l.id = p_lead_id
     and l.organization_id = v_org
     and l.deleted_at is null;

  if v_before is null then
    return query select 'not_found'::text; return;
  end if;

  -- security invoker: leads_write decides again whether this caller may
  -- write the row at all, and a caller it refuses updates nothing.
  update crm.leads
     set score         = p_score,
         score_reasons = p_reasons,
         score_inputs  = p_inputs,
         scored_at     = now()
   where id = p_lead_id
     and organization_id = v_org
     and deleted_at is null
  returning jsonb_build_object('score', score, 'score_reasons', score_reasons, 'score_inputs', score_inputs, 'scored_at', scored_at)
    into v_after;

  if v_after is null then
    return query select 'not_authorized'::text; return;
  end if;

  perform core.record_audit(v_org, 'lead.scored', 'lead', p_lead_id, v_before, v_after);

  return query select 'scored'::text;
end;
$$;

comment on function crm.set_lead_score(uuid, int, jsonb, jsonb) is
  'The one door that writes a lead score (ADM-88, reversed by the owner on 2026-09-29). Refuses a score without a non-empty reasons array or an inputs object; security invoker, so leads_write decides again. Audited as lead.scored.';

revoke all on function crm.set_lead_score(uuid, int, jsonb, jsonb) from public, anon;
grant execute on function crm.set_lead_score(uuid, int, jsonb, jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';
