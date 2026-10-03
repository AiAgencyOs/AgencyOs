-- ═══════════════════════════════════════════════════════════════════════════
-- A lead is scored by two, and a client is edited.
--
-- Bucket F, stream F-B (docs/AGENCYOS_ADMIN_BUCKET_F_PLAN.md — Sales & CRM
-- and Clients, SCR-005–017). Eight things the PDF puts on these screens that
-- the schema could not hold, each one a rule stated here rather than left to
-- a form:
--
--   SCR-008  A person may OVERRIDE the computed lead score, with a reason.
--            The computed score (ADM-88, reversed 2026-09-29) stays exactly
--            what `crm.set_lead_score` wrote; the override sits BESIDE it in
--            four new columns that travel together or not at all
--            (`leads_override_carries_its_reason`), and the one door
--            `crm.override_lead_score` is owner/ops_admin only, refuses a
--            lead that was never scored (there is nothing to override), and
--            audits `lead.score_overridden` / `lead.score_override_cleared`.
--            "AI suggestion vs human decision" is therefore two columns a
--            reader can lay side by side, never one number overwriting the
--            other.
--
--   SCR-008  "Return to discovery when evidence is incomplete": the lead
--            status machine gains qualified → qualifying. `crm.leads_guard`
--            is carried forward whole (20260904170000) with that one edit,
--            and `LEAD_TRANSITIONS` in crm/schema.ts is edited in step — the
--            two lists drifting apart is how a state becomes unreachable in
--            production while every unit test passes.
--
--   SCR-014/015  A client account carries its own legal name, GSTIN, PAN and
--            billing address, and is edited through `core.update_client_account`
--            (name included), audited as `client_account.details_updated`.
--            The GSTIN is CHECKED — shape, state code and the GSTN check
--            character, computed here in `core.gstin_check_character` — so
--            a typo is refused at the door rather than found by the client's
--            accountant. A checksum that passes is still not a registration
--            that is real; the door answers `bad_gstin`, never "verified".
--            finance.billing_profiles (per project, confirmed) is untouched:
--            this is the account's identity, that is a project's confirmed
--            billing mode.
--
--   SCR-015  "Manage assigned team": `core.client_account_members`, the
--            people who work this client, set as a whole through
--            `core.set_client_account_team` (audited `client_account.team_set`).
--            Distinct from `owner_id`, which is ONE person who answers for the
--            relationship.
--
--   SCR-010  A meeting may be linked to a project: `crm.meetings.project_id`,
--            nullable, tenancy-guarded like every other org-scoped FK.
--
--   SCR-013  A follow-up sequence is rescheduled, completed or cancelled by a
--            person WITH A REASON through `crm.decide_follow_up_sequence`.
--            The status set gains `completed` and `cancelled` — both terminal
--            and both a person's decision, which `stopped` (resumable) and
--            `exhausted` (the worker's) are not. Audited per action.
--
--   SCR-016  A renewal or upsell is a NEW opportunity of a stated kind opened
--            from a completed project: `sales.opportunities.kind`
--            (new | renewal | upsell) and `source_project_id`, opened only by
--            `sales.open_renewal`, which refuses a project that is not
--            completed and a lead that already has an open deal
--            (`opportunities_open_lead_key` would refuse it anyway; the door
--            says why first). Audited `opportunity.renewal_opened`.
--
-- SCR-009's requirement payload fields (user roles, platforms, integrations,
-- timeline/budget notes) and SCR-011's delivery status are jsonb shape and
-- a reader respectively — no DDL, stated here so the plan's list is
-- accounted for in one place.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── SCR-008: the override beside the computed score ─────────────────────────

alter table crm.leads
  add column if not exists score_override        int,
  add column if not exists score_override_reason text,
  add column if not exists score_override_by     uuid references core.users(id) on delete set null,
  add column if not exists score_override_at     timestamptz;

alter table crm.leads drop constraint if exists leads_override_carries_its_reason;
alter table crm.leads add constraint leads_override_carries_its_reason
  check (
    (score_override is null and score_override_reason is null and score_override_by is null and score_override_at is null)
    or (
      score_override is not null and score_override between 0 and 100
      and score_override_reason is not null and length(btrim(score_override_reason)) between 1 and 500
      and score_override_by is not null
      and score_override_at is not null
    )
  );

comment on column crm.leads.score_override is
  'A person''s decision about the lead, 0-100, recorded BESIDE the computed score and never in its place (SCR-008). Null means the computed score stands. Written only by crm.override_lead_score, never without its reason, author and time (leads_override_carries_its_reason).';
comment on column crm.leads.score_override_reason is
  'Why the person overrode the computed score, in their own words. Required with the override.';
comment on column crm.leads.score_override_by is
  'Who overrode the score. Required with the override.';
comment on column crm.leads.score_override_at is
  'When the override was recorded. Moves with score_override and never alone.';
comment on constraint leads_override_carries_its_reason on crm.leads is
  'SCR-008: an override is a number with its reason, its author and its time, or nothing.';

create or replace function crm.override_lead_score(
  p_lead_id uuid,
  p_score   int,
  p_reason  text
)
returns table (
  -- 'overridden' | 'cleared'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'not_scored' | 'bad_score' | 'no_reason'
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
  v_reason text := nullif(btrim(p_reason), '');
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;

  -- Owner or ops_admin: a person's number over the model's is a decision
  -- about the pipeline, not an edit to a lead.
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  if v_reason is null or length(v_reason) > 500 then
    return query select 'no_reason'::text; return;
  end if;

  if p_score is not null and (p_score < 0 or p_score > 100) then
    return query select 'bad_score'::text; return;
  end if;

  select jsonb_build_object(
           'score', l.score,
           'score_override', l.score_override,
           'score_override_reason', l.score_override_reason,
           'score_override_at', l.score_override_at)
    into v_before
    from crm.leads l
   where l.id = p_lead_id
     and l.organization_id = v_org
     and l.deleted_at is null;

  if v_before is null then
    return query select 'not_found'::text; return;
  end if;

  -- Nothing to override: the computed score must exist so the two can be
  -- read side by side. Score the lead first.
  if (v_before ->> 'score') is null then
    return query select 'not_scored'::text; return;
  end if;

  -- security invoker: leads_write decides again on the row.
  update crm.leads
     set score_override        = p_score,
         score_override_reason = case when p_score is null then null else v_reason end,
         score_override_by     = case when p_score is null then null else v_actor end,
         score_override_at     = case when p_score is null then null else now() end
   where id = p_lead_id
     and organization_id = v_org
     and deleted_at is null
  returning jsonb_build_object(
              'score', score,
              'score_override', score_override,
              'score_override_reason', score_override_reason,
              'score_override_at', score_override_at,
              'clear_reason', case when p_score is null then v_reason else null end)
    into v_after;

  if v_after is null then
    return query select 'not_authorized'::text; return;
  end if;

  if p_score is null then
    perform core.record_audit(v_org, 'lead.score_override_cleared', 'lead', p_lead_id, v_before, v_after);
    return query select 'cleared'::text;
  else
    perform core.record_audit(v_org, 'lead.score_overridden', 'lead', p_lead_id, v_before, v_after);
    return query select 'overridden'::text;
  end if;
end;
$$;

comment on function crm.override_lead_score(uuid, int, text) is
  'The one door that writes a lead score override (SCR-008). Owner/ops_admin only; requires a reason; refuses a lead that was never scored so the computed score is always visible beside the override; a null score clears the override (reason still required, audited). Security invoker, so leads_write decides again. Audited as lead.score_overridden / lead.score_override_cleared.';

revoke all on function crm.override_lead_score(uuid, int, text) from public, anon;
grant execute on function crm.override_lead_score(uuid, int, text) to authenticated;

-- ── SCR-008: qualified → qualifying ─────────────────────────────────────────
--
-- crm.leads_guard carried forward whole from 20260904170000, with ONE edit
-- marked. The TypeScript restatement (LEAD_TRANSITIONS) is edited in step.

create or replace function crm.leads_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed text[];
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  v_allowed := case old.status
    when 'new'          then array['qualifying', 'disqualified', 'converted']
    when 'qualifying'   then array['qualified', 'nurture', 'disqualified', 'converted']
    -- ── EDIT (SCR-008): back to discovery when the evidence is incomplete ──
    when 'qualified'    then array['qualifying', 'converted', 'nurture', 'disqualified']
    when 'nurture'      then array['qualifying', 'qualified', 'disqualified', 'converted']
    when 'disqualified' then array['qualifying']
    when 'converted'    then array[]::text[]
    else array[]::text[]
  end;

  if not (new.status = any (v_allowed)) then
    raise exception 'a lead cannot move from % to %', old.status, new.status
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

-- ── SCR-014/015: a client's billing identity, edited through a door ─────────

alter table core.client_accounts
  add column if not exists legal_name      text,
  add column if not exists gstin           text,
  add column if not exists pan             text,
  add column if not exists billing_address text;

alter table core.client_accounts drop constraint if exists client_accounts_gstin_shape;
alter table core.client_accounts add constraint client_accounts_gstin_shape
  check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$');

alter table core.client_accounts drop constraint if exists client_accounts_pan_shape;
alter table core.client_accounts add constraint client_accounts_pan_shape
  check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$');

alter table core.client_accounts drop constraint if exists client_accounts_gstin_carries_pan;
alter table core.client_accounts add constraint client_accounts_gstin_carries_pan
  check (gstin is null or pan is null or substr(gstin, 3, 10) = pan);

comment on column core.client_accounts.legal_name is
  'The registered name invoices are addressed to, when it differs from the trading name (SCR-015). Edited only through core.update_client_account.';
comment on column core.client_accounts.gstin is
  'The client''s GSTIN, upper case, shape and GSTN check character verified by core.update_client_account. A checksum that passes is not a registration that is real: nothing here talks to the GST portal.';
comment on column core.client_accounts.pan is
  'The client''s PAN. When a GSTIN is also recorded, characters 3-12 of it ARE the PAN, and client_accounts_gstin_carries_pan refuses a pair that disagree.';
comment on column core.client_accounts.billing_address is
  'The address invoices carry for this account (SCR-015).';

-- The GSTN check character over the first fourteen: each character''s value
-- (0-9, A-Z = 0-35) times 1 or 2 alternating, the product''s quotient and
-- remainder against 36 summed, the total''s complement mod 36 indexing the
-- alphabet. Reference arithmetic (Finance §20), the same computation
-- src/modules/finance/gstin.ts performs; held here so a door in core can
-- refuse a typo without importing the finance module.
create or replace function core.gstin_check_character(p_first14 text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  v_sum   int := 0;
  v_value int;
  v_prod  int;
  v_i     int;
begin
  if p_first14 is null or length(p_first14) <> 14 then
    return null;
  end if;
  for v_i in 1..14 loop
    v_value := position(substr(p_first14, v_i, 1) in v_alphabet) - 1;
    if v_value < 0 then
      return null;
    end if;
    v_prod := v_value * (case when v_i % 2 = 0 then 2 else 1 end);
    v_sum  := v_sum + (v_prod / 36) + (v_prod % 36);
  end loop;
  return substr(v_alphabet, ((36 - (v_sum % 36)) % 36) + 1, 1);
end;
$$;

comment on function core.gstin_check_character(text) is
  'The GSTN check character for the first fourteen characters of a GSTIN, or null when the input is not fourteen alphanumerics. Reference arithmetic, not a business rule.';

create or replace function core.update_client_account(
  p_client_account_id uuid,
  p_name              text,
  p_legal_name        text default null,
  p_gstin             text default null,
  p_pan               text default null,
  p_billing_address   text default null
)
returns table (
  -- 'updated' | 'unchanged'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'no_name' | 'bad_gstin' | 'bad_pan' | 'gstin_pan_mismatch'
  outcome text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid := (select core.current_organization_id());
  v_name    text := nullif(btrim(p_name), '');
  v_legal   text := nullif(btrim(p_legal_name), '');
  v_gstin   text := nullif(upper(btrim(p_gstin)), '');
  v_pan     text := nullif(upper(btrim(p_pan)), '');
  v_address text := nullif(btrim(p_billing_address), '');
  v_before  jsonb;
  v_after   jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.is_internal()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  if v_name is null or length(v_name) > 200 then
    return query select 'no_name'::text; return;
  end if;

  if v_gstin is not null then
    if v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'
       or not ((substr(v_gstin, 1, 2)::int between 1 and 38) or substr(v_gstin, 1, 2) in ('97', '99'))
       or core.gstin_check_character(substr(v_gstin, 1, 14)) is distinct from substr(v_gstin, 15, 1)
    then
      return query select 'bad_gstin'::text; return;
    end if;
  end if;

  if v_pan is not null and v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then
    return query select 'bad_pan'::text; return;
  end if;

  if v_gstin is not null and v_pan is not null and substr(v_gstin, 3, 10) <> v_pan then
    return query select 'gstin_pan_mismatch'::text; return;
  end if;

  select jsonb_build_object('name', c.name, 'legal_name', c.legal_name, 'gstin', c.gstin, 'pan', c.pan, 'billing_address', c.billing_address)
    into v_before
    from core.client_accounts c
   where c.id = p_client_account_id
     and c.organization_id = v_org;

  if v_before is null then
    return query select 'not_found'::text; return;
  end if;

  v_after := jsonb_build_object('name', v_name, 'legal_name', v_legal, 'gstin', v_gstin, 'pan', v_pan, 'billing_address', v_address);
  if v_after = v_before then
    return query select 'unchanged'::text; return;
  end if;

  -- security invoker: client_accounts_write (core.can_write()) decides again.
  update core.client_accounts
     set name            = v_name,
         legal_name      = v_legal,
         gstin           = v_gstin,
         pan             = v_pan,
         billing_address = v_address
   where id = p_client_account_id
     and organization_id = v_org
  returning jsonb_build_object('name', name, 'legal_name', legal_name, 'gstin', gstin, 'pan', pan, 'billing_address', billing_address)
    into v_after;

  if v_after is null then
    return query select 'not_authorized'::text; return;
  end if;

  perform core.record_audit(v_org, 'client_account.details_updated', 'client_account', p_client_account_id, v_before, v_after);

  return query select 'updated'::text;
end;
$$;

comment on function core.update_client_account(uuid, text, text, text, text, text) is
  'The one door that edits a client account''s name, legal name, GSTIN, PAN and billing address (SCR-014/015). Checks the GSTIN''s shape, state code and check character, the PAN''s shape, and that a GSTIN and PAN given together agree; security invoker, so client_accounts_write decides again. Audited as client_account.details_updated.';

revoke all on function core.update_client_account(uuid, text, text, text, text, text) from public, anon;
grant execute on function core.update_client_account(uuid, text, text, text, text, text) to authenticated;

-- ── SCR-015: the assigned team ──────────────────────────────────────────────

create table if not exists core.client_account_members (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  client_account_id uuid not null references core.client_accounts(id) on delete cascade,
  user_id           uuid not null references core.users(id) on delete cascade,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (client_account_id, user_id)
);

comment on table core.client_account_members is
  'The internal people assigned to work a client account (SCR-015), set as a whole by core.set_client_account_team. Distinct from client_accounts.owner_id, the one person who answers for the relationship.';

create index if not exists client_account_members_org_client_idx
  on core.client_account_members (organization_id, client_account_id);

drop trigger if exists set_updated_at on core.client_account_members;
create trigger set_updated_at
  before update on core.client_account_members
  for each row execute function core.set_updated_at();

drop trigger if exists org_match_client_account_members_client on core.client_account_members;
create trigger org_match_client_account_members_client
  before insert or update of client_account_id, organization_id on core.client_account_members
  for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts');

drop trigger if exists freeze_org_client_account_members on core.client_account_members;
create trigger freeze_org_client_account_members
  before update of organization_id on core.client_account_members
  for each row execute function core.freeze_organization_id();

alter table core.client_account_members enable row level security;
alter table core.client_account_members force row level security;

drop policy if exists client_account_members_select on core.client_account_members;
create policy client_account_members_select on core.client_account_members
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

-- The same roles that may write the account itself (client_accounts_write).
drop policy if exists client_account_members_write on core.client_account_members;
create policy client_account_members_write on core.client_account_members
  for all to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id())
         and (select core.can_write()));

grant select, insert, update, delete on core.client_account_members to authenticated, service_role;

create or replace function core.set_client_account_team(
  p_client_account_id uuid,
  p_user_ids          uuid[]
)
returns table (
  -- 'set'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'not_a_member'
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
  v_ids    uuid[] := (select coalesce(array_agg(distinct u), '{}'::uuid[]) from unnest(coalesce(p_user_ids, '{}'::uuid[])) as u);
  v_before jsonb;
  v_after  jsonb;
  v_bad    int;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.is_internal()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  if not exists (select 1 from core.client_accounts c where c.id = p_client_account_id and c.organization_id = v_org) then
    return query select 'not_found'::text; return;
  end if;

  -- Every person named must hold an ACTIVE membership of THIS organization:
  -- a team member who cannot open the client is a name on a list.
  select count(*) into v_bad
    from unnest(v_ids) as u(id)
   where not exists (
     select 1 from core.memberships m
      where m.organization_id = v_org and m.user_id = u.id and m.status = 'active');
  if v_bad > 0 then
    return query select 'not_a_member'::text; return;
  end if;

  select coalesce(jsonb_agg(m.user_id order by m.user_id), '[]'::jsonb) into v_before
    from core.client_account_members m
   where m.client_account_id = p_client_account_id and m.organization_id = v_org;

  -- security invoker: client_account_members_write decides again.
  delete from core.client_account_members m
   where m.client_account_id = p_client_account_id
     and m.organization_id = v_org
     and not (m.user_id = any (v_ids));

  insert into core.client_account_members (organization_id, client_account_id, user_id)
  select v_org, p_client_account_id, u.id
    from unnest(v_ids) as u(id)
  on conflict (client_account_id, user_id) do nothing;

  select coalesce(jsonb_agg(m.user_id order by m.user_id), '[]'::jsonb) into v_after
    from core.client_account_members m
   where m.client_account_id = p_client_account_id and m.organization_id = v_org;

  if v_after is distinct from v_before then
    perform core.record_audit(v_org, 'client_account.team_set', 'client_account', p_client_account_id,
                              jsonb_build_object('user_ids', v_before), jsonb_build_object('user_ids', v_after));
  end if;

  return query select 'set'::text;
end;
$$;

comment on function core.set_client_account_team(uuid, uuid[]) is
  'Replaces the set of people assigned to a client account (SCR-015). Every id must hold an active membership of the caller''s organization; security invoker, so client_account_members_write decides again. Audited as client_account.team_set when the set changes.';

revoke all on function core.set_client_account_team(uuid, uuid[]) from public, anon;
grant execute on function core.set_client_account_team(uuid, uuid[]) to authenticated;

-- ── SCR-010: a meeting may belong to a project ──────────────────────────────

alter table crm.meetings
  add column if not exists project_id uuid references projects.projects(id) on delete set null;

comment on column crm.meetings.project_id is
  'The project this meeting is about, when it is about one (SCR-010). Null for a sales meeting on a lead that has no project yet.';

create index if not exists meetings_org_project_idx
  on crm.meetings (organization_id, project_id)
  where project_id is not null;

drop trigger if exists org_match_meetings_project on crm.meetings;
create trigger org_match_meetings_project
  before insert or update of project_id, organization_id on crm.meetings
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

-- ── SCR-013: a sequence is rescheduled, completed or cancelled by a person ──

alter table crm.follow_up_sequences
  drop constraint if exists follow_up_sequences_status_check;
alter table crm.follow_up_sequences
  add constraint follow_up_sequences_status_check
  check (status in ('active', 'stopped', 'exhausted', 'escalated', 'completed', 'cancelled'));

comment on constraint follow_up_sequences_status_check on crm.follow_up_sequences is
  'active and escalated are the worker''s; exhausted is the worker''s terminal; stopped is a person''s pause (resumable); completed and cancelled are a person''s terminal decisions with a reason (SCR-013), written only by crm.decide_follow_up_sequence.';

create or replace function crm.decide_follow_up_sequence(
  p_sequence_id uuid,
  p_action      text,
  p_reason      text,
  p_next_due_at timestamptz default null
)
returns table (
  -- 'rescheduled' | 'completed' | 'cancelled'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'bad_action' | 'no_reason' | 'no_time' | 'not_open'
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
  v_reason text := nullif(btrim(p_reason), '');
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.is_internal()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  if p_action not in ('reschedule', 'complete', 'cancel') then
    return query select 'bad_action'::text; return;
  end if;

  if v_reason is null or length(v_reason) > 500 then
    return query select 'no_reason'::text; return;
  end if;

  if p_action = 'reschedule' and p_next_due_at is null then
    return query select 'no_time'::text; return;
  end if;

  select jsonb_build_object('status', s.status, 'next_due_at', s.next_due_at, 'stop_reason', s.stop_reason)
    into v_before
    from crm.follow_up_sequences s
   where s.id = p_sequence_id
     and s.organization_id = v_org;

  if v_before is null then
    return query select 'not_found'::text; return;
  end if;

  -- Only a sequence still in play is decided: active, escalated (waiting on
  -- a person — this IS that person acting) or stopped. exhausted, completed
  -- and cancelled are over.
  if (v_before ->> 'status') not in ('active', 'escalated', 'stopped') then
    return query select 'not_open'::text; return;
  end if;

  -- security invoker: follow_up_sequences' own write policy decides again.
  update crm.follow_up_sequences
     set status      = case p_action when 'reschedule' then 'active' when 'complete' then 'completed' else 'cancelled' end,
         next_due_at = case p_action when 'reschedule' then p_next_due_at else null end,
         stop_reason = 'person: ' || v_reason
   where id = p_sequence_id
     and organization_id = v_org
  returning jsonb_build_object('status', status, 'next_due_at', next_due_at, 'stop_reason', stop_reason)
    into v_after;

  if v_after is null then
    return query select 'not_authorized'::text; return;
  end if;

  perform core.record_audit(
    v_org,
    case p_action when 'reschedule' then 'follow_up.rescheduled' when 'complete' then 'follow_up.completed' else 'follow_up.cancelled' end,
    'follow_up_sequence', p_sequence_id, v_before, v_after);

  return query select (case p_action when 'reschedule' then 'rescheduled' when 'complete' then 'completed' else 'cancelled' end)::text;
end;
$$;

comment on function crm.decide_follow_up_sequence(uuid, text, text, timestamptz) is
  'A person''s decision about a follow-up sequence (SCR-013): reschedule (a new due time, back to active), complete or cancel (terminal). Every action requires a reason, recorded as the stop reason; only an active, escalated or stopped sequence is decided. Security invoker; audited as follow_up.rescheduled / completed / cancelled.';

revoke all on function crm.decide_follow_up_sequence(uuid, text, text, timestamptz) from public, anon;
grant execute on function crm.decide_follow_up_sequence(uuid, text, text, timestamptz) to authenticated;

-- ── SCR-016: a renewal or upsell is a new deal of a stated kind ─────────────

alter table sales.opportunities
  add column if not exists kind              text not null default 'new',
  add column if not exists source_project_id uuid references projects.projects(id) on delete set null;

alter table sales.opportunities drop constraint if exists opportunities_kind_check;
alter table sales.opportunities add constraint opportunities_kind_check
  check (kind in ('new', 'renewal', 'upsell'));

alter table sales.opportunities drop constraint if exists opportunities_renewal_names_its_project;
alter table sales.opportunities add constraint opportunities_renewal_names_its_project
  check (kind = 'new' or source_project_id is not null);

comment on column sales.opportunities.kind is
  'new (the default, every deal before SCR-016), renewal or upsell. A renewal or upsell is opened from a completed project by sales.open_renewal and names it in source_project_id.';
comment on column sales.opportunities.source_project_id is
  'The completed project a renewal or upsell continues from (SCR-016). Required when kind is not new.';

create index if not exists opportunities_org_source_project_idx
  on sales.opportunities (organization_id, source_project_id)
  where source_project_id is not null;

drop trigger if exists org_match_opportunities_source_project on sales.opportunities;
create trigger org_match_opportunities_source_project
  before insert or update of source_project_id, organization_id on sales.opportunities
  for each row execute function core.enforce_parent_org('source_project_id', 'projects.projects');

create or replace function sales.open_renewal(
  p_client_account_id uuid,
  p_project_id        uuid,
  p_kind              text,
  p_name              text,
  p_value_minor       bigint default 0
)
returns table (
  -- 'opened'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'bad_kind' | 'no_name' | 'not_completed' | 'lead_busy'
  outcome        text,
  opportunity_id uuid,
  lead_id        uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_org      uuid := (select core.current_organization_id());
  v_name     text := nullif(btrim(p_name), '');
  v_project  record;
  v_lead_id  uuid;
  v_currency char(3);
  v_id       uuid;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid, null::uuid; return;
  end if;

  if not coalesce((select core.is_internal()), false) then
    return query select 'not_authorized'::text, null::uuid, null::uuid; return;
  end if;

  if p_kind not in ('renewal', 'upsell') then
    return query select 'bad_kind'::text, null::uuid, null::uuid; return;
  end if;

  if v_name is null or length(v_name) > 200 then
    return query select 'no_name'::text, null::uuid, null::uuid; return;
  end if;

  select p.id, p.status, p.client_account_id, p.currency, p.opportunity_id
    into v_project
    from projects.projects p
   where p.id = p_project_id
     and p.organization_id = v_org
     and p.client_account_id = p_client_account_id
     and p.deleted_at is null;

  if v_project.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid; return;
  end if;

  if v_project.status <> 'completed' then
    return query select 'not_completed'::text, null::uuid, null::uuid; return;
  end if;

  -- The lead the original deal was won on carries the new deal too, so the
  -- pipeline shows it against the person it is with. One OPEN deal per lead
  -- (opportunities_open_lead_key): a lead already in play is refused by name
  -- rather than by a unique-index error.
  select o.lead_id into v_lead_id
    from sales.opportunities o
   where o.id = v_project.opportunity_id
     and o.organization_id = v_org;

  if v_lead_id is not null and exists (
    select 1 from sales.opportunities o
     where o.lead_id = v_lead_id and o.stage not in ('won', 'lost')
  ) then
    return query select 'lead_busy'::text, null::uuid, v_lead_id; return;
  end if;

  v_currency := coalesce(v_project.currency, 'INR');

  -- security invoker: opportunities_write decides again.
  insert into sales.opportunities (organization_id, lead_id, client_account_id, name, stage, kind, source_project_id, currency, value_minor, owner_id)
  values (v_org, v_lead_id, p_client_account_id, v_name, 'discovery', p_kind, v_project.id, v_currency, greatest(coalesce(p_value_minor, 0), 0), v_actor)
  returning id into v_id;

  perform core.record_audit(v_org, 'opportunity.renewal_opened', 'opportunity', v_id, null,
    jsonb_build_object('kind', p_kind, 'client_account_id', p_client_account_id, 'source_project_id', v_project.id, 'lead_id', v_lead_id, 'name', v_name, 'value_minor', greatest(coalesce(p_value_minor, 0), 0)));

  return query select 'opened'::text, v_id, v_lead_id;
end;
$$;

comment on function sales.open_renewal(uuid, uuid, text, text, bigint) is
  'Opens a renewal or upsell opportunity from a COMPLETED project of the client (SCR-016): discovery stage, the project''s currency, the original deal''s lead, the caller as owner. Refuses a project that is not completed and a lead that already has an open deal. Security invoker; audited as opportunity.renewal_opened.';

revoke all on function sales.open_renewal(uuid, uuid, text, text, bigint) from public, anon;
grant execute on function sales.open_renewal(uuid, uuid, text, text, bigint) to authenticated;

notify pgrst, 'reload schema';
