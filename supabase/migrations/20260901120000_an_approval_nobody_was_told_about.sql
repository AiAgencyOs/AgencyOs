-- An approval nobody was told about — G-176.
--
-- Found by a fresh zero-trust audit, and it is the quietest failure in the
-- system.
--
-- `crm.handleApprovalRequested` looks up the organization's internal channel.
-- With none linked it returns:
--
--     { status: 'succeeded', outcome: 'no_group' }
--
-- The job settles GREEN. No dead job, no stalled job, no unpublished event —
-- nothing the operational backlog counts. The quotation sits at
-- `pending_approval` for ever, and the only way anybody discovers it is by
-- opening /approvals and happening to look.
--
-- That branch is not wrong. An organization that has not linked a channel has
-- nowhere to send to, and failing the job would retry into the same absence
-- until it parked dead — a config gap dressed up as a system fault. The defect
-- is that the CONSEQUENCE was invisible: the system knew an owner had not been
-- told and had no way to say so.
--
-- ── two halves, and the second is the one that matters ────────────────────
--
--   1. COUNT IT. `core.operational_backlog()` gains `unannounced_approvals`:
--      pending, internal-audience requests in an organization with no live
--      internal channel. It is `failing` rather than `degraded` — an OVERDUE
--      approval means a person has not answered, which is a person problem;
--      an UNANNOUNCED one means nobody was ever asked, which is ours.
--
--   2. FIX IT ON LINK. The moment the owner links their number, every request
--      still waiting is announced. Without this, the manual step in the
--      runbook repairs the future and abandons the past: the owner links their
--      phone, sees nothing, and the quotation that was waiting stays waiting.
--
-- The re-announcement is free of duplicates by construction rather than by a
-- new rule: `handleApprovalRequested` writes its message under the external
-- ref `approval:<request id>`, so a second announcement of the same request
-- finds the row already there and answers `already_announced`.

-- ── 1. what the backlog counts ────────────────────────────────────────────
--
-- A live internal channel is either kind. ADM-91/G-159 made `internal_direct`
-- the preferred one on this deployment because Meta refuses Groups eligibility
-- (#131215), but an organization that has a working group is not unannounced,
-- and hard-coding the preference here would report a false alarm the day that
-- changes.
--
-- Scoped to `audience = 'internal'`, because that is exactly the set
-- `approvals.request_approval` emits `approval.requested` for. A
-- client-audience request is a decision recorded by staff with evidence
-- (ADM-08d) and was never going to be announced anywhere.

-- Dropped rather than replaced: Postgres refuses to change the return type of
-- an existing function, and this one gains two columns. Nothing holds a
-- dependency on it — it is called by PostgREST from the observability reader
-- and by the verification scripts, both by name at request time.
drop function if exists core.operational_backlog();

create function core.operational_backlog()
returns table (
  dead_jobs bigint,
  stalled_jobs bigint,
  stuck_queued_jobs bigint,
  unpublished_events bigint,
  dead_events bigint,
  overdue_approvals bigint,
  unannounced_approvals bigint,
  oldest_dead_at timestamptz,
  oldest_unpublished_at timestamptz,
  oldest_overdue_due_at timestamptz,
  oldest_unannounced_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    (select count(*) from core.jobs where status = 'dead'),
    (select count(*) from core.jobs
      where status = 'running' and locked_at < now() - interval '15 minutes'),
    (select count(*) from core.jobs
      where status = 'queued' and run_at < now() - interval '15 minutes'),
    -- Unpublished and still being tried: live, past the staleness line.
    (select count(*) from core.outbox_events
      where published_at is null and dead_at is null and created_at < now() - interval '15 minutes'),
    -- Given up on: the dispatcher will not retry these, and the downstream
    -- work they carried never happened.
    (select count(*) from core.outbox_events where dead_at is not null),
    (select count(*) from approvals.approval_requests
      where state = 'pending' and sla_due_at < now()),
    -- G-176: raised, still waiting, and nobody was ever told — because the
    -- organization has no channel to be told on.
    (select count(*) from approvals.approval_requests r
      where r.state = 'pending'
        and r.audience = 'internal'
        and not exists (
          select 1 from crm.conversations c
           where c.organization_id = r.organization_id
             and c.kind in ('internal_direct', 'internal_group')
             and c.status <> 'abandoned'
        )),
    (select min(updated_at) from core.jobs where status = 'dead'),
    (select min(created_at) from core.outbox_events where published_at is null and dead_at is null),
    (select min(sla_due_at) from approvals.approval_requests
      where state = 'pending' and sla_due_at < now()),
    (select min(r.created_at) from approvals.approval_requests r
      where r.state = 'pending'
        and r.audience = 'internal'
        and not exists (
          select 1 from crm.conversations c
           where c.organization_id = r.organization_id
             and c.kind in ('internal_direct', 'internal_group')
             and c.status <> 'abandoned'
        ));
$$;

comment on function core.operational_backlog() is
  'What the system believes is wrong, counted from states it declared itself. G-176 adds unannounced_approvals: a pending internal-audience request in an organization with no live internal channel — raised, waiting, and nobody ever told. Distinct from overdue_approvals, which is a person who has not answered; this is a person who was never asked.';

-- ── 2. linking the channel announces what was waiting ─────────────────────
--
-- Deliberately NOT `security definer`. It takes an organization id, and a
-- definer function reading approval requests for an id it was handed is a
-- cross-tenant read waiting to be found. Under the caller's own RLS an owner
-- of one organization passing another's id selects nothing and emits nothing —
-- safe by construction rather than by a check that could be forgotten. The
-- service role bypasses RLS as it does everywhere else.
--
-- Returns the count so a caller can say what happened, and so a verification
-- can assert it rather than infer it from a side effect.

create or replace function crm.announce_waiting_approvals(p_organization_id uuid)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_request record;
  v_count   bigint := 0;
begin
  for v_request in
    select r.id, r.reference, r.subject_type, r.subject_id, r.summary,
           r.amount_minor, r.required_role, r.sla_due_at
      from approvals.approval_requests r
     where r.organization_id = p_organization_id
       and r.state = 'pending'
       and r.audience = 'internal'
     order by r.created_at
  loop
    -- The same payload `approvals.request_approval` emits, because the
    -- announcer reads the same fields from it. A second shape here would be a
    -- second thing to keep in step, and the one that drifts is the one nobody
    -- remembers exists.
    perform core.emit_event(
      p_organization_id,
      'approval.requested',
      'approval_request',
      v_request.id,
      jsonb_build_object(
        'reference',    v_request.reference,
        'subjectType',  v_request.subject_type,
        'subjectId',    v_request.subject_id,
        'summary',      v_request.summary,
        'amountMinor',  v_request.amount_minor,
        'requiredRole', v_request.required_role,
        'slaDueAt',     v_request.sla_due_at
      ),
      null
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function crm.announce_waiting_approvals(uuid) is
  'Re-emits approval.requested for every still-pending internal request in one organization, so linking a channel announces what was already waiting rather than only what comes next (G-176). Idempotent at the far end: handleApprovalRequested keys its message on approval:<request id>, so a request already announced answers already_announced. Not security definer on purpose — under the caller''s own RLS an owner passing another tenant''s id selects nothing.';

grant execute on function crm.announce_waiting_approvals(uuid) to authenticated, service_role;

-- ── 3. both linkers call it ───────────────────────────────────────────────
--
-- The internal channel can be linked two ways and both must repair the
-- backlog, or which door the owner used decides whether their waiting
-- quotation is announced.

create or replace function crm.link_internal_recipient(
  p_organization_id uuid,
  p_phone text,
  p_title text default null
)
returns table (outcome text, conversation_id uuid)
language plpgsql
set search_path = ''
as $$
declare
  v_digits text;
  v_ref    text;
  v_id     uuid;
  v_result text;
begin
  -- Repointing where MONEY is announced is the owner's act. The service says
  -- so with better words; this is the belt under the braces, because the RPC
  -- is granted to `authenticated` and conversations_write admits any internal
  -- member — without this line, the capability gate would be service-owned
  -- only. An identity-less caller (service_role, the verification scripts)
  -- passes: it already holds the whole database.
  if (select auth.uid()) is not null and not (select core.is_owner()) then
    return query select 'forbidden'::text, null::uuid;
    return;
  end if;

  -- Digits only, out of whatever a person typed: spaces, +91, dashes.
  v_digits := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  if length(v_digits) not between 8 and 15 then
    return query select 'bad_phone'::text, null::uuid;
    return;
  end if;
  v_ref := 'internal:+' || v_digits;

  -- Re-link for real. The group linker's already_linked branch DISCARDS a
  -- corrected ref; here a second link with a new number must mean the number
  -- changed, because a person owns their mistakes only if the button obeys.
  update crm.conversations c
     set external_ref = v_ref,
         title        = coalesce(p_title, c.title)
   where c.organization_id = p_organization_id
     and c.kind = 'internal_direct'
     and c.status <> 'abandoned'
  returning c.id into v_id;

  if v_id is not null then
    v_result := 'relinked';
  else
    begin
      insert into crm.conversations (
        organization_id, kind, channel, external_ref, status, title
      )
      values (
        p_organization_id, 'internal_direct', 'whatsapp', v_ref, 'active', p_title
      )
      returning id into v_id;
      v_result := 'linked';
    exception
      when unique_violation then
        -- Two ways here, both real. A concurrent first link won the race on
        -- conversations_internal_direct_key — take the update path against the
        -- row that now exists. Or an ABANDONED internal_direct row still holds
        -- this exact ref (conversations_external_ref_key is not partial on
        -- status) — resurrect it rather than refusing a person their own
        -- number back.
        update crm.conversations c
           set external_ref = v_ref,
               title        = coalesce(p_title, c.title),
               status       = 'active'
         where c.organization_id = p_organization_id
           and c.kind = 'internal_direct'
           and (c.status <> 'abandoned' or c.external_ref = v_ref)
        returning c.id into v_id;

        if v_id is null then
          raise;
        end if;

        v_result := 'relinked';
    end;
  end if;

  -- G-176. Announce what was already waiting. After the link, never before:
  -- an announcement emitted while the channel does not yet exist is a job
  -- that will find no group and answer `no_group` — the exact silence this
  -- migration exists to end.
  perform crm.announce_waiting_approvals(p_organization_id);

  return query select v_result, v_id;
end;
$$;

comment on function crm.link_internal_recipient(uuid, text, text) is
  'Links the owner''s own WhatsApp number as the internal announcement channel (ADM-91, G-159), owner-only, and since G-176 announces every approval that was already waiting — so the manual link repairs the past as well as the future.';

-- The group linker does the same for an internal group.
--
-- Not because a group is the channel this deployment uses — Meta refuses
-- Groups eligibility (#131215) and `internalChannel` prefers the direct
-- thread — but because which DOOR the owner used must not decide whether the
-- approval waiting for them is announced. The day eligibility is granted, this
-- path is already correct.
--
-- Only for `internal_group`. A project group is the client's thread; emitting
-- an internal approval announcement at it is the one mistake this whole area
-- exists to prevent.

create or replace function crm.link_whatsapp_group(
  p_organization_id uuid,
  p_kind text,
  p_external_ref text,
  p_project_id uuid default null,
  p_title text default null
)
returns table (outcome text, conversation_id uuid)
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_kind not in ('project_group', 'internal_group') then
    return query select 'bad_kind'::text, null::uuid;
    return;
  end if;

  begin
    insert into crm.conversations (
      organization_id, kind, project_id, channel, external_ref, status, title
    )
    values (
      p_organization_id, p_kind, p_project_id, 'whatsapp', p_external_ref, 'active', p_title
    )
    returning id into v_id;
  exception
    when unique_violation then
      -- Three indexes can raise this and they mean different things, so the
      -- handler has to tell them apart.
      --
      -- Two attempts at that failed against real Postgres before this one.
      -- `get stacked diagnostics ... constraint_name` came back empty from
      -- inside a nested block, and still did not identify a partial unique
      -- *index* once the declaration was moved out — so a group held by another
      -- agency was reported to the caller as their own, twice, with every
      -- structural test green both times.
      --
      -- Asking the data settles it. The rows are right there in the same
      -- transaction, they cannot be empty, and they are not prose that a
      -- server's locale can translate.

      -- Does somebody already hold this group id? That is the refusal a retry
      -- cannot fix, and it is checked first because it outranks the others: a
      -- group belonging to another tenant is not "already linked" to this one.
      if exists (
        select 1
          from crm.conversations c
         where c.external_ref = p_external_ref
           and c.kind in ('project_group', 'internal_group')
           and c.status <> 'abandoned'
           and not (
             (p_kind = 'project_group' and c.project_id is not distinct from p_project_id)
             or (p_kind = 'internal_group' and c.organization_id = p_organization_id and c.kind = 'internal_group')
           )
      ) then
        return query select 'group_taken'::text, null::uuid;
        return;
      end if;

      -- Otherwise this project, or this organization, already has a live group.
      select c.id into v_id
        from crm.conversations c
       where c.kind = p_kind
         and c.status <> 'abandoned'
         and (
           (p_kind = 'project_group' and c.project_id = p_project_id)
           or (p_kind = 'internal_group' and c.organization_id = p_organization_id)
         )
       limit 1;

      -- A violation that matches neither is one this function does not
      -- understand, and answering it as success would be a guess.
      if v_id is null then
        raise;
      end if;

      return query select 'already_linked'::text, v_id;
      return;
  end;

  -- G-176, and only for the internal channel — see the header above.
  if p_kind = 'internal_group' then
    perform crm.announce_waiting_approvals(p_organization_id);
  end if;

  return query select 'linked'::text, v_id;
end;
$$;
