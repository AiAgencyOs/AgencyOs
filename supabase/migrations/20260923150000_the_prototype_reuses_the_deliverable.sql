-- ═══════════════════════════════════════════════════════════════════════════
-- The prototype reuses the deliverable it already had a home in.
--
-- PROTO §4, §5, §8, §11, §12; QAP §7; ADM-82. `docs/phase-4-gap-analysis.md`
-- step 4.
--
-- ── the biggest reuse in the whole Phase 4 build ──────────────────────────
--
-- `projects.deliverables` (20260813120001) already has, and has had since
-- before Phase 4 was designed: a `kind = 'prototype'` value, a per-kind
-- version sequence, an `artifact_url`, `changelog`/`known_issues`, a
-- draft → in_review → approved/changes_requested lifecycle, a real
-- `submit_deliverable` door that raises a CLIENT-audience approval through
-- the same engine every other approval goes through, a real `sync_
-- deliverable_decision` puller already wired into `carryDecisionToSubject`,
-- and a real Admin Panel screen (`app/(internal)/projects/[projectId]/
-- prototype/page.tsx`) with working add/submit forms. Building Phase 4 its
-- own `prototype_builds` table with its own review lifecycle beside all of
-- that would be the exact duplicate system this repository's own audit
-- history keeps finding and undoing.
--
-- So this migration adds no lifecycle at all. It adds exactly one thing
-- `deliverables` cannot hold: the STRUCTURED, SAFE content of one prototype
-- build — see `prototypeBuildSchema`'s own docblock (src/modules/projects/
-- schema.ts) for why that content is a closed vocabulary of elements rather
-- than raw markup. `artifact_url` on the deliverable row points at the
-- internal preview route that renders this content; the deliverable IS the
-- reviewable thing, this table is what the preview route reads.
--
-- ── the ONE gate deliverables genuinely lacks: independent QA ─────────────
--
-- `deliverables` moves straight from `draft` to `in_review` on a human's own
-- "submit" click — there is no automated coverage gate in that path at all.
-- QAP's whole document is that gate: an agent may not submit its own build
-- for review un-reviewed. `qa_findings`/`qa_reviewed_at` on this table (not
-- on `deliverables`, which stays untouched) carry that verdict, visible on
-- the same Admin Panel page before a human decides whether to click Submit —
-- the human deciding to submit remains the real Admin gate PROTO/Impl name,
-- not automated away.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.prototype_artifacts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  -- One prototype build per LOCKED UI version — PROTO §8's "every build
  -- stores source_ui_version_id; rejects non-locked UI", enforced structurally
  -- by requiring `ui_versions.status = 'locked'` in the door below rather
  -- than only in a comment.
  ui_version_id    uuid not null unique references projects.ui_versions(id) on delete restrict,

  -- The deliverable this artifact's content belongs to. Restrict, not
  -- cascade: deleting a deliverable is not this migration's concern, and a
  -- dangling artifact pointing at nothing would be worse than refusing the
  -- delete.
  deliverable_id   uuid not null unique references projects.deliverables(id) on delete restrict,

  -- The model's structured build — see prototypeBuildSchema's own docblock
  -- for why this is a closed element vocabulary, never markup.
  screens          jsonb not null,

  qa_findings      jsonb,
  qa_reviewed_at   timestamptz,

  created_at       timestamptz not null default now(),

  constraint prototype_artifacts_screens_is_an_array
    check (jsonb_typeof(screens) = 'array'),

  constraint prototype_artifacts_builds_something
    check (jsonb_array_length(screens) > 0)
);

comment on table projects.prototype_artifacts is
  'PROTO section 8. The structured, safe content of one prototype build - one per LOCKED ui_version, one per projects.deliverables row (kind=prototype). Holds no lifecycle of its own: draft/in_review/approved status, the client-audience approval and the Admin Panel screen are all projects.deliverables'' already-real ones. qa_findings/qa_reviewed_at are the one gate deliverables genuinely lacks - an independent coverage check before a human decides to submit.';

comment on column projects.prototype_artifacts.screens is
  'Validated against prototypeBuildSchema before this column is written. A closed vocabulary of elements (heading/text/button/link/input/image_placeholder/list) a trusted renderer draws as real HTML - never raw markup from the model, which would be a stored-XSS vector the moment a client opened the preview.';

create trigger prototype_artifacts_parent_org_project
  before insert or update of project_id on projects.prototype_artifacts
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

create trigger prototype_artifacts_parent_org_version
  before insert or update of ui_version_id on projects.prototype_artifacts
  for each row execute function core.enforce_parent_org('ui_version_id', 'projects.ui_versions');

create trigger prototype_artifacts_parent_org_deliverable
  before insert or update of deliverable_id on projects.prototype_artifacts
  for each row execute function core.enforce_parent_org('deliverable_id', 'projects.deliverables');

create trigger freeze_org_prototype_artifacts
  before update of organization_id on projects.prototype_artifacts
  for each row execute function core.freeze_organization_id();

alter table projects.prototype_artifacts enable row level security;
alter table projects.prototype_artifacts force row level security;

-- The client portal (`app/(client)/portal/[projectId]/page.tsx`, G-057)
-- already shows a client every non-draft deliverable and links its
-- artifact_url; this artifact IS what that link opens once the surrounding
-- deliverable is `in_review` or `approved`. Same rule
-- `deliverables_select` already carries for the deliverable itself, applied
-- here through the deliverable it belongs to: never draft, and only the
-- client's own project.
drop policy if exists prototype_artifacts_select on projects.prototype_artifacts;
create policy prototype_artifacts_select on projects.prototype_artifacts
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (
      (select core.is_internal())
      or (
        (select core.is_client())
        and exists (
          select 1
            from projects.deliverables d
            join projects.projects p on p.id = d.project_id
           where d.id = deliverable_id
             and d.status <> 'draft'
             and p.client_account_id = (select core.current_client_account_id())
        )
      )
    )
  );

-- No write policy, deliberately. Every mutation goes through a door below.

grant select on projects.prototype_artifacts to authenticated, service_role;

insert into core.event_types (type, description, canonical) values
  ('project.prototype_build_ready',
   'PROTO section 8. A Prototype Agent build was recorded for a locked UI version, as a draft deliverable. Not yet QA-reviewed.',
   true),
  ('project.prototype_qa_reviewed',
   'QAP section 7. Independent Prototype QA reached a coverage verdict on a build: qa_pass or qa_changes_required. Decided by quality_assurance, never by ui_prototype (ADM-82).',
   true)
on conflict (type) do nothing;

-- ── the door that records a build ─────────────────────────────────────────

create or replace function projects.record_prototype_build(
  p_ui_version_id uuid,
  p_screens       jsonb
)
returns table (
  -- 'built' | 'already_built' | 'wrong_state' | 'unknown_version'
  -- | 'no_actor' | 'forbidden'
  outcome               text,
  prototype_artifact_id uuid,
  deliverable_id        uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_version  projects.ui_versions;
  v_existing projects.prototype_artifacts;
  v_deliverable record;
  v_artifact_id uuid;
begin
  -- The service role builds because the trigger is the ui_prototype WORKFLOW
  -- reacting to `project.ui_version_locked` — the same shape every
  -- event-triggered door in this migration set uses.
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid, null::uuid; return;
  end if;

  select v.* into v_version
    from projects.ui_versions v
   where v.id = p_ui_version_id
   for update;

  if v_version.id is null then
    return query select 'unknown_version'::text, null::uuid, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_version.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid, null::uuid; return;
  end if;

  select a.* into v_existing
    from projects.prototype_artifacts a
   where a.ui_version_id = v_version.id;

  if v_existing.id is not null then
    -- Master §22: a duplicate event returns the existing artifact
    -- idempotently.
    return query select 'already_built'::text, v_existing.id, v_existing.deliverable_id; return;
  end if;

  -- PROTO §8: "rejects non-locked UI." Enforced here, not only in the
  -- negative test that names it.
  if v_version.status <> 'locked' then
    return query select 'wrong_state'::text, null::uuid, null::uuid; return;
  end if;

  if p_screens is null or jsonb_typeof(p_screens) <> 'array' or jsonb_array_length(p_screens) = 0 then
    return query select 'wrong_state'::text, null::uuid, null::uuid; return;
  end if;

  -- The existing door. No second "create a deliverable" mechanism is
  -- invented for Phase 4 — see the migration header.
  select * into v_deliverable
    from projects.add_deliverable(
      v_version.project_id,
      'prototype',
      'Prototype build',
      '/projects/' || v_version.project_id || '/prototype/preview/' || v_version.id,
      null,
      null,
      null
    );

  if v_deliverable.outcome <> 'created' then
    return query select 'wrong_state'::text, null::uuid, null::uuid; return;
  end if;

  insert into projects.prototype_artifacts (
    organization_id, project_id, ui_version_id, deliverable_id, screens
  ) values (
    v_version.organization_id, v_version.project_id, v_version.id, v_deliverable.deliverable_id, p_screens
  )
  returning id into v_artifact_id;

  perform core.record_audit(
    v_version.organization_id, 'project.prototype_build_ready', 'prototype_artifact', v_artifact_id, null,
    jsonb_build_object('projectId', v_version.project_id, 'uiVersionId', v_version.id, 'deliverableId', v_deliverable.deliverable_id)
  );

  perform core.emit_event(
    v_version.organization_id, 'project.prototype_build_ready',
    'prototype_artifact', v_artifact_id,
    jsonb_build_object('projectId', v_version.project_id, 'uiVersionId', v_version.id, 'deliverableId', v_deliverable.deliverable_id)
  );

  return query select 'built'::text, v_artifact_id, v_deliverable.deliverable_id;
end;
$$;

comment on function projects.record_prototype_build(uuid, jsonb) is
  'PROTO section 8. Records a prototype build for a LOCKED ui_version and files it as a projects.deliverables row (kind=prototype) through the EXISTING add_deliverable door - no second creation mechanism. One build per ui_version: a replay answers already_built with the existing ids (Master section 22).';

revoke all on function projects.record_prototype_build(uuid, jsonb) from public, anon;
grant execute on function projects.record_prototype_build(uuid, jsonb) to authenticated, service_role;

-- ── the door that records Prototype QA's verdict ─────────────────────────

create or replace function projects.record_prototype_qa_verdict(
  p_prototype_artifact_id uuid,
  p_outcome               text,
  p_findings              jsonb
)
returns table (
  -- 'recorded' | 'already_reviewed' | 'unknown_artifact' | 'bad_outcome'
  -- | 'no_actor' | 'forbidden'
  outcome               text,
  prototype_artifact_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_artifact projects.prototype_artifacts;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  if p_outcome not in ('qa_pass', 'qa_changes_required') then
    return query select 'bad_outcome'::text, null::uuid; return;
  end if;

  select a.* into v_artifact
    from projects.prototype_artifacts a
   where a.id = p_prototype_artifact_id
   for update;

  if v_artifact.id is null then
    return query select 'unknown_artifact'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_artifact.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_artifact.qa_reviewed_at is not null then
    -- Master §22's idempotent-replay shape: a redelivered event must not
    -- overwrite an existing verdict with a second, possibly different one.
    return query select 'already_reviewed'::text, v_artifact.id; return;
  end if;

  update projects.prototype_artifacts
     set qa_findings = p_findings,
         qa_reviewed_at = now()
   where id = v_artifact.id;

  perform core.record_audit(
    v_artifact.organization_id, 'project.prototype_qa_reviewed', 'prototype_artifact', v_artifact.id, null,
    jsonb_build_object('projectId', v_artifact.project_id, 'outcome', p_outcome)
  );

  perform core.emit_event(
    v_artifact.organization_id, 'project.prototype_qa_reviewed',
    'prototype_artifact', v_artifact.id,
    jsonb_build_object('projectId', v_artifact.project_id, 'deliverableId', v_artifact.deliverable_id, 'outcome', p_outcome)
  );

  return query select 'recorded'::text, v_artifact.id;
end;
$$;

comment on function projects.record_prototype_qa_verdict(uuid, text, jsonb) is
  'QAP section 7. Records independent Prototype QA''s verdict, under the artifact''s own row lock. Does not touch projects.deliverables.status - the human "submit for review" gate on the existing prototype Admin Panel screen stays a human decision, informed by this verdict rather than bypassed by it.';

revoke all on function projects.record_prototype_qa_verdict(uuid, text, jsonb) from public, anon;
grant execute on function projects.record_prototype_qa_verdict(uuid, text, jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';
