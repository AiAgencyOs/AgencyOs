-- ═══════════════════════════════════════════════════════════════════════════
-- What the agency hands over, and what the client said about it.
--
-- Phase 12. Gaps G-021 (UI design phase), G-023 (prototype phase) and G-022
-- (client approval of an artifact). This is the missing middle: lead capture
-- through requirements was built, billing through payment was built, and
-- everything between requirement approval and invoice generation had no
-- representation in the database at all.
--
-- ── one table for design, prototype and build ─────────────────────────────
--
-- The same argument the approval engine settled a day earlier. A design
-- version, a prototype APK and a development build differ in what they
-- contain and in nothing else that matters here: each is a thing shown to a
-- client, at a version, that the client says yes or no to. Three tables would
-- mean three shapes of "which version did they approve", and the answer to
-- that question is the entire point of the record.
--
-- ── nothing is ever overwritten ───────────────────────────────────────────
--
-- Directive §35, and the reason it exists: an approval names a version. If v2
-- can be edited after the client approved it, the approval refers to something
-- that no longer exists, and the only record of what was agreed is gone. So a
-- revision is a new row, `deliverables_guard` refuses edits to anything but
-- status, and the version number is allocated under the project's own lock —
-- the C2 pattern, because two people uploading at once must not both become
-- v3.
--
-- ── the approval engine is the reviewer ───────────────────────────────────
--
-- `submit_deliverable` raises an approval request with subject_type
-- 'deliverable' rather than inventing a second review mechanism. That
-- subject type has existed since the engine was built and had no caller; this
-- is it. ADM-08d decided a client's decision is recorded by staff with the
-- evidence attached, so a deliverable's approval is `audience = 'client'` and
-- the engine already refuses to settle one without saying where the client
-- agreed.
--
-- What this does NOT do: it does not gate anything. An approved design does
-- not unlock a milestone or release an invoice, because which approvals gate
-- which payments is ADM-13/ADM-14 territory and remains the Admin's. The
-- record is built; the gates come when the rules are written down.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.deliverables (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  -- What kind of thing this is. Milestone-shaped rather than free text: a
  -- client reviewing "the design" and "the prototype" is reviewing two
  -- different promises, and the version sequence is per kind for that reason.
  kind             text not null check (kind in ('design', 'prototype', 'build', 'document')),

  -- Per (project, kind), starting at 1. Allocated under the project's lock.
  version          int not null check (version >= 1),

  title            text not null check (length(trim(title)) > 0),
  -- Where the thing actually is. A link rather than a blob: an APK or a Figma
  -- file has a home already, and copying it into Postgres would make the
  -- database the worst file server in the stack.
  artifact_url     text,
  -- What changed since the last version, in the words of whoever made it.
  changelog        text,
  -- Known limitations, per directive §17 — sent to the client with the build
  -- rather than discovered by them.
  known_issues     text,

  status           text not null default 'draft' check (status in
                     ('draft', 'in_review', 'approved', 'changes_requested', 'superseded')),

  -- The approval request that is reviewing it, once submitted.
  approval_request_id uuid references approvals.approval_requests(id) on delete set null,

  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (project_id, kind, version)
);

comment on table projects.deliverables is
  'Everything shown to a client, at a version: designs, prototypes, builds, documents. Append-only apart from status — an approval names a version, and a version that can be edited afterwards makes the approval refer to something that no longer exists.';

create index if not exists deliverables_project_idx
  on projects.deliverables (project_id, kind, version desc);

create index if not exists deliverables_review_idx
  on projects.deliverables (organization_id, status) where status = 'in_review';

drop trigger if exists set_updated_at on projects.deliverables;
create trigger set_updated_at
  before update on projects.deliverables
  for each row execute function core.set_updated_at();

-- ── append-only apart from status ────────────────────────────────────────
create or replace function projects.deliverables_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.project_id   is distinct from old.project_id
     or new.kind         is distinct from old.kind
     or new.version      is distinct from old.version
     or new.title        is distinct from old.title
     or new.artifact_url is distinct from old.artifact_url
     or new.changelog    is distinct from old.changelog
     or new.known_issues is distinct from old.known_issues
     or new.created_by   is distinct from old.created_by
     or new.created_at   is distinct from old.created_at
  then
    raise exception
      'deliverable %s v% is immutable; submit version % instead',
      old.kind, old.version, old.version + 1
      using errcode = 'restrict_violation';
  end if;

  -- An approved or superseded version is settled. `changes_requested` is not:
  -- that is the state a new version is made from, and the row itself stays as
  -- the record of what was asked for.
  if old.status in ('approved', 'superseded') and new.status is distinct from old.status then
    raise exception 'deliverable %s v% is already %', old.kind, old.version, old.status
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists deliverables_guard on projects.deliverables;
create trigger deliverables_guard
  before update on projects.deliverables
  for each row execute function projects.deliverables_guard();

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS — internal writes, and the client sees what was shown to them
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.deliverables enable row level security;

drop policy if exists deliverables_select on projects.deliverables;
create policy deliverables_select on projects.deliverables
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (
      (select core.is_internal())
      or (
        -- The client portal, when it exists (G-057), shows a client what was
        -- actually put in front of them and never a draft. Written now
        -- because the rule belongs with the table rather than with the page.
        (select core.is_client())
        and status <> 'draft'
        and exists (
          select 1 from projects.projects p
           where p.id = project_id
             and p.client_account_id = (select core.current_client_account_id())
        )
      )
    )
  );

drop policy if exists deliverables_write on projects.deliverables;
create policy deliverables_write on projects.deliverables
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.can_manage_delivery())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.can_manage_delivery())
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- Adding a version
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.add_deliverable(
  p_project_id   uuid,
  p_kind         text,
  p_title        text,
  p_artifact_url text default null,
  p_changelog    text default null,
  p_known_issues text default null,
  p_created_by   uuid default null
)
returns table (
  -- 'created' | 'not_found' | 'forbidden'
  outcome        text,
  deliverable_id uuid,
  version        int
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_project projects.projects;
  v_next    int;
  v_row     projects.deliverables;
begin
  -- The lock is on the project, so two people adding a design and a prototype
  -- at the same moment serialise against each other. Coarser than locking per
  -- kind, and correct for the same reason C2 locked the conversation: the
  -- alternative is a unique-violation somebody has to interpret.
  select p.* into v_project
    from projects.projects p
   where p.id = p_project_id
   for update;

  if v_project.id is null then
    return query select 'not_found'::text, null::uuid, null::int;
    return;
  end if;

  select coalesce(max(d.version), 0) + 1 into v_next
    from projects.deliverables d
   where d.project_id = p_project_id
     and d.kind = p_kind;

  insert into projects.deliverables (
    organization_id, project_id, kind, version, title,
    artifact_url, changelog, known_issues, created_by
  )
  values (
    v_project.organization_id, p_project_id, p_kind, v_next, p_title,
    p_artifact_url, p_changelog, p_known_issues, p_created_by
  )
  returning * into v_row;

  perform core.record_audit(
    v_project.organization_id,
    'deliverable.added',
    'deliverable',
    v_row.id,
    null,
    jsonb_build_object('kind', p_kind, 'version', v_next, 'project_id', p_project_id)
  );

  return query select 'created'::text, v_row.id, v_next;
end;
$$;

comment on function projects.add_deliverable(uuid, text, text, text, text, text, uuid) is
  'Adds the next version of a deliverable, allocating the number under the project''s lock so two uploads cannot both become v3. Never overwrites: a revision is a new row, because an approval names a version.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Sending it for review
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.submit_deliverable(
  p_deliverable_id uuid,
  p_requested_by   uuid default null,
  p_summary        text default null
)
returns table (
  -- 'submitted' | 'already_in_review' | 'not_found' | 'settled' | 'no_policy'
  outcome    text,
  request_id uuid,
  status     text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row      projects.deliverables;
  v_approval record;
begin
  select d.* into v_row
    from projects.deliverables d
   where d.id = p_deliverable_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  if v_row.status in ('approved', 'superseded') then
    return query select 'settled'::text, v_row.approval_request_id, v_row.status;
    return;
  end if;

  if v_row.status = 'in_review' then
    return query select 'already_in_review'::text, v_row.approval_request_id, v_row.status;
    return;
  end if;

  -- The approval engine reviews it. No second review mechanism is invented,
  -- and `deliverable` has been a subject type since the engine was built with
  -- nothing calling it — this is the caller.
  select * into v_approval
    from approvals.request_approval(
      v_row.organization_id,
      'deliverable',
      v_row.id,
      case when p_requested_by is null then 'system' else 'user' end,
      p_requested_by,
      coalesce(p_summary, v_row.kind || ' v' || v_row.version || ' — ' || v_row.title),
      jsonb_build_object(
        'kind', v_row.kind, 'version', v_row.version, 'title', v_row.title,
        'artifact_url', v_row.artifact_url, 'known_issues', v_row.known_issues
      ),
      null,
      -- ADM-08d: the client decides, a staff member records it with evidence.
      'client',
      null
    );

  if v_approval.outcome = 'no_policy' then
    -- Refused rather than submitted without a reviewer: a deliverable in
    -- review that nobody is named to answer is a promise to the client that
    -- the system cannot keep.
    return query select 'no_policy'::text, null::uuid, v_row.status;
    return;
  end if;

  update projects.deliverables
     set status = 'in_review',
         approval_request_id = v_approval.request_id
   where projects.deliverables.id = v_row.id;

  perform core.record_audit(
    v_row.organization_id,
    'deliverable.submitted',
    'deliverable',
    v_row.id,
    to_jsonb(v_row),
    jsonb_build_object('status', 'in_review', 'approval_request_id', v_approval.request_id)
  );

  return query select 'submitted'::text, v_approval.request_id, 'in_review'::text;
end;
$$;

comment on function projects.submit_deliverable(uuid, uuid, text) is
  'Puts a deliverable in front of the client by raising an approval request against it — audience ''client'', so ADM-08d''s evidence requirement applies. Refuses when no approval policy covers deliverables, because a review nobody is named to answer is a promise the system cannot keep.';

-- ═══════════════════════════════════════════════════════════════════════════
-- What the client said
-- ═══════════════════════════════════════════════════════════════════════════

/**
 * Bring a decision back from the approval engine onto the deliverable.
 *
 * Deliberately a pull rather than a trigger on `approval_requests`. A trigger
 * would make settling any approval — an invoice, a refund — reach into the
 * delivery module, which is the coupling ARCHITECTURE.md §3.2 exists to
 * prevent. The caller that settles a deliverable's approval calls this next.
 */
create or replace function projects.sync_deliverable_decision(
  p_deliverable_id uuid
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row    projects.deliverables;
  v_state  text;
  v_status text;
begin
  select d.* into v_row
    from projects.deliverables d
   where d.id = p_deliverable_id
   for update;

  if v_row.id is null or v_row.approval_request_id is null then
    return coalesce(v_row.status, 'not_found');
  end if;

  select r.state into v_state
    from approvals.approval_requests r
   where r.id = v_row.approval_request_id;

  v_status := case v_state
    when 'approved' then 'approved'
    when 'rejected' then 'changes_requested'
    when 'changes_requested' then 'changes_requested'
    else null
  end;

  if v_status is null or v_status = v_row.status then
    return v_row.status;
  end if;

  update projects.deliverables
     set status = v_status
   where projects.deliverables.id = v_row.id;

  -- An approved version supersedes every earlier one of its kind. The old
  -- rows stay — that is the revision history — but they stop being live.
  if v_status = 'approved' then
    update projects.deliverables d
       set status = 'superseded'
     where d.project_id = v_row.project_id
       and d.kind = v_row.kind
       and d.version < v_row.version
       and d.status not in ('approved', 'superseded');
  end if;

  perform core.record_audit(
    v_row.organization_id,
    'deliverable.' || v_status,
    'deliverable',
    v_row.id,
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('status', v_status, 'approval_request_id', v_row.approval_request_id)
  );

  return v_status;
end;
$$;

comment on function projects.sync_deliverable_decision(uuid) is
  'Brings the client''s decision back from the approval engine onto the deliverable, and supersedes every earlier version of that kind when one is approved. A pull rather than a trigger, so settling an invoice approval does not reach into the delivery module.';

revoke all on function projects.add_deliverable(uuid, text, text, text, text, text, uuid) from public;
revoke all on function projects.submit_deliverable(uuid, uuid, text) from public;
revoke all on function projects.sync_deliverable_decision(uuid) from public;

grant execute on function projects.add_deliverable(uuid, text, text, text, text, text, uuid) to authenticated, service_role;
grant execute on function projects.submit_deliverable(uuid, uuid, text) to authenticated, service_role;
grant execute on function projects.sync_deliverable_decision(uuid) to authenticated, service_role;

grant select, insert, update on projects.deliverables to authenticated, service_role;
