-- ═══════════════════════════════════════════════════════════════════════════
-- Five things a person could not do from the panel.
--
-- Element-level gaps from docs/AGENCYOS_ADMIN_REMAINING_GAPS.md, bucket C —
-- each a control the Admin Panel PDF draws that the schema could not honestly
-- back, and each closed here with the smallest honest change.
--
--   SCR-006 Leads · service filter   — `crm.leads` had no service column, so
--                                      the list's "filter by service" had
--                                      nothing to filter on. One free-text
--                                      column (≤ 80 chars); the list offers
--                                      the distinct values it already holds.
--   SCR-009 Edit a requirement draft — `crm.requirement_versions` is append-
--                                      only except for status (the guard
--                                      trigger, 20260810120004) and has no
--                                      draft state. An edit is therefore a NEW
--                                      proposed version written from the old
--                                      one, and the old one becomes
--                                      `superseded` — the one transition the
--                                      guard allows from any state. Nothing is
--                                      rewritten; the history stays.
--   SCR-017 Attach a meeting summary — `ai.memory_records` had a SELECT policy
--            to project memory          for staff and NO write policy: only the
--                                      sales handoff handlers (service role)
--                                      could write. The PDF's Client 360 asks
--                                      an admin to attach what a meeting said
--                                      to the project's memory. Relaxed to an
--                                      INSERT policy for owner and ops_admin
--                                      (core.is_admin(), the same two roles
--                                      that approve a requirement), for rows
--                                      no agent authored — an agent still
--                                      cannot write through it.
--   SCR-057/060 Retry a failed client — a failure is stamped on the message
--            delivery, with history    (metadata.delivery='failed') with no
--                                      job to requeue. A retry is a NEW send
--                                      through crm.send_outbound_message (so
--                                      the 24-hour window and consent still
--                                      decide); `retry_of` links the new row
--                                      to the one it retried and the original
--                                      counts its attempts in `retry_count`.
--
-- Every write here is a governed one and lands in audit.audit_log from inside
-- its own transaction: the requirement revision and the memory attachment
-- through core.record_audit; the lead's service through the row-change
-- trigger crm.leads already carries; the retry link through core.record_audit
-- beside the delivery audit crm.mark_outbound_delivery writes.
--
-- The doors are SECURITY INVOKER throughout. RLS is the authorization, and
-- each function re-checks the role the policy names so the refusal is a
-- named outcome rather than a silent zero-row update.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── SCR-006 · a lead names the service it asked about ─────────────────────

alter table crm.leads
  add column if not exists service text;

alter table crm.leads drop constraint if exists leads_service_is_short;
alter table crm.leads
  add constraint leads_service_is_short check (
    service is null or length(btrim(service)) between 1 and 80
  );

create index if not exists leads_organization_service_idx
  on crm.leads (organization_id, service)
  where service is not null;

comment on column crm.leads.service is
  'Free text, at most 80 characters: the service the lead asked about (SCR-006''s service filter). Set by a person through setLeadService; the leads list filters on it and offers the distinct values already recorded. Not a catalogue — the agency''s own words, and a filter, not a rule.';

-- ── SCR-009 · a requirement is edited as its next version ─────────────────
--
-- The guard trigger holds two rules this function respects rather than
-- relaxes: every column but status is immutable, and the only status a
-- decided or undecided version may become on its own is `superseded`. So an
-- edit INSERTS version n+1 (source 'human', status 'proposed', the edited
-- payload) and marks the version it was edited from `superseded`. The
-- supersede trigger already does that for a `proposed` source on insert; an
-- `accepted` source is superseded explicitly here, which is what the guard's
-- "any state → superseded" branch exists for. What was accepted stays on the
-- row as history; what stands is the new proposal, awaiting a decision.
--
-- Version allocation mirrors crm.insert_requirement_version (service-role
-- only): under a lock on the conversation, so two people editing at once
-- cannot collide on (conversation_id, version). An advisory lock rather than
-- `select ... for update` on the conversation, because row locking needs an
-- UPDATE policy on crm.conversations that an admin's session does not carry.

create or replace function crm.revise_requirement_version(
  p_source_version_id uuid,
  p_payload           jsonb
)
returns table (
  -- 'revised' | 'no_actor' | 'invalid_payload' | 'not_found' | 'forbidden'
  -- | 'not_revisable'
  outcome    text,
  version_id uuid,
  version    int,
  lead_id    uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_actor   uuid := (select auth.uid());
  v_source  crm.requirement_versions;
  v_lead_id uuid;
  v_id      uuid;
  v_version int;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, null::int, null::uuid; return;
  end if;

  if p_payload is null
     or jsonb_typeof(p_payload) <> 'object'
     or length(btrim(coalesce(p_payload->>'summary', ''))) = 0 then
    return query select 'invalid_payload'::text, null::uuid, null::int, null::uuid; return;
  end if;

  -- Under RLS: a version in another organization is absent, not forbidden.
  select v.* into v_source from crm.requirement_versions v where v.id = p_source_version_id;
  if v_source.id is null then
    return query select 'not_found'::text, null::uuid, null::int, null::uuid; return;
  end if;

  select c.lead_id into v_lead_id from crm.conversations c where c.id = v_source.conversation_id;

  -- The same two roles the UPDATE policy admits (20260810120003): a revision
  -- supersedes, and superseding is a decision.
  if not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text, null::uuid, null::int, v_lead_id; return;
  end if;

  if v_source.status not in ('proposed', 'accepted') then
    return query select 'not_revisable'::text, null::uuid, null::int, v_lead_id; return;
  end if;

  perform pg_advisory_xact_lock(hashtext('crm.requirement_versions:' || v_source.conversation_id::text));

  insert into crm.requirement_versions (
    organization_id, conversation_id, version, source, status, payload, created_by
  )
  select v_source.organization_id,
         v_source.conversation_id,
         coalesce(max(v.version), 0) + 1,
         'human',
         'proposed',
         p_payload,
         v_actor
    from crm.requirement_versions v
   where v.conversation_id = v_source.conversation_id
  returning requirement_versions.id, requirement_versions.version
       into v_id, v_version;

  -- The insert trigger superseded a `proposed` source already; an `accepted`
  -- one is superseded here, through the transition the guard allows.
  update crm.requirement_versions
     set status = 'superseded'
   where id = v_source.id
     and status <> 'superseded';

  perform core.record_audit(
    v_source.organization_id,
    'requirement_version.revised',
    'requirement_version',
    v_id,
    jsonb_build_object(
      'source_version_id', v_source.id,
      'source_version', v_source.version,
      'source_status', v_source.status
    ),
    jsonb_build_object(
      'conversation_id', v_source.conversation_id,
      'version', v_version,
      'status', 'proposed',
      'lead_id', v_lead_id
    )
  );

  return query select 'revised'::text, v_id, v_version, v_lead_id;
end;
$$;

comment on function crm.revise_requirement_version(uuid, jsonb) is
  'SCR-009. Writes the next requirement version from an existing proposed or accepted one with an edited payload, and marks the source superseded — the one transition crm.requirement_versions_guard allows from any state. Nothing is rewritten. Owner or ops_admin, the roles the UPDATE policy admits; SECURITY INVOKER, so RLS decides again. Audited as requirement_version.revised in the same transaction.';

revoke all on function crm.revise_requirement_version(uuid, jsonb) from public, anon;
grant execute on function crm.revise_requirement_version(uuid, jsonb) to authenticated, service_role;

-- ── SCR-017 · an admin attaches what a meeting said to a project's memory ──
--
-- The rule relaxed: ai.memory_records admitted no authenticated write at all
-- (20260821200000 gave it a SELECT policy only). The PDF's Client 360 asks a
-- person to attach a meeting's summary to the project's memory, so owner and
-- ops_admin may now INSERT — and only rows no agent authored, written as
-- themselves. Every structural rule on the table still holds: provenance is
-- required for explicit confidence (the evidence row is the provenance), an
-- agent still cannot write verified, and nothing is ever deleted.

drop policy if exists memory_records_insert_by_admin on ai.memory_records;
create policy memory_records_insert_by_admin on ai.memory_records
  for insert to authenticated
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_admin())
    and authored_by_agent is null
    and created_by = (select auth.uid())
  );

comment on policy memory_records_insert_by_admin on ai.memory_records is
  'SCR-017. Owner or ops_admin may write a memory as themselves — never as an agent. The only person-facing door is ai.attach_meeting_summary_to_memory; the sales handoff handlers keep writing with the service role as before.';

create or replace function ai.attach_meeting_summary_to_memory(
  p_meeting_id uuid,
  p_project_id uuid
)
returns table (
  -- 'attached' | 'already_attached' | 'no_actor' | 'not_found' | 'forbidden'
  -- | 'unknown_project' | 'no_summary'
  outcome   text,
  memory_id uuid,
  lead_id   uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_actor    uuid := (select auth.uid());
  v_meeting  crm.meetings;
  v_project  projects.projects;
  v_evidence crm.meeting_evidence;
  v_existing uuid;
  v_id       uuid;
  v_confidence text;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, null::uuid; return;
  end if;

  select m.* into v_meeting from crm.meetings m where m.id = p_meeting_id;
  if v_meeting.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid; return;
  end if;

  if v_meeting.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text, null::uuid, v_meeting.lead_id; return;
  end if;

  select p.* into v_project
    from projects.projects p
   where p.id = p_project_id
     and p.deleted_at is null
     and p.organization_id = v_meeting.organization_id;
  if v_project.id is null then
    return query select 'unknown_project'::text, null::uuid, v_meeting.lead_id; return;
  end if;

  -- The newest summary with text; failing that, the newest typed notes. A
  -- reference-only evidence row carries nothing a memory could hold.
  select e.* into v_evidence
    from crm.meeting_evidence e
   where e.meeting_id = v_meeting.id
     and e.kind in ('summary', 'notes')
     and length(btrim(coalesce(e.body, ''))) > 0
   order by (e.kind = 'summary') desc, e.uploaded_at desc
   limit 1;
  if v_evidence.id is null then
    return query select 'no_summary'::text, null::uuid, v_meeting.lead_id; return;
  end if;

  -- Idempotent on (project, evidence): attaching twice records once.
  select r.id into v_existing
    from ai.memory_records r
   where r.organization_id = v_meeting.organization_id
     and r.scope = 'project'
     and r.scope_id = v_project.id
     and r.source_kind = 'crm.meeting_evidence'
     and r.source_id = v_evidence.id
     and r.superseded_by is null
   limit 1;
  if v_existing is not null then
    return query select 'already_attached'::text, v_existing, v_meeting.lead_id; return;
  end if;

  -- Notes a person typed are what a person stated; an analysis summary is
  -- what a model inferred, and stays inferred until someone confirms it.
  v_confidence := case when v_evidence.kind = 'notes' then 'explicit' else 'inferred' end;

  insert into ai.memory_records (
    organization_id, scope, scope_id, kind, fact, confidence,
    source_kind, source_id, created_by
  )
  values (
    v_meeting.organization_id, 'project', v_project.id, 'meeting_summary',
    btrim(v_evidence.body), v_confidence,
    'crm.meeting_evidence', v_evidence.id, v_actor
  )
  returning id into v_id;

  perform core.record_audit(
    v_meeting.organization_id,
    'memory.attached_from_meeting',
    'memory_record',
    v_id,
    null,
    jsonb_build_object(
      'meeting_id', v_meeting.id,
      'project_id', v_project.id,
      'evidence_id', v_evidence.id,
      'evidence_kind', v_evidence.kind,
      'confidence', v_confidence,
      'lead_id', v_meeting.lead_id
    )
  );

  return query select 'attached'::text, v_id, v_meeting.lead_id;
end;
$$;

comment on function ai.attach_meeting_summary_to_memory(uuid, uuid) is
  'SCR-017. Files a meeting''s newest summary (or typed notes) as a project-scoped memory record with the evidence row as provenance: explicit when a person typed it, inferred when an analysis produced it. Owner or ops_admin; SECURITY INVOKER, so the INSERT policy decides again. Idempotent per (project, evidence). Audited as memory.attached_from_meeting.';

revoke all on function ai.attach_meeting_summary_to_memory(uuid, uuid) from public, anon;
grant execute on function ai.attach_meeting_summary_to_memory(uuid, uuid) to authenticated, service_role;

-- ── SCR-057/060 · a retry is a new send that remembers what it retried ────

alter table crm.conversation_messages
  add column if not exists retry_of uuid references crm.conversation_messages(id) on delete set null,
  add column if not exists retry_count int not null default 0;

alter table crm.conversation_messages drop constraint if exists conversation_messages_retry_count_is_natural;
alter table crm.conversation_messages
  add constraint conversation_messages_retry_count_is_natural check (retry_count >= 0);

alter table crm.conversation_messages drop constraint if exists conversation_messages_retry_is_not_self;
alter table crm.conversation_messages
  add constraint conversation_messages_retry_is_not_self check (retry_of is null or retry_of <> id);

create index if not exists conversation_messages_retry_of_idx
  on crm.conversation_messages (retry_of)
  where retry_of is not null;

-- A retry belongs to the tenant of the message it retried.
drop trigger if exists org_match_conversation_messages_retry_of on crm.conversation_messages;
create trigger org_match_conversation_messages_retry_of
  before insert or update of retry_of, organization_id on crm.conversation_messages
  for each row execute function core.enforce_parent_org('retry_of', 'crm.conversation_messages');

comment on column crm.conversation_messages.retry_of is
  'SCR-057. The failed outbound message this one re-sent, set by crm.record_delivery_retry after the new send went through crm.send_outbound_message like any other — the window and consent rules decided it, not the retry.';
comment on column crm.conversation_messages.retry_count is
  'SCR-060. How many times a person retried this message. Bumped by crm.record_delivery_retry; the retries themselves are the rows whose retry_of names this one.';

-- Links a retry to the message it retried. The transcript's update guard
-- (20260815340000) admits an authenticated UPDATE only under the sanctioned
-- flag crm.mark_outbound_delivery sets; this is the second sanctioned door,
-- and it touches exactly two columns neither of which is a body or a
-- delivery state.
create or replace function crm.record_delivery_retry(
  p_original_id uuid,
  p_retry_id    uuid
)
returns table (
  -- 'linked' | 'already_linked' | 'no_actor' | 'not_found' | 'forbidden'
  -- | 'not_failed' | 'different_thread' | 'self'
  outcome     text,
  retry_count int
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_actor    uuid := (select auth.uid());
  v_original crm.conversation_messages;
  v_retry    crm.conversation_messages;
  v_count    int;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::int; return;
  end if;
  if p_original_id = p_retry_id then
    return query select 'self'::text, null::int; return;
  end if;

  perform set_config('crm.sanctioned_write', 'on', true);
  perform pg_advisory_xact_lock(hashtext('crm.conversation_messages:retry:' || p_original_id::text));

  select m.* into v_original from crm.conversation_messages m where m.id = p_original_id;
  select m.* into v_retry    from crm.conversation_messages m where m.id = p_retry_id;
  if v_original.id is null or v_retry.id is null then
    return query select 'not_found'::text, null::int; return;
  end if;

  -- The same two roles the sanctioned UPDATE policy admits.
  if v_original.organization_id is distinct from (select core.current_organization_id())
     or (select core.current_user_role()) not in ('owner', 'ops_admin') then
    return query select 'forbidden'::text, null::int; return;
  end if;

  if v_original.metadata->>'direction' is distinct from 'outbound'
     or v_original.metadata->>'delivery' is distinct from 'failed' then
    return query select 'not_failed'::text, v_original.retry_count; return;
  end if;
  if v_retry.conversation_id is distinct from v_original.conversation_id then
    return query select 'different_thread'::text, v_original.retry_count; return;
  end if;

  if v_retry.retry_of is not null then
    return query select 'already_linked'::text, v_original.retry_count; return;
  end if;

  update crm.conversation_messages
     set retry_of = v_original.id
   where id = v_retry.id;

  update crm.conversation_messages
     set retry_count = retry_count + 1
   where id = v_original.id
  returning retry_count into v_count;

  perform core.record_audit(
    v_original.organization_id,
    'message.outbound.retried',
    'conversation_message',
    v_original.id,
    jsonb_build_object('retry_count', v_original.retry_count),
    jsonb_build_object(
      'retry_count', v_count,
      'retry_message_id', v_retry.id,
      'conversation_id', v_original.conversation_id,
      'retry_delivery', v_retry.metadata->>'delivery'
    )
  );

  return query select 'linked'::text, v_count;
end;
$$;

comment on function crm.record_delivery_retry(uuid, uuid) is
  'SCR-057/060. After a person re-sent a failed outbound message through crm.send_outbound_message, links the new row to the one it retried (retry_of) and counts the attempt on the original (retry_count). Owner or ops_admin, the roles the sanctioned UPDATE policy names; SECURITY INVOKER. Idempotent on the retry row. Audited as message.outbound.retried.';

revoke all on function crm.record_delivery_retry(uuid, uuid) from public, anon;
grant execute on function crm.record_delivery_retry(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
