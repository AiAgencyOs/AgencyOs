-- ═══════════════════════════════════════════════════════════════════════════
-- A package that says what it must contain.
--
-- Document 17 §9 lists fifteen things a handover package holds — the approved
-- scope, the UI baseline, the production URL, the release identifier, the
-- repository, the deployment and schema and API documentation, the admin
-- guide. §3 makes *"Handover package is complete"* a completion precondition,
-- and §1 says it plainly: *"No agent can declare the project completed while
-- mandatory deliverables, payment, QA, deployment or handover evidence is
-- missing."*
--
-- `projects.handover_items` has held the package since the third day of this
-- repository, and `deliver_handover` refuses an empty one. **Empty is the only
-- thing it could refuse.** One item satisfies it as completely as fifteen, so
-- a package missing its repository, its documentation and its admin guide
-- delivers exactly like a complete one — and nobody finds out until the
-- client asks for the thing that is not there.
--
-- ── the checklist is not the package ─────────────────────────────────────
--
-- Two tables rather than a flag, and the difference matters. A requirement is
-- *what this project owes*; an item is *what was actually handed over*. If the
-- agent wrote empty items instead, the empty-package refusal would start
-- passing on placeholders — a control weakened by the change that was supposed
-- to strengthen it.
--
-- ── what the agent may say, and what it may never say ────────────────────
--
-- It reads what the project included and says which of §9's kinds this package
-- owes. It cannot say *here it is*: a requirement has no reference and no
-- transfer method, because those are the artifact, and the artifact is a
-- person's. §9's *"Repository/access transfer through secure mechanisms"* is
-- the sharpest case — `handover_items` already refuses a `credential` that
-- carries a reference, and ADM-61 §5 makes writing a client credential one of
-- the five things no agent may do at any level. An agent that can only ever
-- say *this package owes a credential* cannot come close to that line.
--
-- ── the gate matches by KIND, deliberately ───────────────────────────────
--
-- A requirement is met when the package holds an item of the same kind. Not
-- by label — matching on the agent's wording would make a delivery gate
-- depend on the thing least worth trusting, and a package would fail because
-- somebody wrote "Repo" where the agent wrote "Repository". Coarse and
-- mechanical beats precise and brittle at a gate that stops delivery.
--
-- And a trigger rather than a fourth definition of `deliver_handover`, for the
-- reason `refuse_uncovered_design` gives one schema over: re-emitting a
-- function is how a branch gets silently dropped, and this one already carries
-- the empty check, the blocking-defect check, the outstanding balance and the
-- approval request.

insert into core.event_types (type, description, canonical)
values ('handover.preparing', 'A handover package was opened and needs its contents listed (Doc 17 §9).', 'HandoverPreparing')
on conflict (type) do nothing;

create or replace function projects.emit_handover_preparing()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'preparing' then
    perform core.emit_event(
      new.organization_id, 'handover.preparing', 'handover', new.id,
      jsonb_build_object('project_id', new.project_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists emit_handover_preparing on projects.handovers;
create trigger emit_handover_preparing
  after insert on projects.handovers
  for each row execute function projects.emit_handover_preparing();

create table if not exists projects.handover_requirements (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  handover_id       uuid not null references projects.handovers(id) on delete cascade,

  -- The package's own vocabulary, so a requirement and the item that meets it
  -- are the same kind of thing rather than two lists that have to be kept in
  -- step by hand.
  kind              text not null check (kind in (
    'artifact', 'repository', 'deployment', 'documentation',
    'credential', 'invoice', 'warranty'
  )),

  label             text not null check (length(btrim(label)) between 1 and 160),

  -- Why THIS project owes it. A checklist somebody can't argue with is a
  -- checklist nobody reads.
  reason            text not null check (length(btrim(reason)) between 1 and 600),

  drafted_by_agent  text references ai.agents(key),
  created_at        timestamptz not null default now()
);

create unique index if not exists handover_requirements_one_per_label
  on projects.handover_requirements (handover_id, kind, label);

comment on table projects.handover_requirements is
  'Document 17 section 9, as what this project owes rather than what was handed over. Separate from projects.handover_items on purpose: an item is evidence, a requirement is an obligation, and writing empty items instead would make deliver_handover''s empty-package refusal pass on placeholders. A requirement carries no reference and no transfer_method - those are the artifact, and the artifact is a person''s.';

-- ── the gate ─────────────────────────────────────────────────────────────

create or replace function projects.refuse_incomplete_package()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_missing text;
begin
  if new.status <> 'delivered' or coalesce(old.status, '') = 'delivered' then
    return new;
  end if;

  -- Vacuous where nothing was ever listed, exactly like
  -- `refuse_uncovered_design` is vacuous on a project with no scope baseline.
  -- A rule cannot report what a package is missing until somebody has said
  -- what it should hold.
  select string_agg(distinct r.kind, ', ' order by r.kind) into v_missing
    from projects.handover_requirements r
   where r.handover_id = new.id
     and not exists (
       select 1
         from projects.handover_items i
        where i.handover_id = new.id
          and i.kind = r.kind
     );

  if v_missing is not null then
    raise exception
      'this package still owes: %  (Doc 17 §3 — a handover is delivered when it is complete)', v_missing
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function projects.refuse_incomplete_package() is
  'Document 17 section 3: "Handover package is complete." deliver_handover could only ever refuse an EMPTY package, so one item satisfied it as completely as fifteen. Matches by kind rather than by label on purpose - matching on wording would make a delivery gate depend on how somebody phrased a checklist. A trigger rather than a fourth definition of deliver_handover, for the reason refuse_uncovered_design gives: re-emitting a function is how a branch gets silently dropped.';

drop trigger if exists refuse_incomplete_package on projects.handovers;
create trigger refuse_incomplete_package
  before update of status on projects.handovers
  for each row execute function projects.refuse_incomplete_package();

-- ── tenancy ──────────────────────────────────────────────────────────────

alter table projects.handover_requirements enable row level security;
alter table projects.handover_requirements force row level security;

drop policy if exists handover_requirements_select on projects.handover_requirements;
create policy handover_requirements_select on projects.handover_requirements
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop trigger if exists org_match_handover_requirements on projects.handover_requirements;
create trigger org_match_handover_requirements
  before insert or update of handover_id, organization_id on projects.handover_requirements
  for each row execute function core.enforce_parent_org('handover_id', 'projects.handovers');

drop trigger if exists freeze_org_handover_requirements on projects.handover_requirements;
create trigger freeze_org_handover_requirements
  before update of organization_id on projects.handover_requirements
  for each row execute function core.freeze_organization_id();

grant select on projects.handover_requirements to authenticated;
grant select, insert on projects.handover_requirements to service_role;

-- ── and the agent that lists them ────────────────────────────────────────

update ai.agents
   set enabled = true,
       disabled_reason = null
 where key = 'handover';

notify pgrst, 'reload schema';
