-- ═══════════════════════════════════════════════════════════════════════════
-- The group is a manual action.
--
-- Master §5.5, §6, §9, §14; PM §4.4, PM-04, §8.
--
-- ── the constraint this is built on, which is not a design choice ─────────
--
-- Meta answered it directly, on this deployment's own WABA: error **#131215,
-- "This phone number is not eligible to access Groups APIs"**, established by
-- the Admin running the Graph calls themselves. A Cloud API number cannot join
-- a group created in the ordinary app either. **ADM-95** recorded it.
--
-- So the Phase 2 specification's line — *"Do not claim official automatic
-- group creation unless a future supported provider capability actually
-- exists"* — is not a caution here. It is the only truthful implementation:
-- a person opens WhatsApp, makes the group, adds the members, and tells
-- AgencyOS what they did. Everything below exists to make that person's job
-- one click of preparation and one click of confirmation, and to make the
-- record of it honest.
--
-- **Nothing in this migration calls a provider.** If Meta ever grants Groups
-- eligibility, the same four states and the same snapshot survive; only who
-- performs the middle step changes. That is §6's "future-proofing" paragraph,
-- and it needs no interface today — an interface with one implementation and
-- no second candidate is a guess about a capability that does not exist.
--
-- ── what already existed, and is therefore not rebuilt ────────────────────
--
--   * `crm.project_group_title(project_id)` composes §5.5's exact name —
--     PROJECT NAME // FINAL QUOTATION PRICE // PROJECT START DATE // CLIENT
--     NAME // identifier — and NAMES the facts that are missing rather than
--     assembling a title around a guess (G-188).
--   * `crm.conversations` with `kind = 'project_group'` is a real group, with
--     one live group per project enforced by a partial index (G-015) and the
--     WhatsApp group id unique deployment-wide.
--   * `organization.settings.project_group_identifier` is the one segment of
--     the name that is the owner's to choose.
--
-- This adds the three things that did not exist: the Admin's task, the roster
-- it is prepared from, and the four states Master §9 names.
--
-- ── one snapshot, doing two jobs ──────────────────────────────────────────
--
-- §6 wants "project overrides — add/remove members for this project" and
-- "audit — member/config snapshot", and PM §8 adds that changing the global
-- defaults later must not rewrite history. Those are one column, not two
-- tables: the member list is COPIED out of the defaults when the task is
-- raised, is the Admin's to edit while the task is still pending, and freezes
-- the moment they confirm the group was created. A later change to the roster
-- cannot reach backwards into a group that already exists, because the row
-- holding what was actually done is not a view over the roster.
--
-- This is the one place in this repository where copying is right rather than
-- wrong. Everywhere else a reference is preferred because the row is the fact.
-- Here the SNAPSHOT is the fact: what matters is who was in the group on the
-- day it was made, and the roster's job is only to propose it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the two events Master §9 names ────────────────────────────────────────

insert into core.event_types (type, description, canonical) values
  ('project.group_setup_required',
   'Master section 9 WhatsAppGroupSetupRequired - the PM has raised the Admin manual-action task for a project WhatsApp group. Nothing automatic follows it: a person creates the group.',
   true),
  ('project.group_mapped',
   'Master section 9 WhatsAppGroupMapped - an Admin has confirmed the group exists and mapped it to a conversation in AgencyOS. Communication for this project is ready.',
   true)
on conflict (type) do nothing;

-- ── the roster the task is prepared from ──────────────────────────────────
--
-- §5.5: "Default internal team numbers are globally configurable and
-- project-overridable." Configurable means a table, not a constant: these are
-- the agency's own people, they change, and a deploy is not how a team member
-- joins a project.
--
-- Not `core.users`: staff carry an email and no phone, because AgencyOS has
-- never needed to message its own people on WhatsApp before. Inventing a phone
-- column on the identity table for this would put a messaging fact in the
-- authentication model.

create table if not exists projects.group_team_defaults (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  display_name     text not null check (length(btrim(display_name)) between 1 and 120),

  -- Digits, optionally with a leading +. The same shape
  -- `whatsapp_test_recipient` is validated with, and for the same reason: a
  -- number a person will paste into WhatsApp is worth refusing early.
  phone            text not null check (phone ~ '^\+?[0-9]{6,20}$'),

  -- What they do on a project, for the Admin's card. Free text and not a
  -- check: the agency's roles are its own business and a closed list here
  -- would be this migration deciding them.
  role             text,

  -- Preselected on the card (§6, "Default team members ... preselected").
  -- Inactive keeps a person on the roster without putting them in the next
  -- group, which is what happens when somebody leaves a project rather than
  -- the company.
  active           boolean not null default true,
  position         int not null default 0,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- One row per number. Two entries for the same phone is two names for one
  -- person in a group of eight.
  unique (organization_id, phone)
);

comment on table projects.group_team_defaults is
  'Master section 5.5 default internal team WhatsApp numbers - globally configurable, preselected onto every group setup card, and copied rather than referenced when a card is raised so that changing this roster cannot rewrite a group that already exists.';

-- ── the Admin's task, and the four states ─────────────────────────────────

create table if not exists projects.group_setups (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- One task per project. A second card for the same project is two people
  -- making two groups, which is the failure this whole flow exists to avoid.
  project_id       uuid not null unique references projects.projects(id) on delete cascade,

  -- Master §9's ladder, exactly: PENDING → CREATED → MAPPED → VERIFIED.
  -- `pending` is PENDING_MANUAL_ACTION; the shorter name is used because the
  -- table is called group_setups and the manual part is the whole table.
  state            text not null default 'pending' check (state in
                     ('pending', 'created', 'mapped', 'verified')),

  -- §6: "Suggested group name — config-driven; editable before confirmation."
  -- Composed by crm.project_group_title when the card is raised and then the
  -- Admin's to change, because they are the one typing it into WhatsApp.
  -- Nullable: a project missing the facts the name is built from gets a card
  -- with no name rather than a name built around a guess, and
  -- `suggested_name_missing` says which facts.
  suggested_name   text,
  suggested_name_missing text[] not null default '{}',

  -- The snapshot. `[{name, phone, role, kind}]` where kind is 'internal' or
  -- 'client'. Editable while pending, frozen at confirmation by the trigger
  -- below.
  members          jsonb not null default '[]'::jsonb,

  -- The group, once a person has made it and said which one it is. Null until
  -- `mapped`, and enforced so by the shape constraint.
  conversation_id  uuid references crm.conversations(id) on delete set null,

  requested_at     timestamptz not null default now(),
  created_at_whatsapp timestamptz,
  mapped_at        timestamptz,
  verified_at      timestamptz,

  -- Master §6: "Audit — who confirmed, when". The person, not the agent.
  confirmed_by     uuid references core.users(id) on delete set null,
  mapped_by        uuid references core.users(id) on delete set null,
  verified_by      uuid references core.users(id) on delete set null,

  note             text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- A state and its moment travel together, the same shape
  -- `onboarding_items_completion_shape` and the approval decision shape use.
  -- Half a state change is worse than none: a card reading `mapped` with no
  -- `mapped_at` is a group nobody can say when they got.
  constraint group_setups_created_shape check (
    (state in ('created', 'mapped', 'verified')) = (created_at_whatsapp is not null)
  ),
  constraint group_setups_mapped_shape check (
    (state in ('mapped', 'verified')) = (mapped_at is not null)
  ),
  constraint group_setups_mapped_needs_group check (
    state not in ('mapped', 'verified') or conversation_id is not null
  ),
  constraint group_setups_verified_shape check (
    (state = 'verified') = (verified_at is not null)
  ),

  -- A card cannot be raised with nobody on it. §5.5's card shows client
  -- numbers AND internal numbers; an empty list is a card that tells the
  -- Admin nothing they did not already know.
  constraint group_setups_members_is_array check (jsonb_typeof(members) = 'array')
);

create index if not exists group_setups_state_idx
  on projects.group_setups (organization_id, state, requested_at);

comment on table projects.group_setups is
  'Master section 5.5 and section 9 - the Admin manual-action task for a project WhatsApp group, and its four states PENDING, CREATED, MAPPED, VERIFIED. Meta refused this WABA the Groups API (ADM-95, error 131215), so a person creates the group and this row is the preparation, the record and the audit of that. Nothing here calls a provider.';

comment on column projects.group_setups.members is
  'The member snapshot, taken when the card is raised and frozen when the Admin confirms the group was created. Copied rather than referenced on purpose: what matters afterwards is who was in the group on the day it was made, and a later change to the team roster must not rewrite it (PM section 8).';

comment on column projects.group_setups.suggested_name_missing is
  'The facts crm.project_group_title could not find. A name is offered only when it is whole - a title carrying an invented price would be read by a client as the price they agreed.';

-- ── the snapshot freezes when the group exists ────────────────────────────
--
-- Before that it is a proposal and the Admin may edit it; after it, it is a
-- record of something that happened in an app this system cannot see.

create or replace function projects.freeze_group_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.state <> 'pending' and new.members is distinct from old.members then
    raise exception
      'the member list is a record of who was added to a group that already exists, not a plan'
      using errcode = 'check_violation';
  end if;
  if old.state <> 'pending' and new.suggested_name is distinct from old.suggested_name then
    raise exception
      'the group name is editable before it is created, not after'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists freeze_group_snapshot on projects.group_setups;
create trigger freeze_group_snapshot
  before update on projects.group_setups
  for each row execute function projects.freeze_group_snapshot();

-- ── tenancy, exactly as every org-scoped table here carries it ────────────

alter table projects.group_team_defaults enable row level security;
alter table projects.group_team_defaults force row level security;
alter table projects.group_setups enable row level security;
alter table projects.group_setups force row level security;

drop policy if exists group_team_defaults_select on projects.group_team_defaults;
create policy group_team_defaults_select on projects.group_team_defaults
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

-- A client never reads the agency's own operational task, nor the numbers of
-- the agency's staff.
drop policy if exists group_setups_select on projects.group_setups;
create policy group_setups_select on projects.group_setups
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop trigger if exists org_match_group_setups_project on projects.group_setups;
create trigger org_match_group_setups_project
  before insert or update of project_id, organization_id on projects.group_setups
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_group_setups_conversation on projects.group_setups;
create trigger org_match_group_setups_conversation
  before insert or update of conversation_id, organization_id on projects.group_setups
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');

drop trigger if exists freeze_org_group_setups on projects.group_setups;
create trigger freeze_org_group_setups
  before update of organization_id on projects.group_setups
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_group_team_defaults on projects.group_team_defaults;
create trigger freeze_org_group_team_defaults
  before update of organization_id on projects.group_team_defaults
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at_group_setups on projects.group_setups;
create trigger set_updated_at_group_setups
  before update on projects.group_setups
  for each row execute function core.set_updated_at();

drop trigger if exists set_updated_at_group_team_defaults on projects.group_team_defaults;
create trigger set_updated_at_group_team_defaults
  before update on projects.group_team_defaults
  for each row execute function core.set_updated_at();

grant select on projects.group_setups, projects.group_team_defaults to authenticated;
grant select, insert, update on projects.group_setups, projects.group_team_defaults to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- The doors
-- ═══════════════════════════════════════════════════════════════════════════

-- ── raise the task ───────────────────────────────────────────────────────
--
-- PM-04. Called by the PM once Phase 2 has started; also callable by a person
-- repairing a lost card. Idempotent by the unique constraint AND by the lock,
-- so a replayed event and a click cannot both insert.

create or replace function projects.request_group_setup(p_project_id uuid)
returns table (
  -- 'requested' | 'already_requested' | 'unknown_project' | 'no_actor' | 'forbidden'
  outcome  text,
  setup_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_project  projects.projects;
  v_existing projects.group_setups;
  v_title    record;
  v_members  jsonb;
  v_new      uuid;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  select p.* into v_project from projects.projects p where p.id = p_project_id for update;
  if v_project.id is null or v_project.deleted_at is not null then
    return query select 'unknown_project'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_project.organization_id is distinct from (select core.current_organization_id())
          or not (select core.can_write())) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  select gs.* into v_existing from projects.group_setups gs where gs.project_id = v_project.id;
  if v_existing.id is not null then
    return query select 'already_requested'::text, v_existing.id; return;
  end if;

  -- §5.5's exact name, or nothing and the reasons. G-188 composed it; this
  -- reads it rather than assembling a second one.
  select t.title, t.missing into v_title
    from crm.project_group_title(v_project.id) t;

  -- The card's member list: the agency's preselected roster, then the
  -- client's reachable contacts. Copied, for the reason the table comment
  -- gives.
  select coalesce(jsonb_agg(m order by m->>'kind' desc, m->>'name'), '[]'::jsonb) into v_members
    from (
      select jsonb_build_object(
               'name', d.display_name, 'phone', d.phone,
               'role', d.role, 'kind', 'internal'
             ) as m
        from projects.group_team_defaults d
       where d.organization_id = v_project.organization_id
         and d.active
      union all
      select jsonb_build_object(
               'name', c.full_name, 'phone', c.phone,
               'role', c.job_title, 'kind', 'client'
             )
        from crm.contacts c
       where c.organization_id = v_project.organization_id
         and c.client_account_id = v_project.client_account_id
         and c.phone is not null
    ) rows;

  insert into projects.group_setups (
    organization_id, project_id, state, suggested_name, suggested_name_missing, members
  ) values (
    v_project.organization_id, v_project.id, 'pending',
    v_title.title, coalesce(v_title.missing, '{}'), v_members
  )
  returning id into v_new;

  perform core.emit_event(
    v_project.organization_id, 'project.group_setup_required', 'project', v_project.id,
    jsonb_build_object('setup_id', v_new, 'member_count', jsonb_array_length(v_members)),
    null
  );

  perform core.record_audit(
    v_project.organization_id, 'project.group_setup_required', 'project', v_project.id,
    null,
    jsonb_build_object('setup_id', v_new, 'member_count', jsonb_array_length(v_members)),
    null
  );

  return query select 'requested'::text, v_new;
end;
$$;

comment on function projects.request_group_setup(uuid) is
  'PM-04 - raise the Admin manual-action card for a project WhatsApp group. Snapshots the suggested name and the member list. Creates no group: Meta refused this WABA the Groups API (ADM-95), and a person does the middle step.';

-- ── edit it, while it is still only a proposal ───────────────────────────

create or replace function projects.revise_group_setup(
  p_setup_id uuid,
  p_suggested_name text default null,
  p_members jsonb default null
)
returns table (
  -- 'revised' | 'not_pending' | 'unknown_setup' | 'no_actor' | 'forbidden' | 'invalid_members'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.group_setups;
begin
  -- An argument this function cannot act on is refused BEFORE the row is
  -- locked: a caller who passed an object where a list belongs learns that
  -- without holding a lock on somebody else's card.
  if p_members is not null and jsonb_typeof(p_members) is distinct from 'array' then
    return query select 'invalid_members'::text; return;
  end if;

  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text; return;
  end if;

  select gs.* into v_row from projects.group_setups gs where gs.id = p_setup_id for update;
  if v_row.id is null then
    return query select 'unknown_setup'::text; return;
  end if;

  if v_actor is not null
     and (v_row.organization_id is distinct from (select core.current_organization_id())
          or not (select core.can_write())) then
    return query select 'forbidden'::text; return;
  end if;

  if v_row.state <> 'pending' then
    return query select 'not_pending'::text; return;
  end if;

  update projects.group_setups
     set suggested_name = coalesce(p_suggested_name, suggested_name),
         members        = coalesce(p_members, members)
   where id = v_row.id;

  return query select 'revised'::text;
end;
$$;

comment on function projects.revise_group_setup(uuid, text, jsonb) is
  'Master section 6 - the suggested name is editable before confirmation and the member list is project-overridable. Both refuse once the group exists, because after that they are a record rather than a plan.';

-- ── the person says they made it ─────────────────────────────────────────

create or replace function projects.confirm_group_created(
  p_setup_id uuid,
  p_note text default null
)
returns table (
  -- 'confirmed' | 'already_confirmed' | 'unknown_setup' | 'no_actor' | 'forbidden' | 'needs_person'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.group_setups;
begin
  -- A PERSON confirms this one. The service role may raise the card and may
  -- read it, but "I made the group" is a claim about something that happened
  -- outside this system, and an unattended process cannot witness it —
  -- §6's audit line is "who confirmed", and `nobody` is not an answer.
  if v_actor is null then
    return query select 'needs_person'::text; return;
  end if;

  select gs.* into v_row from projects.group_setups gs where gs.id = p_setup_id for update;
  if v_row.id is null then
    return query select 'unknown_setup'::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text; return;
  end if;

  if v_row.state <> 'pending' then
    return query select 'already_confirmed'::text; return;
  end if;

  update projects.group_setups
     set state = 'created',
         created_at_whatsapp = now(),
         confirmed_by = v_actor,
         note = coalesce(p_note, note)
   where id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'project.group_created', 'project', v_row.project_id,
    jsonb_build_object('state', v_row.state),
    jsonb_build_object('state', 'created', 'setup_id', v_row.id, 'confirmed_by', v_actor),
    null
  );

  return query select 'confirmed'::text;
end;
$$;

comment on function projects.confirm_group_created(uuid, text) is
  'Master section 6 "Confirm created". Refuses the service role: this is a claim about something a person did in another app, and section 6 asks who confirmed it.';

-- ── and says which group it is ───────────────────────────────────────────

create or replace function projects.map_group(
  p_setup_id uuid,
  p_conversation_id uuid
)
returns table (
  -- 'mapped' | 'not_created' | 'already_mapped' | 'unknown_setup'
  -- | 'unknown_conversation' | 'wrong_project' | 'no_actor' | 'forbidden'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.group_setups;
  v_conv  crm.conversations;
begin
  if v_actor is null then
    return query select 'needs_person'::text; return;
  end if;

  select gs.* into v_row from projects.group_setups gs where gs.id = p_setup_id for update;
  if v_row.id is null then
    return query select 'unknown_setup'::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text; return;
  end if;

  if v_row.state = 'pending' then
    return query select 'not_created'::text; return;
  end if;
  if v_row.state in ('mapped', 'verified') then
    return query select 'already_mapped'::text; return;
  end if;

  select c.* into v_conv from crm.conversations c where c.id = p_conversation_id;
  if v_conv.id is null or v_conv.organization_id is distinct from v_row.organization_id then
    return query select 'unknown_conversation'::text; return;
  end if;

  -- The group must be THIS project's group. A card mapped to another
  -- project's conversation would send this client's invoices to that client.
  if v_conv.project_id is distinct from v_row.project_id or v_conv.kind is distinct from 'project_group' then
    return query select 'wrong_project'::text; return;
  end if;

  update projects.group_setups
     set state = 'mapped', mapped_at = now(), mapped_by = v_actor, conversation_id = v_conv.id
   where id = v_row.id;

  perform core.emit_event(
    v_row.organization_id, 'project.group_mapped', 'project', v_row.project_id,
    jsonb_build_object('setup_id', v_row.id, 'conversation_id', v_conv.id),
    null
  );

  perform core.record_audit(
    v_row.organization_id, 'project.group_mapped', 'project', v_row.project_id,
    jsonb_build_object('state', v_row.state),
    jsonb_build_object('state', 'mapped', 'setup_id', v_row.id, 'conversation_id', v_conv.id, 'mapped_by', v_actor),
    null
  );

  return query select 'mapped'::text;
end;
$$;

comment on function projects.map_group(uuid, uuid) is
  'Master section 6 "Map/reference" and section 9 WhatsAppGroupMapped. Refuses a conversation belonging to another project - a card mapped to the wrong group sends one client the other client''s invoices.';

-- ── and somebody checks ──────────────────────────────────────────────────

create or replace function projects.verify_group(p_setup_id uuid)
returns table (
  -- 'verified' | 'not_mapped' | 'already_verified' | 'unknown_setup' | 'needs_person' | 'forbidden'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.group_setups;
begin
  if v_actor is null then
    return query select 'needs_person'::text; return;
  end if;

  select gs.* into v_row from projects.group_setups gs where gs.id = p_setup_id for update;
  if v_row.id is null then
    return query select 'unknown_setup'::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text; return;
  end if;

  if v_row.state = 'verified' then
    return query select 'already_verified'::text; return;
  end if;
  if v_row.state <> 'mapped' then
    return query select 'not_mapped'::text; return;
  end if;

  update projects.group_setups
     set state = 'verified', verified_at = now(), verified_by = v_actor
   where id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'project.group_verified', 'project', v_row.project_id,
    jsonb_build_object('state', v_row.state),
    jsonb_build_object('state', 'verified', 'setup_id', v_row.id, 'verified_by', v_actor),
    null
  );

  return query select 'verified'::text;
end;
$$;

comment on function projects.verify_group(uuid) is
  'Master section 9''s fourth state. Separate from mapping because mapping is "this is the group" and verifying is "I have looked at it and the right people are in it" - and the second is the one the kickoff gate should trust.';

revoke all on function projects.request_group_setup(uuid) from public;
revoke all on function projects.revise_group_setup(uuid, text, jsonb) from public;
revoke all on function projects.confirm_group_created(uuid, text) from public;
revoke all on function projects.map_group(uuid, uuid) from public;
revoke all on function projects.verify_group(uuid) from public;

grant execute on function projects.request_group_setup(uuid) to authenticated, service_role;
grant execute on function projects.revise_group_setup(uuid, text, jsonb) to authenticated, service_role;
grant execute on function projects.confirm_group_created(uuid, text) to authenticated;
grant execute on function projects.map_group(uuid, uuid) to authenticated;
grant execute on function projects.verify_group(uuid) to authenticated;

notify pgrst, 'reload schema';
