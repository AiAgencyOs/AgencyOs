-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 6 — the Email engine's decisions, without its senses.
--
-- Spec §4, §12, §52, §122, §123, §170, §184 and the mandatory email test (§81).
-- What exists: a governed SENDER (campaigns, suppression, the chokepoint) and a
-- READER (replies, bounces, unsubscribes). What does not: any step that decides
-- WHO is worth emailing, whether what is about to be said is grounded, what
-- happens to a person who answers, or whether a follow-up is still right.
--
-- This migration builds those decisions. It deliberately does NOT build the
-- engine's two SENSES - discovering prospects from the open web and an AI
-- writing the message - because both need things that do not exist yet (a
-- discovery source and a funded model). Everything here is what a model's or a
-- person's output is checked against, so when those arrive they are held to it:
--
--  1. QUALIFICATION IS CONFIGURABLE AND DETERMINISTIC, AND A SCORE NEVER
--     OVERRIDES A RULE (spec §8). The Admin owns versioned factor weights; an
--     evaluator (a person, a rule, later an agent) supplies factor values; the
--     score is arithmetic. Then hard rules from the ICP, the block list,
--     suppression and the active target services can disqualify regardless of
--     a 95. Every result keeps its reasoning, signals, what is missing, the
--     rules that fired, and the model and ICP versions used - append-only, so a
--     decision made under v2 stays explainable after v3.
--
--  2. A MESSAGE MAY ONLY SAY WHAT THE RESEARCH SUPPORTS (spec §12, §170).
--     prospect_facts records each fact with its source; validate_outreach_draft
--     refuses a draft whose personalisation does not cite a recorded fact for
--     THAT prospect, whose cited text is not actually in the body, or which
--     uses manufactured urgency or scarcity. It is a check on output, so it
--     holds whoever - or whatever - wrote the draft.
--
--  3. A REPLY BECOMES A LEAD THE EMAIL AGENT OWNS (spec §81, §40). Until now a
--     prospect who answered stopped the sequence and waited for a person to
--     press "convert". The prospect's status moving to 'replied' now adopts
--     them: one identity (crm.resolve_identity, never a second contact), one
--     lead, the email agent as conversation owner, and the whole history as
--     touchpoints - every outreach send at its own time, so first touch is the
--     first email, then the reply. It never grants consent. A failure audits
--     and swallows: a reply must still stop the sequence.
--
--  4. A FOLLOW-UP IS RE-CHECKED AT THE MOMENT OF SENDING (spec §122). The
--     chokepoint already refuses suppressed, stopped and unconsented people.
--     It now also refuses when the lead has since closed (WON/LOST/
--     DISQUALIFIED), another agent owns the conversation, a meeting is live,
--     or a meeting/quotation subtask is open. crm.claim_outreach_sends is
--     carried forward from its live definition with ONE marked edit.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the vocabulary ──────────────────────────────────────────────────────

create or replace function crm.qualification_factors()
returns text[] language sql immutable parallel safe set search_path = '' as $$
  select array['need_clarity', 'service_fit', 'budget_fit', 'timeline_fit', 'decision_maker', 'feasibility',
               'urgency', 'engagement', 'response_quality', 'trust_readiness', 'commercial_potential'];
$$;

-- ── 2. versioned weights, block list, research facts, qualifications ───────

create table if not exists crm.qualification_models (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  version          integer not null check (version >= 1),
  weights          jsonb not null check (jsonb_typeof(weights) = 'object'),
  note             text check (note is null or length(note) <= 500),
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (organization_id, version)
);
comment on table crm.qualification_models is
  'The Admin''s factor weights (spec §8), versioned and immutable: a change is the NEXT version, so a past score stays explainable. With none saved, every factor weighs the same.';

create table if not exists crm.blocked_prospects (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  kind             text not null check (kind in ('email', 'domain', 'company')),
  value            text not null check (value = lower(btrim(value)) and length(value) between 2 and 200),
  reason           text not null check (length(btrim(reason)) between 3 and 300),
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  lifted_at        timestamptz,
  lifted_by        uuid references core.users(id) on delete set null,
  lift_reason      text check (lift_reason is null or length(lift_reason) <= 300)
);
create unique index if not exists blocked_prospects_active_key on crm.blocked_prospects (organization_id, kind, value) where lifted_at is null;
comment on table crm.blocked_prospects is 'People, domains and companies the agency will never prospect (spec §4). Lifting a block keeps the row.';

create table if not exists crm.prospect_facts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  prospect_id      uuid not null references crm.outreach_prospects(id) on delete cascade,
  fact             text not null check (length(btrim(fact)) between 3 and 500),
  source_kind      text not null check (source_kind in ('website', 'linkedin', 'directory', 'press', 'manual', 'email_reply')),
  source_url       text check (source_url is null or (length(source_url) <= 500 and source_url ~* '^https?://')),
  observed_at      timestamptz not null default now(),
  recorded_by_type text not null default 'human' check (recorded_by_type in ('human', 'agent', 'rule')),
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists prospect_facts_prospect_idx on crm.prospect_facts (prospect_id, created_at);
comment on table crm.prospect_facts is
  'What is actually known about a prospect, each fact with where it came from. The only things an outreach message may personalise on (crm.validate_outreach_draft). Append-only: a wrong fact is superseded by a new one, never edited away.';

create table if not exists crm.prospect_qualifications (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  prospect_id      uuid not null references crm.outreach_prospects(id) on delete cascade,
  model_version    integer not null,
  icp_version      integer,
  score            integer not null check (score between 0 and 100),
  factor_scores    jsonb not null check (jsonb_typeof(factor_scores) = 'object'),
  reasoning        text check (reasoning is null or length(reasoning) <= 2000),
  signals          jsonb not null default '{}'::jsonb check (jsonb_typeof(signals) = 'object'),
  missing_information jsonb not null default '[]'::jsonb check (jsonb_typeof(missing_information) = 'array'),
  disqualifiers    jsonb not null default '[]'::jsonb check (jsonb_typeof(disqualifiers) = 'array'),
  decision         text not null check (decision in ('qualified', 'needs_more_info', 'disqualified')),
  threshold        integer not null check (threshold between 0 and 100),
  evaluated_by_type text not null check (evaluated_by_type in ('human', 'agent', 'rule')),
  evaluated_by     uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default clock_timestamp(),
  -- A disqualifier decides, whatever the score.
  constraint prospect_qualifications_rules_outrank_score check (decision <> 'qualified' or jsonb_array_length(disqualifiers) = 0)
);
create index if not exists prospect_qualifications_prospect_idx on crm.prospect_qualifications (prospect_id, created_at desc);
comment on table crm.prospect_qualifications is
  'Every qualification decision, append-only (spec §8): the score, the factor values it came from, the reasoning, what was missing, the rules that disqualified, and the model and ICP versions used. A qualified decision with a disqualifier is unrepresentable.';

-- ── tenancy, privileges, history ───────────────────────────────────────────

create or replace function crm.engine_history_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'this record is history; add a new one instead' using errcode = '42501';
end;
$$;
drop trigger if exists qualification_models_immutable on crm.qualification_models;
create trigger qualification_models_immutable before update or delete on crm.qualification_models for each row execute function crm.engine_history_only();
drop trigger if exists prospect_facts_immutable on crm.prospect_facts;
create trigger prospect_facts_immutable before update or delete on crm.prospect_facts for each row execute function crm.engine_history_only();
drop trigger if exists prospect_qualifications_immutable on crm.prospect_qualifications;
create trigger prospect_qualifications_immutable before update or delete on crm.prospect_qualifications for each row execute function crm.engine_history_only();

create or replace function crm.blocked_prospect_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a block is history; lift it instead' using errcode = '42501'; end if;
  if (new.organization_id, new.kind, new.value, new.reason, new.created_at) is distinct from (old.organization_id, old.kind, old.value, old.reason, old.created_at) then
    raise exception 'what was blocked, and why, is fixed' using errcode = '42501';
  end if;
  if old.lifted_at is not null then raise exception 'a lifted block stays lifted; block again instead' using errcode = '23514'; end if;
  return new;
end;
$$;
drop trigger if exists blocked_prospect_guard on crm.blocked_prospects;
create trigger blocked_prospect_guard before update or delete on crm.blocked_prospects for each row execute function crm.blocked_prospect_guard();

drop trigger if exists freeze_org_qualification_models on crm.qualification_models;
create trigger freeze_org_qualification_models before update of organization_id on crm.qualification_models for each row execute function core.freeze_organization_id();
alter table crm.qualification_models enable row level security;
alter table crm.qualification_models force row level security;
drop policy if exists qualification_models_select on crm.qualification_models;
create policy qualification_models_select on crm.qualification_models for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.qualification_models from public, anon, authenticated;
grant select on crm.qualification_models to authenticated;
grant select, insert on crm.qualification_models to service_role;

drop trigger if exists freeze_org_blocked_prospects on crm.blocked_prospects;
create trigger freeze_org_blocked_prospects before update of organization_id on crm.blocked_prospects for each row execute function core.freeze_organization_id();
alter table crm.blocked_prospects enable row level security;
alter table crm.blocked_prospects force row level security;
drop policy if exists blocked_prospects_select on crm.blocked_prospects;
create policy blocked_prospects_select on crm.blocked_prospects for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.blocked_prospects from public, anon, authenticated;
grant select on crm.blocked_prospects to authenticated;
grant select, insert, update on crm.blocked_prospects to service_role;

drop trigger if exists freeze_org_prospect_facts on crm.prospect_facts;
create trigger freeze_org_prospect_facts before update of organization_id on crm.prospect_facts for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_prospect_facts_prospect on crm.prospect_facts;
create trigger org_match_prospect_facts_prospect before insert or update of prospect_id, organization_id on crm.prospect_facts
  for each row execute function core.enforce_parent_org('prospect_id', 'crm.outreach_prospects');
alter table crm.prospect_facts enable row level security;
alter table crm.prospect_facts force row level security;
drop policy if exists prospect_facts_select on crm.prospect_facts;
create policy prospect_facts_select on crm.prospect_facts for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.prospect_facts from public, anon, authenticated;
grant select on crm.prospect_facts to authenticated;
grant select, insert on crm.prospect_facts to service_role;

drop trigger if exists freeze_org_prospect_qualifications on crm.prospect_qualifications;
create trigger freeze_org_prospect_qualifications before update of organization_id on crm.prospect_qualifications for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_prospect_qualifications_prospect on crm.prospect_qualifications;
create trigger org_match_prospect_qualifications_prospect before insert or update of prospect_id, organization_id on crm.prospect_qualifications
  for each row execute function core.enforce_parent_org('prospect_id', 'crm.outreach_prospects');
alter table crm.prospect_qualifications enable row level security;
alter table crm.prospect_qualifications force row level security;
drop policy if exists prospect_qualifications_select on crm.prospect_qualifications;
create policy prospect_qualifications_select on crm.prospect_qualifications for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.prospect_qualifications from public, anon, authenticated;
grant select on crm.prospect_qualifications to authenticated;
grant select, insert on crm.prospect_qualifications to service_role;

-- ── 3. Admin doors: weights and blocks ─────────────────────────────────────

create or replace function crm.save_qualification_model(p_weights jsonb, p_note text)
returns table (outcome text, version integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_key   text;
  v_val   jsonb;
  v_sum   numeric := 0;
  v_next  integer;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::integer; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text, null::integer; return; end if;
  if p_weights is null or jsonb_typeof(p_weights) <> 'object' or p_weights = '{}'::jsonb then return query select 'invalid'::text, null::integer; return; end if;
  for v_key, v_val in select e.key, e.value from jsonb_each(p_weights) as e loop
    if not (v_key = any (crm.qualification_factors())) or jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric < 0 or (v_val #>> '{}')::numeric > 100 then
      return query select 'invalid'::text, null::integer; return;
    end if;
    v_sum := v_sum + (v_val #>> '{}')::numeric;
  end loop;
  if v_sum <= 0 then return query select 'invalid'::text, null::integer; return; end if;
  perform pg_advisory_xact_lock(hashtextextended('qualmodel:' || v_org::text, 0));
  select coalesce(max(m.version), 0) + 1 into v_next from crm.qualification_models m where m.organization_id = v_org;
  insert into crm.qualification_models (organization_id, version, weights, note, created_by) values (v_org, v_next, p_weights, nullif(btrim(coalesce(p_note, '')), ''), v_actor);
  perform core.record_audit(v_org, 'qualification.model_saved', 'qualification_model', null, null, jsonb_build_object('version', v_next, 'weights', p_weights));
  return query select 'saved'::text, v_next;
end;
$$;
revoke all on function crm.save_qualification_model(jsonb, text) from public, anon;
grant execute on function crm.save_qualification_model(jsonb, text) to authenticated;

create or replace function crm.current_qualification_weights(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select m.weights from crm.qualification_models m where m.organization_id = p_organization_id order by m.version desc limit 1),
    (select jsonb_object_agg(f, 1) from unnest(crm.qualification_factors()) as f));
$$;
revoke all on function crm.current_qualification_weights(uuid) from public, anon;
grant execute on function crm.current_qualification_weights(uuid) to authenticated, service_role;

create or replace function crm.block_prospect(p_kind text, p_value text, p_reason text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_value text := lower(btrim(coalesce(p_value, '')));
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text; return; end if;
  if p_kind not in ('email', 'domain', 'company') or length(v_value) not between 2 and 200 or length(btrim(coalesce(p_reason, ''))) not between 3 and 300
     or (p_kind = 'email' and crm.norm_email(v_value) is null) or (p_kind = 'domain' and crm.norm_domain(v_value) is null) then
    return query select 'invalid'::text; return;
  end if;
  begin
    insert into crm.blocked_prospects (organization_id, kind, value, reason, created_by) values (v_org, p_kind, v_value, btrim(p_reason), v_actor);
  exception when unique_violation then return query select 'already_blocked'::text; return; end;
  perform core.record_audit(v_org, 'prospect.blocked', 'blocked_prospect', null, null, jsonb_build_object('kind', p_kind, 'value', v_value, 'reason', btrim(p_reason)));
  return query select 'blocked'::text;
end;
$$;
revoke all on function crm.block_prospect(text, text, text) from public, anon;
grant execute on function crm.block_prospect(text, text, text) to authenticated;

create or replace function crm.lift_prospect_block(p_block uuid, p_reason text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  b crm.blocked_prospects;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  -- Un-blocking someone is loosening a safety rule: the owner's.
  if not coalesce((select core.is_owner()), false) then return query select 'not_owner'::text; return; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then return query select 'needs_reason'::text; return; end if;
  select * into b from crm.blocked_prospects x where x.id = p_block and x.organization_id = v_org for update;
  if b.id is null then return query select 'not_found'::text; return; end if;
  if b.lifted_at is not null then return query select 'already_lifted'::text; return; end if;
  update crm.blocked_prospects set lifted_at = now(), lifted_by = v_actor, lift_reason = left(btrim(p_reason), 300) where id = b.id;
  perform core.record_audit(v_org, 'prospect.block_lifted', 'blocked_prospect', b.id, null, jsonb_build_object('reason', btrim(p_reason)));
  return query select 'lifted'::text;
end;
$$;
revoke all on function crm.lift_prospect_block(uuid, text) from public, anon;
grant execute on function crm.lift_prospect_block(uuid, text) to authenticated;

-- ── 4. research facts ──────────────────────────────────────────────────────

create or replace function crm.add_prospect_fact(p_organization_id uuid, p_prospect uuid, p_fact text, p_source_kind text, p_source_url text, p_recorded_by_type text default 'human')
returns table (outcome text, fact_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_id uuid;
begin
  if v_actor is not null then
    if p_organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false) then
      return query select 'forbidden'::text, null::uuid; return;
    end if;
  end if;
  if not exists (select 1 from crm.outreach_prospects p where p.id = p_prospect and p.organization_id = p_organization_id) then
    return query select 'unknown_prospect'::text, null::uuid; return;
  end if;
  if length(btrim(coalesce(p_fact, ''))) not between 3 and 500 or p_source_kind not in ('website', 'linkedin', 'directory', 'press', 'manual', 'email_reply')
     or p_recorded_by_type not in ('human', 'agent', 'rule') or (p_source_url is not null and p_source_url !~* '^https?://') then
    return query select 'invalid'::text, null::uuid; return;
  end if;
  -- A fact that can be checked has a source; only a person may assert one from their own knowledge.
  if p_source_kind <> 'manual' and p_source_kind <> 'email_reply' and p_source_url is null then return query select 'needs_source'::text, null::uuid; return; end if;
  if p_source_kind = 'manual' and p_recorded_by_type <> 'human' then return query select 'needs_source'::text, null::uuid; return; end if;
  insert into crm.prospect_facts (organization_id, prospect_id, fact, source_kind, source_url, recorded_by_type, created_by)
  values (p_organization_id, p_prospect, btrim(p_fact), p_source_kind, p_source_url, p_recorded_by_type, v_actor) returning id into v_id;
  return query select 'recorded'::text, v_id;
end;
$$;
revoke all on function crm.add_prospect_fact(uuid, uuid, text, text, text, text) from public, anon;
grant execute on function crm.add_prospect_fact(uuid, uuid, text, text, text, text) to authenticated, service_role;

-- ── 5. qualification: arithmetic, then the rules that outrank it ───────────

create or replace function crm.qualify_prospect(
  p_organization_id uuid, p_prospect uuid, p_factors jsonb, p_reasoning text, p_signals jsonb, p_evaluated_by_type text default 'human'
)
returns table (outcome text, qualification_id uuid, decision text, score integer, disqualifiers jsonb, missing jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  p        crm.outreach_prospects;
  v_w      jsonb := crm.current_qualification_weights(p_organization_id);
  v_mver   integer;
  v_icp    crm.icp_versions;
  v_def    jsonb;
  v_threshold integer;
  v_sig    jsonb := coalesce(p_signals, '{}'::jsonb);
  v_dis    jsonb := '[]'::jsonb;
  v_miss   jsonb := '[]'::jsonb;
  v_num    numeric := 0;
  v_den    numeric := 0;
  v_score  integer;
  v_dec    text;
  v_id     uuid;
  k text; wv numeric; fv numeric;
  v_domain text;
  v_industry text; v_country text; v_service text;
  v_excl text;
begin
  if v_actor is not null then
    if p_organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false) then
      return query select 'forbidden'::text, null::uuid, null::text, null::integer, null::jsonb, null::jsonb; return;
    end if;
  end if;
  if p_factors is null or jsonb_typeof(p_factors) <> 'object' or jsonb_typeof(v_sig) <> 'object'
     or p_evaluated_by_type not in ('human', 'agent', 'rule') or length(coalesce(p_reasoning, '')) > 2000 then
    return query select 'invalid'::text, null::uuid, null::text, null::integer, null::jsonb, null::jsonb; return;
  end if;
  for k in select jsonb_object_keys(p_factors) loop
    if not (k = any (crm.qualification_factors())) or jsonb_typeof(p_factors -> k) <> 'number' or (p_factors ->> k)::numeric not between 0 and 100 then
      return query select 'invalid'::text, null::uuid, null::text, null::integer, null::jsonb, null::jsonb; return;
    end if;
  end loop;
  select * into p from crm.outreach_prospects x where x.id = p_prospect and x.organization_id = p_organization_id;
  if p.id is null then return query select 'unknown_prospect'::text, null::uuid, null::text, null::integer, null::jsonb, null::jsonb; return; end if;

  select coalesce(max(m.version), 0) into v_mver from crm.qualification_models m where m.organization_id = p_organization_id;
  select * into v_icp from crm.icp_versions i where i.organization_id = p_organization_id order by i.version desc limit 1;
  v_def := coalesce(v_icp.definition, '{}'::jsonb);
  v_threshold := coalesce((v_def ->> 'min_qualification_score')::integer, 50);

  -- The arithmetic. Every weighted factor counts in the denominator, so a factor nobody supplied LOWERS the score and is listed as missing.
  for k, wv in select e.key, (e.value #>> '{}')::numeric from jsonb_each(v_w) as e loop
    v_den := v_den + wv;
    if p_factors ? k then
      fv := (p_factors ->> k)::numeric;
      v_num := v_num + wv * fv;
    elsif wv > 0 then
      v_miss := v_miss || to_jsonb(k);
    end if;
  end loop;
  v_score := case when v_den > 0 then least(100, greatest(0, round(v_num / v_den)::integer)) else 0 end;

  -- The rules. They are not weighed against the score; they decide whatever it is.
  v_domain := coalesce(crm.norm_domain(p.email), crm.norm_domain(p.website));
  v_industry := lower(btrim(coalesce(v_sig ->> 'industry', '')));
  v_country := lower(btrim(coalesce(v_sig ->> 'country', '')));
  v_service := lower(btrim(coalesce(v_sig ->> 'service', '')));

  if exists (select 1 from crm.email_suppressions s where s.organization_id = p_organization_id and s.email = p.email) then v_dis := v_dis || to_jsonb('suppressed'::text); end if;
  if p.status = 'do_not_contact' then v_dis := v_dis || to_jsonb('do_not_contact'::text); end if;
  if exists (select 1 from crm.blocked_prospects b where b.organization_id = p_organization_id and b.lifted_at is null and (
       (b.kind = 'email' and b.value = p.email) or (b.kind = 'domain' and b.value = v_domain) or (b.kind = 'company' and b.value = lower(btrim(coalesce(p.company, '')))))) then
    v_dis := v_dis || to_jsonb('blocked'::text);
  end if;
  if jsonb_typeof(v_def -> 'exclusions') = 'array' then
    for v_excl in select lower(btrim(x)) from jsonb_array_elements_text(v_def -> 'exclusions') as x loop
      if v_excl <> '' and (v_excl = v_industry or v_excl = v_country or v_excl = lower(btrim(coalesce(p.company, ''))) or v_excl = v_domain) then
        v_dis := v_dis || to_jsonb('icp_exclusion:' || v_excl);
      end if;
    end loop;
  end if;
  if jsonb_typeof(v_def -> 'geographies') = 'array' and jsonb_array_length(v_def -> 'geographies') > 0 then
    if v_country = '' then v_miss := v_miss || to_jsonb('country'::text);
    elsif not exists (select 1 from jsonb_array_elements_text(v_def -> 'geographies') g where lower(btrim(g)) = v_country) then v_dis := v_dis || to_jsonb('outside_target_geography'::text); end if;
  end if;
  if jsonb_typeof(v_def -> 'industries') = 'array' and jsonb_array_length(v_def -> 'industries') > 0 then
    if v_industry = '' then v_miss := v_miss || to_jsonb('industry'::text);
    elsif not exists (select 1 from jsonb_array_elements_text(v_def -> 'industries') g where lower(btrim(g)) = v_industry) then v_dis := v_dis || to_jsonb('outside_target_industry'::text); end if;
  end if;
  if v_service = '' then v_miss := v_miss || to_jsonb('service'::text);
  elsif not exists (select 1 from crm.target_services t where t.organization_id = p_organization_id and t.active and lower(btrim(t.name)) = v_service) then
    v_dis := v_dis || to_jsonb('service_not_targeted'::text);
  end if;

  v_dec := case
    when jsonb_array_length(v_dis) > 0 then 'disqualified'
    when v_score >= v_threshold and jsonb_array_length(v_miss) = 0 then 'qualified'
    when jsonb_array_length(v_miss) > 0 then 'needs_more_info'
    else 'disqualified' end;
  if v_dec = 'disqualified' and jsonb_array_length(v_dis) = 0 then v_dis := v_dis || to_jsonb('below_threshold'::text); end if;

  insert into crm.prospect_qualifications (organization_id, prospect_id, model_version, icp_version, score, factor_scores, reasoning, signals,
                                            missing_information, disqualifiers, decision, threshold, evaluated_by_type, evaluated_by)
  values (p_organization_id, p.id, v_mver, v_icp.version, v_score, p_factors, nullif(btrim(coalesce(p_reasoning, '')), ''), v_sig, v_miss, v_dis, v_dec, v_threshold, p_evaluated_by_type, v_actor)
  returning id into v_id;
  perform core.record_audit(p_organization_id, 'prospect.qualified', 'outreach_prospect', p.id, null,
    jsonb_build_object('decision', v_dec, 'score', v_score, 'disqualifiers', v_dis, 'model_version', v_mver, 'icp_version', v_icp.version));
  return query select 'recorded'::text, v_id, v_dec, v_score, v_dis, v_miss;
end;
$$;
revoke all on function crm.qualify_prospect(uuid, uuid, jsonb, text, jsonb, text) from public, anon;
grant execute on function crm.qualify_prospect(uuid, uuid, jsonb, text, jsonb, text) to authenticated, service_role;

-- ── 6. a message may only say what the research supports ───────────────────

create or replace function crm.validate_outreach_draft(p_organization_id uuid, p_prospect uuid, p_subject text, p_body text, p_claims jsonb)
returns table (valid boolean, problems jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_problems jsonb := '[]'::jsonb;
  c jsonb;
  v_text text;
  v_fact uuid;
  v_all text := lower(coalesce(p_subject, '') || ' ' || coalesce(p_body, ''));
  v_phrase text;
begin
  if (select auth.uid()) is not null and p_organization_id is distinct from (select core.current_organization_id()) then
    return query select false, '["forbidden"]'::jsonb; return;
  end if;
  if not exists (select 1 from crm.outreach_prospects p where p.id = p_prospect and p.organization_id = p_organization_id) then
    return query select false, '["unknown_prospect"]'::jsonb; return;
  end if;
  if length(btrim(coalesce(p_subject, ''))) < 3 or length(btrim(coalesce(p_body, ''))) < 20 then v_problems := v_problems || to_jsonb('too_short'::text); end if;
  if p_claims is null or jsonb_typeof(p_claims) <> 'array' then
    return query select false, v_problems || to_jsonb('claims_must_be_a_list'::text); return;
  end if;

  -- Every personalisation claim must cite a recorded fact about THIS prospect, and its words must actually be in the message.
  for c in select e.value from jsonb_array_elements(p_claims) as e loop
    v_text := lower(btrim(coalesce(c ->> 'text', '')));
    begin v_fact := (c ->> 'fact_id')::uuid; exception when others then v_fact := null; end;
    if v_text = '' then v_problems := v_problems || to_jsonb('empty_claim'::text); continue; end if;
    if v_fact is null or not exists (select 1 from crm.prospect_facts f where f.id = v_fact and f.prospect_id = p_prospect and f.organization_id = p_organization_id) then
      v_problems := v_problems || to_jsonb('unsupported_claim:' || left(v_text, 60));
    elsif position(v_text in v_all) = 0 then
      v_problems := v_problems || to_jsonb('claim_not_in_message:' || left(v_text, 60));
    end if;
  end loop;

  -- Manufactured urgency or scarcity, guarantees and flattery that stands in for a fact (spec §12, §170).
  foreach v_phrase in array array['limited time', 'act now', 'only today', 'last chance', 'offer expires', 'hurry', 'don''t miss out', 'before it''s too late',
                                  'only a few spots', 'while stocks last', 'guaranteed results', '100% guarantee', 'we guarantee', 'risk-free', 'once in a lifetime'] loop
    if position(v_phrase in v_all) > 0 then v_problems := v_problems || to_jsonb('manufactured_urgency:' || v_phrase); end if;
  end loop;
  -- Familiarity the prospect has not earned: "I saw your recent post" with no claim backing it.
  foreach v_phrase in array array['i saw your recent', 'i noticed your recent', 'i came across your', 'i was impressed by your', 'congratulations on your'] loop
    if position(v_phrase in v_all) > 0 and jsonb_array_length(p_claims) = 0 then v_problems := v_problems || to_jsonb('familiarity_without_a_fact:' || v_phrase); end if;
  end loop;

  return query select jsonb_array_length(v_problems) = 0, v_problems;
end;
$$;
revoke all on function crm.validate_outreach_draft(uuid, uuid, text, text, jsonb) from public, anon;
grant execute on function crm.validate_outreach_draft(uuid, uuid, text, text, jsonb) to authenticated, service_role;

-- ── 7. is this follow-up still right? ──────────────────────────────────────

create or replace function crm.email_followup_blockers(p_organization_id uuid, p_prospect uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p crm.outreach_prospects;
  v_out text[] := '{}';
  l record;
begin
  select * into p from crm.outreach_prospects x where x.id = p_prospect and x.organization_id = p_organization_id;
  if p.id is null then return array['unknown_prospect']; end if;
  if exists (select 1 from crm.email_suppressions s where s.organization_id = p_organization_id and s.email = p.email) then v_out := array_append(v_out, ('suppressed')::text); end if;
  if p.status in ('replied', 'converted', 'do_not_contact') then v_out := array_append(v_out, (('prospect_' || p.status))::text); end if;

  -- One person across channels: every lead this PERSON has, whichever channel made it - the prospect's own lead and any lead of
  -- the contact that holds this email address (a WhatsApp enquiry, an ad lead, a client).
  for l in
    select distinct ld.id from crm.leads ld
     where ld.organization_id = p_organization_id and ld.merged_into_lead_id is null
       and (ld.id = p.lead_id
            or ld.contact_id in (select k.contact_id from crm.identity_keys k where k.organization_id = p_organization_id and k.kind = 'email' and k.value = p.email)
            or ld.contact_id = p.contact_id)
  loop
    if crm.lead_outcome(l.id) in ('WON', 'LOST', 'DISQUALIFIED') then
      v_out := array_append(v_out, ('lead_closed')::text);
    else
      if exists (select 1 from crm.lead_conversation_owner o where o.lead_id = l.id and o.owner <> 'email_outreach') then v_out := array_append(v_out, ('owner_moved')::text); end if;
      if exists (select 1 from crm.meetings m where m.lead_id = l.id and m.status in ('requested', 'proposed', 'booked')) then v_out := array_append(v_out, ('meeting_in_progress')::text); end if;
      if exists (select 1 from crm.subtask_requests t where t.lead_id = l.id and t.status in ('REQUESTED', 'IN_PROGRESS')) then v_out := array_append(v_out, ('subtask_open')::text); end if;
    end if;
  end loop;
  if crm.acquisition_blocked(p_organization_id, 'email') is not null then v_out := array_append(v_out, ('channel_blocked')::text); end if;
  return (select coalesce(array_agg(distinct b), '{}') from unnest(v_out) b);
end;
$$;
revoke all on function crm.email_followup_blockers(uuid, uuid) from public, anon, authenticated;
grant execute on function crm.email_followup_blockers(uuid, uuid) to service_role;

-- ── 8. a reply is adopted into the shared identity, with the email agent as owner ──

create or replace function crm._assign_first_owner(p_organization_id uuid, p_lead uuid, p_owner text, p_reason text, p_state text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_rows integer;
begin
  insert into crm.lead_conversation_owner (lead_id, organization_id, owner) values (p_lead, p_organization_id, p_owner) on conflict (lead_id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    insert into crm.conversation_owner_transfers (organization_id, lead_id, from_owner, to_owner, reason, workflow_state)
    values (p_organization_id, p_lead, null, p_owner, p_reason, p_state);
    perform core.record_audit(p_organization_id, 'identity.conversation_owner_transferred', 'lead', p_lead, null, jsonb_build_object('owner', p_owner, 'reason', p_reason));
    return true;
  end if;
  return false;
end;
$$;
revoke all on function crm._assign_first_owner(uuid, uuid, text, text, text) from public, anon, authenticated;

create or replace function crm._adopt_replied_prospect()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r record;
  s record;
  v_contact uuid;
  v_lead uuid := new.lead_id;
  v_n int := 0;
begin
  if new.status <> 'replied' or old.status = 'replied' then return new; end if;

  if v_lead is null then
    select * into r from crm.resolve_identity(new.organization_id, jsonb_strip_nulls(jsonb_build_object('name', new.full_name, 'email', new.email, 'company', new.company, 'website', new.website)), 'email_outreach');
    if r.outcome not in ('matched', 'created', 'created_pending_review') or r.contact_id is null then
      -- A conflicting identity is for a person to settle; the reply still stops the sequence (it already did).
      perform core.record_audit(new.organization_id, 'email.adopt_deferred', 'outreach_prospect', new.id, null, jsonb_build_object('identity_outcome', r.outcome, 'review_id', r.review_id));
      return new;
    end if;
    v_contact := r.contact_id;
    -- One person, one open lead: if they already have one (a WhatsApp enquiry, an ad lead) the outreach history attaches to IT. A second
    -- lead for the same person would be two agents negotiating with one buyer, and the email agent never takes ownership of a lead
    -- someone else already owns (_assign_first_owner only fills an empty seat).
    select l.id into v_lead from crm.leads l
     where l.organization_id = new.organization_id and l.contact_id = v_contact and l.merged_into_lead_id is null and crm.lead_outcome(l.id) = 'OPEN'
     order by l.created_at, l.id limit 1;
    if v_lead is null then
      insert into crm.leads (organization_id, contact_id, title, source, source_ref, status)
      values (new.organization_id, v_contact, coalesce(new.company, new.full_name, new.email) || ' (email outreach)', 'email', 'outreach:' || new.id::text, 'new')
      on conflict (organization_id, source, source_ref) where source_ref is not null do nothing
      returning id into v_lead;
      if v_lead is null then
        select l.id into v_lead from crm.leads l where l.organization_id = new.organization_id and l.source = 'email' and l.source_ref = 'outreach:' || new.id::text;
      end if;
    end if;
    update crm.outreach_prospects set contact_id = coalesce(contact_id, v_contact), lead_id = v_lead where id = new.id;
  end if;

  perform crm._assign_first_owner(new.organization_id, v_lead, 'email_outreach', 'the prospect replied to an outreach email', 'prospect_replied');

  -- The true first touch is the first email we sent, not the moment of the reply.
  for s in select x.id, x.campaign_id, x.step_number, x.sent_at from crm.email_outreach_sends x
            where x.organization_id = new.organization_id and x.email = new.email and x.status = 'sent' and x.sent_at is not null order by x.sent_at loop
    perform crm.record_touchpoint(new.organization_id, v_lead, 'email', null, 'outreach_sent',
      jsonb_build_object('campaign_id', s.campaign_id, 'step_number', s.step_number), '{}', 'send:' || s.id::text, s.sent_at);
    v_n := v_n + 1;
  end loop;
  perform crm.record_touchpoint(new.organization_id, v_lead, 'email', null, 'reply_received', '{}', '{}', 'reply:' || new.id::text, now());

  perform core.record_audit(new.organization_id, 'email.prospect_adopted', 'outreach_prospect', new.id, null, jsonb_build_object('lead_id', v_lead, 'sends_recorded', v_n));
  return new;
exception when others then
  begin perform core.record_audit(new.organization_id, 'email.adopt_failed', 'outreach_prospect', new.id, null, jsonb_build_object('error', sqlerrm));
  exception when others then null; end;
  return new;
end;
$$;
revoke all on function crm._adopt_replied_prospect() from public, anon, authenticated;
drop trigger if exists adopt_replied_prospect on crm.outreach_prospects;
create trigger adopt_replied_prospect after update of status on crm.outreach_prospects
  for each row when (new.status = 'replied' and old.status is distinct from 'replied')
  execute function crm._adopt_replied_prospect();

-- ── 9. the funnel, from the records that are the truth ─────────────────────

create or replace function crm.email_funnel(p_since timestamptz default null)
returns table (stage text, n bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with since as (select coalesce(p_since, '-infinity'::timestamptz) as t),
       prospects as (select p.* from crm.outreach_prospects p, since where p.created_at >= since.t),
       latest as (
         select distinct on (q.prospect_id) q.prospect_id, q.decision from crm.prospect_qualifications q order by q.prospect_id, q.created_at desc, q.id desc)
  select 'discovered'::text, count(*) from prospects
  union all select 'qualified', count(*) from prospects p join latest l on l.prospect_id = p.id where l.decision = 'qualified'
  union all select 'contacted', count(*) from prospects p where p.status in ('contacted', 'replied', 'converted')
  union all select 'replied', count(*) from prospects p where p.status in ('replied', 'converted') or p.lead_id is not null
  union all select 'meeting_requested', count(distinct t.lead_id) from crm.subtask_requests t join prospects p on p.lead_id = t.lead_id where t.kind = 'schedule_meeting'
  union all select 'meeting_held', count(distinct t.lead_id) from crm.subtask_requests t join prospects p on p.lead_id = t.lead_id where t.kind = 'schedule_meeting' and t.status = 'COMPLETED'
  union all select 'quote_requested', count(distinct t.lead_id) from crm.subtask_requests t join prospects p on p.lead_id = t.lead_id where t.kind = 'prepare_quotation'
  union all select 'won', count(*) from prospects p where p.lead_id is not null and crm.lead_outcome(p.lead_id) = 'WON'
  union all select 'lost', count(*) from prospects p where p.lead_id is not null and crm.lead_outcome(p.lead_id) = 'LOST'
  union all select 'opted_out', count(*) from prospects p where p.status = 'do_not_contact';
$$;
grant execute on function crm.email_funnel(timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
