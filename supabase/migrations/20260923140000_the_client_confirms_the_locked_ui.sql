-- ═══════════════════════════════════════════════════════════════════════════
-- The client confirms, and only then is it locked.
--
-- Impl §7.2; Master's locked objective: "PM SHARE → CLIENT REQUESTS REVISION
-- OR CLIENT APPROVES → LOCK EXACT UI VERSION → PROTOTYPE SOURCE."
-- docs/phase-4-implementation-traceability.md P4-UID-CLIENT-REVIEW.
--
-- ── why this is a bespoke log, not the generic approvals engine ──────────
--
-- `docs/phase-4-implementation-traceability.md`'s own research found no
-- single reusable client-decision primitive: the generic `approvals`
-- engine's `audience='client'` column exists and is never once exercised by
-- a real caller anywhere in this codebase, while `projects.
-- client_design_decisions` (20260919140000) is a real, PROVEN, per-domain
-- decision log already carrying exactly this shape for Phase 3's own client
-- review. Being the first real caller of an untested code path, for the one
-- gate the master flow names as the hardest to fake ("DO NOT FAKE... client
-- ... success"), is the wrong place to learn whether that path actually
-- works. This table is `client_design_decisions`'s shape, carried one phase
-- forward, minus the theme/colour-selection columns that decision never had
-- a UI version to have — because a UI version review has nothing to select
-- between, only to confirm or send back.
--
-- ── two decisions, not Phase 3's six ──────────────────────────────────────
--
-- PM §12 gave Phase 3 six because a client choosing between themes can be
-- clarifying, referencing, or flagging scope — six real shapes an answer to
-- "which one" can take. Master's Client UI Review names exactly two actions
-- for THIS gate: request a revision, or approve. Building the other four here
-- would be modelling shapes no caller in this flow produces.
--
-- ── PM shares, the client answers, and only THEN is it locked ────────────
--
-- Three separate acts, three separate doors, because Master's own numbered
-- flow keeps them separate (steps 13, 20, 21): sharing is not a decision, and
-- an approval is not yet a lock. `share_ui_version_with_client` records WHEN
-- and how the version was shown (the same "what they saw" discipline
-- `client_design_decisions.share_id` already keeps for Phase 3); the decision
-- log records WHAT the client said and where to verify it; `lock_ui_version`
-- freezes it, the same `freeze_*` doctrine `design_token_sets` and
-- `phase_three_handoffs` both already carry — a locked version that could
-- still change would make Prototype's own "exact locked UI version" a
-- promise rather than a record.
--
-- ── the revision loop is not built here ───────────────────────────────────
--
-- A `change_requested` decision moves the version to `client_change` and
-- stops. Looping it back through Designer → QA → Admin → PM → Client again
-- means teaching `record_ui_version_draft` to accept a SECOND version for a
-- workspace that already has one — genuinely new work this migration does
-- not do, named rather than silently left half-built. `phase_four`'s own
-- `ui_revision_count`/`ui_revision_limit` columns exist for exactly this and
-- remain unread until that unit is built.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.ui_version_client_decisions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  ui_version_id    uuid not null references projects.ui_versions(id) on delete cascade,

  -- Master's Client UI Review names exactly two actions — see header.
  decision         text not null check (decision in ('change_requested', 'final_confirmed')),

  -- The original message, always — the same rule client_design_decisions
  -- keeps and for the same reason: an interpretation this system cannot show
  -- the source of is its own opinion about a client.
  client_words     text not null check (length(btrim(client_words)) between 1 and 4000),

  evidence_ref     text,
  conversation_id  uuid references crm.conversations(id) on delete set null,

  recorded_by      uuid not null references core.users(id) on delete restrict,
  created_at       timestamptz not null default now()
);

comment on table projects.ui_version_client_decisions is
  'Impl section 7.2. An append-only log of what a client said about one UI version review round - client_design_decisions'' shape, carried one phase forward. Multiple rows per ui_version_id are the ordinary case: each client_change round adds one. Never updated or deleted, the same append-only discipline the Phase 3 table keeps.';

create index if not exists ui_version_client_decisions_version_idx
  on projects.ui_version_client_decisions (ui_version_id, created_at desc);

create trigger ui_version_client_decisions_parent_org_project
  before insert or update of project_id on projects.ui_version_client_decisions
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

create trigger ui_version_client_decisions_parent_org_version
  before insert or update of ui_version_id on projects.ui_version_client_decisions
  for each row execute function core.enforce_parent_org('ui_version_id', 'projects.ui_versions');

create trigger freeze_org_ui_version_client_decisions
  before update of organization_id on projects.ui_version_client_decisions
  for each row execute function core.freeze_organization_id();

-- Append-only: no UPDATE, no DELETE, for anybody. A decision is a fact about
-- a moment; correcting a mis-recorded one is a NEW row with the true words,
-- not an edit that makes the log stop matching what was actually said.
create or replace function projects.refuse_ui_version_client_decision_edit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'a client decision is a record of what was said, never edited or removed';
end;
$$;

create trigger refuse_ui_version_client_decision_edit
  before update or delete on projects.ui_version_client_decisions
  for each row execute function projects.refuse_ui_version_client_decision_edit();

alter table projects.ui_version_client_decisions enable row level security;
alter table projects.ui_version_client_decisions force row level security;

drop policy if exists ui_version_client_decisions_select on projects.ui_version_client_decisions;
create policy ui_version_client_decisions_select on projects.ui_version_client_decisions
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on projects.ui_version_client_decisions to authenticated, service_role;

-- ── the state machine gains a freeze ──────────────────────────────────────
--
-- `ui_versions.status` has named 'locked' since 20260923110000 with no door
-- ever reaching it and no trigger refusing a change once there. Both arrive
-- together: a lock with nothing enforcing it is a label, not a lock.
create or replace function projects.freeze_locked_ui_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'locked' then
    raise exception 'a locked UI version is what Prototype builds from; a later change is a new version, not an edit';
  end if;
  return new;
end;
$$;

create trigger freeze_locked_ui_version
  before update on projects.ui_versions
  for each row execute function projects.freeze_locked_ui_version();

insert into core.event_types (type, description, canonical) values
  ('project.ui_version_shared_to_client',
   'Impl section 7.2, Master step 13/19. A UI version was shown to the client, with evidence of how.',
   true),
  ('project.ui_version_client_decided',
   'Impl section 7.2, Master step 14/20. The client requested a revision or gave final confirmation on a shared UI version.',
   true),
  ('project.ui_version_locked',
   'Impl section 7.2, Master step 21. A client-confirmed UI version is frozen and becomes the Prototype Agent''s exact source.',
   true)
on conflict (type) do nothing;

-- ── the doors ───────────────────────────────────────────────────────────

create or replace function projects.share_ui_version_with_client(
  p_ui_version_id uuid,
  p_evidence_ref  text
)
returns table (
  -- 'shared' | 'wrong_state' | 'unknown_version' | 'no_actor' | 'forbidden'
  outcome       text,
  ui_version_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_version projects.ui_versions;
begin
  -- A person shares — this is PM §5's own client-facing act, never a job.
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  select v.* into v_version
    from projects.ui_versions v
   where v.id = p_ui_version_id
   for update;

  if v_version.id is null then
    return query select 'unknown_version'::text, null::uuid; return;
  end if;

  if v_version.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_version.status <> 'admin_approved' then
    return query select 'wrong_state'::text, null::uuid; return;
  end if;

  update projects.ui_versions set status = 'client_review' where id = v_version.id;

  perform core.record_audit(
    v_version.organization_id, 'project.ui_version_shared_to_client', 'ui_version', v_version.id, null,
    jsonb_build_object('projectId', v_version.project_id, 'evidenceRef', p_evidence_ref)
  );

  perform core.emit_event(
    v_version.organization_id, 'project.ui_version_shared_to_client',
    'ui_version', v_version.id,
    jsonb_build_object('projectId', v_version.project_id, 'phaseFourId', v_version.phase_four_id)
  );

  return query select 'shared'::text, v_version.id;
end;
$$;

comment on function projects.share_ui_version_with_client(uuid, text) is
  'Master steps 13/19. Moves an admin_approved UI version to client_review. Takes no argument about WHICH version to lock later - the version id IS the record of what was shown, the same discipline client_design_shares keeps for Phase 3.';

revoke all on function projects.share_ui_version_with_client(uuid, text) from public, anon;
grant execute on function projects.share_ui_version_with_client(uuid, text) to authenticated;

create or replace function projects.record_ui_version_client_decision(
  p_ui_version_id uuid,
  p_decision      text,
  p_client_words  text,
  p_evidence_ref  text default null,
  p_conversation_id uuid default null
)
returns table (
  -- 'recorded' | 'wrong_state' | 'bad_decision' | 'unknown_version'
  -- | 'no_actor' | 'forbidden'
  outcome        text,
  ui_version_id  uuid,
  decision_id    uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_version projects.ui_versions;
  v_status  text;
  v_new     uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, null::uuid; return;
  end if;

  if p_decision not in ('change_requested', 'final_confirmed') then
    return query select 'bad_decision'::text, null::uuid, null::uuid; return;
  end if;

  select v.* into v_version
    from projects.ui_versions v
   where v.id = p_ui_version_id
   for update;

  if v_version.id is null then
    return query select 'unknown_version'::text, null::uuid, null::uuid; return;
  end if;

  if v_version.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid, null::uuid; return;
  end if;

  -- A decision may be recorded while the client is being asked (client_review)
  -- or after a prior round already sent it back (client_change) — a second
  -- round is the ordinary path, not an error.
  if v_version.status not in ('client_review', 'client_change') then
    return query select 'wrong_state'::text, null::uuid, null::uuid; return;
  end if;

  insert into projects.ui_version_client_decisions (
    organization_id, project_id, ui_version_id, decision, client_words,
    evidence_ref, conversation_id, recorded_by
  ) values (
    v_version.organization_id, v_version.project_id, v_version.id, p_decision, p_client_words,
    p_evidence_ref, p_conversation_id, v_actor
  )
  returning id into v_new;

  v_status := case p_decision
    when 'final_confirmed'   then 'client_approved'
    when 'change_requested'  then 'client_change'
  end;

  update projects.ui_versions set status = v_status where id = v_version.id;

  perform core.record_audit(
    v_version.organization_id, 'project.ui_version_client_decided', 'ui_version', v_version.id, null,
    jsonb_build_object('projectId', v_version.project_id, 'decision', p_decision)
  );

  perform core.emit_event(
    v_version.organization_id, 'project.ui_version_client_decided',
    'ui_version', v_version.id,
    jsonb_build_object('projectId', v_version.project_id, 'phaseFourId', v_version.phase_four_id, 'decision', p_decision)
  );

  return query select 'recorded'::text, v_version.id, v_new;
end;
$$;

comment on function projects.record_ui_version_client_decision(uuid, text, text, text, uuid) is
  'Master steps 14/20. Records the client''s verbatim words (PM section 4.5, Master section 8) as an append-only log row, and moves the version to client_approved or client_change. The revision loop back through Designer/QA/Admin for client_change is NOT built here - see the migration header.';

revoke all on function projects.record_ui_version_client_decision(uuid, text, text, text, uuid) from public, anon;
grant execute on function projects.record_ui_version_client_decision(uuid, text, text, text, uuid) to authenticated;

create or replace function projects.lock_ui_version(
  p_ui_version_id uuid
)
returns table (
  -- 'locked' | 'already_locked' | 'wrong_state' | 'unknown_version'
  -- | 'no_actor' | 'forbidden'
  outcome       text,
  ui_version_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_version projects.ui_versions;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  select v.* into v_version
    from projects.ui_versions v
   where v.id = p_ui_version_id
   for update;

  if v_version.id is null then
    return query select 'unknown_version'::text, null::uuid; return;
  end if;

  if v_version.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_version.status = 'locked' then
    -- Master section 22's idempotent-replay shape: a repeated lock attempt
    -- answers with the fact that is already true.
    return query select 'already_locked'::text, v_version.id; return;
  end if;

  if v_version.status <> 'client_approved' then
    return query select 'wrong_state'::text, null::uuid; return;
  end if;

  update projects.ui_versions set status = 'locked' where id = v_version.id;

  perform core.record_audit(
    v_version.organization_id, 'project.ui_version_locked', 'ui_version', v_version.id, null,
    jsonb_build_object('projectId', v_version.project_id)
  );

  perform core.emit_event(
    v_version.organization_id, 'project.ui_version_locked',
    'ui_version', v_version.id,
    jsonb_build_object('projectId', v_version.project_id, 'phaseFourId', v_version.phase_four_id)
  );

  return query select 'locked'::text, v_version.id;
end;
$$;

comment on function projects.lock_ui_version(uuid) is
  'Master step 21. Freezes a client_approved UI version so the Prototype Agent inherits a record rather than a promise (Designer section 19''s argument, one stage later). freeze_locked_ui_version enforces it structurally: the row cannot change again once this succeeds.';

revoke all on function projects.lock_ui_version(uuid) from public, anon;
grant execute on function projects.lock_ui_version(uuid) to authenticated;

notify pgrst, 'reload schema';
