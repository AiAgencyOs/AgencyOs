-- ═══════════════════════════════════════════════════════════════════════════
-- Forty-eight guards that could fail open.
--
-- G-281. `core.current_user_role()` reads the role out of the access token,
-- and a token carrying no role makes it NULL. `core.can_write()`,
-- `core.is_admin()`, `core.is_owner()` and `core.is_internal()` are all
-- `select current_user_role() in (...)`, so each of them is **NULL** for such
-- a caller — and `not NULL` is NULL, which plpgsql's `if` does not execute.
--
-- Every guard written as
--
--     if ... or not (select core.can_write()) then return 'forbidden'; end if;
--
-- therefore **falls through** rather than refusing. Forty-eight functions are
-- written that way. Four were fixed in passing by G-300, G-301 and G-303,
-- because those units were replacing the functions anyway; these are the rest.
--
-- ── it is latent, not live, and the difference is worth stating ───────
--
-- `core.custom_access_token_hook` writes `organization_id` and `role`
-- **together or neither**, so a token with no role also has no organisation,
-- and the organisation comparison that precedes every one of these guards
-- refuses first. Nothing on production is reachable through this today.
--
-- That is exactly why it is worth fixing. The guards depend on an invariant
-- held somewhere else entirely, in a function most readers of a door will
-- never open, and one change to the hook — a new sign-in path, a service
-- token, a half-written membership — would open forty-eight doors at once
-- with no test failing.
--
-- ── this file was GENERATED, and that is the point ───────────────────
--
-- G-303's near-miss was a function rewritten from memory instead of from the
-- file: it dropped a rule, dropped an event, renamed two outcomes and changed
-- the return arity, and all of it would have shipped. Forty-eight functions
-- is forty-eight chances to do that again.
--
-- So nothing here was typed. Each body below is `pg_get_functiondef` read
-- back from a database with every migration applied — the **live** definition,
-- not the newest one that happens to mention the function — with one
-- mechanical substitution applied and counted:
--
--     not (select core.<predicate>())  →  not coalesce((select core.<predicate>()), false)
--
-- Forty-nine matches across forty-eight functions. Forty-eight are guards,
-- one is a comment (see below). The generator asserted, per function, that the rewritten text gains
-- exactly as many `coalesce((select core.` as the pattern matched, so a
-- substitution that silently did nothing would have failed rather than
-- passed. The uppercase keywords and `$function$` tags are Postgres's own
-- rendering, kept rather than reformatted: a formatting pass over generated
-- text is another chance to change something by hand.
--
-- ── the one hand edit, named rather than buried ──────────────────────
--
-- The substitution is textual, so it also rewrote a sentence of PROSE: a
-- comment in `crm.cancel_meeting` explaining why the guard reads
-- `core.can_write()` and not `core.is_internal()`. Turning an explanation
-- into `not coalesce((select core.is_internal()), false)` said something the
-- author did not — and leaving the original wording would have tripped the
-- standing check below, which reads whole bodies. So that line alone was
-- reworded by hand, to `rather than`, and it is called out here because an
-- undisclosed hand edit in a file that claims to be generated is worth more
-- than the edit itself.
--
-- Forty-eight guards, then, and one comment: the forty-ninth match was never
-- a guard.
--
-- **Nothing else moves.** No argument, no return type, no body logic, no
-- refusal, no event. `create or replace` preserves each function's grants and
-- its comment, so the whole ACL surface is untouched.
--
-- ── and the rule gets a standing check ───────────────────────────────
--
-- `core.fail_open_authority_guards()` returns every function whose body still
-- negates one of the four role predicates without coalescing it. A live
-- verification asserts it is empty, so the forty-ninth occurrence fails in CI
-- rather than being found by a second audit a month later.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION approvals.request_approval(p_organization_id uuid, p_subject_type text, p_subject_id uuid, p_requested_by_type text, p_requested_by_id uuid DEFAULT NULL::uuid, p_summary text DEFAULT NULL::text, p_payload jsonb DEFAULT NULL::jsonb, p_amount_minor bigint DEFAULT NULL::bigint, p_audience text DEFAULT NULL::text, p_correlation_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(outcome text, request_id uuid, state text, required_role text, sla_due_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor    uuid := (select auth.uid());
  v_policy   approvals.approval_policies;
  v_existing approvals.approval_requests;
  v_row      approvals.approval_requests;
  v_audience text;
begin
  -- G-084's lesson, one schema along: a caller that HAS an identity is bound
  -- to its own tenant, and only a caller with none — the service role running
  -- a job or an agent — may name an organization freely. Without this, a
  -- signed-in user could raise a request inside somebody else's tenant, which
  -- would then appear in that agency's approval queue.
  if v_actor is not null
     and p_organization_id is distinct from (select core.current_organization_id())
  then
    return query select 'forbidden'::text, null::uuid, null::text, null::text, null::timestamptz;
    return;
  end if;

  -- The approval queue is staff-and-agent territory. A caller that HAS an
  -- identity must be internal — owner/ops_admin/delivery_lead/member/contractor —
  -- to raise a request; the lowest-privilege portal role, client, is refused,
  -- exactly as decide_approval and cancel_request refuse it. A caller with NO
  -- identity (the service role running a job, or an agent) is exempt, as the
  -- tenant gate above is. Without this a client could inject its own text into
  -- the staff queue and its internal WhatsApp announcement, forge a requester
  -- (requested_by_id has no FK), and flood the queue past the one-pending index.
  if v_actor is not null and not coalesce((select core.is_internal()), false) then
    return query select 'forbidden'::text, null::uuid, null::text, null::text, null::timestamptz;
    return;
  end if;

  v_policy := approvals.resolve_policy(p_organization_id, p_subject_type, p_amount_minor);

  -- No policy is not a default-open. Nothing is approved, nothing is raised,
  -- and the caller is told why — the alternative is a request nobody is named
  -- to answer, which is a queue entry that rots.
  if v_policy.id is null then
    return query select 'no_policy'::text, null::uuid, null::text, null::text, null::timestamptz;
    return;
  end if;

  begin
    insert into approvals.approval_requests (
      organization_id, subject_type, subject_id, policy_id, required_role,
      requested_by_type, requested_by_id, audience, summary, payload,
      amount_minor, sla_due_at, correlation_id,
      -- G-110. Allocated here rather than by the announcer, so the code exists
      -- from the moment the request does and a request raised while WhatsApp
      -- is unreachable still has one when it is announced later.
      reference
    )
    values (
      p_organization_id, p_subject_type, p_subject_id, v_policy.id, v_policy.required_role,
      p_requested_by_type, p_requested_by_id, coalesce(p_audience, v_policy.audience),
      p_summary, p_payload, p_amount_minor,
      now() + make_interval(hours => v_policy.sla_hours), p_correlation_id,
      approvals.new_reference()
    )
    returning * into v_row;
  exception
    when unique_violation then
      -- approval_requests_open_subject_key. Two callers raised the same
      -- question at once, or a retry arrived: answer with the request that
      -- exists rather than failing, which is what makes this idempotent for
      -- a webhook or a job that runs twice.
      --
      -- This branch also catches approval_requests_reference_key, and answering
      -- it the same way would be wrong: a code collision is not "the question
      -- was already asked", and the re-read below would find nothing. Retried
      -- once with a fresh code, and only for that constraint.
      if sqlerrm like '%approval_requests_reference_key%' then
        insert into approvals.approval_requests (
          organization_id, subject_type, subject_id, policy_id, required_role,
          requested_by_type, requested_by_id, audience, summary, payload,
          amount_minor, sla_due_at, correlation_id, reference
        )
        values (
          p_organization_id, p_subject_type, p_subject_id, v_policy.id, v_policy.required_role,
          p_requested_by_type, p_requested_by_id, coalesce(p_audience, v_policy.audience),
          p_summary, p_payload, p_amount_minor,
          now() + make_interval(hours => v_policy.sla_hours), p_correlation_id,
          approvals.new_reference()
        )
        returning * into v_row;
      else
        -- Every column is qualified, and that is not style. `state`,
        -- `required_role`, `sla_due_at`, `outcome` and `request_id` are also the
        -- names of this function's OUT parameters, so an unqualified `state`
        -- here is ambiguous and plpgsql refuses it at run time — which is
        -- exactly what the live verification hit, and only on the second raise,
        -- because the first one never reaches this branch.
        select r.* into v_existing
          from approvals.approval_requests r
         where r.organization_id = p_organization_id
           and r.subject_type    = p_subject_type
           and r.subject_id      = p_subject_id
           and r.state           = 'pending';

        return query select 'already_pending'::text, v_existing.id, v_existing.state,
                            v_existing.required_role, v_existing.sla_due_at;
        return;
      end if;
  end;

  perform core.record_audit(
    p_organization_id,
    'approval.requested',
    'approval_request',
    v_row.id,
    null,
    to_jsonb(v_row),
    p_correlation_id
  );

  -- ── G-110: announce it, through the outbox ──────────────────────────────
  --
  -- An event rather than a direct write into crm, for the reason
  -- ARCHITECTURE.md §9.2 gives: this is the one place modules couple, and
  -- approvals reaching into a conversation table would be the coupling §3.2
  -- forbids. It also buys retries and idempotency for free, which matters
  -- because the far end is somebody else's HTTP API.
  --
  -- **Internal audience only.** A client-audience request is the client's
  -- decision, recorded by staff with evidence (ADM-08d); posting it in the
  -- internal group would make that channel the chat log §5.1 says it is not.
  v_audience := coalesce(p_audience, v_policy.audience);

  if v_audience = 'internal' then
    perform core.emit_event(
      p_organization_id,
      'approval.requested',
      'approval_request',
      v_row.id,
      jsonb_build_object(
        'reference',    v_row.reference,
        'subjectType',  v_row.subject_type,
        'subjectId',    v_row.subject_id,
        'summary',      v_row.summary,
        'amountMinor',  v_row.amount_minor,
        'requiredRole', v_row.required_role,
        'slaDueAt',     v_row.sla_due_at
      ),
      p_correlation_id
    );
  end if;

  return query select 'requested'::text, v_row.id, v_row.state, v_row.required_role, v_row.sla_due_at;
end;
$function$;

CREATE OR REPLACE FUNCTION core.set_organization_name(p_organization_id uuid, p_name text)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_was   text;
  v_name  text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if v_actor is not null then
    -- The owner alone: this is the signature on every quotation. Narrower
    -- than the timezone's owner-or-ops on purpose — an ops admin may fix a
    -- clock, not rename the agency.
    if not coalesce((select core.is_owner()), false) then
      return query select 'forbidden'::text; return;
    end if;
    if p_organization_id is distinct from (select core.current_organization_id()) then
      return query select 'forbidden'::text; return;
    end if;
  end if;

  -- The same bound the column's own CHECK holds (non-empty), plus a ceiling
  -- a letterhead can actually wear.
  if v_name is null or length(v_name) > 120 then
    return query select 'invalid'::text; return;
  end if;

  select o.name into v_was
    from core.organizations o
   where o.id = p_organization_id
   for update;
  if not found then
    return query select 'not_found'::text; return;
  end if;

  perform set_config('crm.name_write', 'on', true);
  update core.organizations set name = v_name where id = p_organization_id;

  perform core.record_audit(
    p_organization_id,
    'organization.renamed',
    'organization',
    p_organization_id,
    jsonb_build_object('name', v_was),
    jsonb_build_object('name', v_name)
  );

  return query select 'set'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION core.set_wake_runner_on_inbound(p_organization_id uuid, p_enabled boolean)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_before boolean;
begin
  if v_actor is not null and not coalesce((select core.is_owner()), false) then
    return query select 'forbidden'::text; return;
  end if;

  select o.wake_runner_on_inbound into v_before
    from core.organizations o where o.id = p_organization_id;

  if v_before is null then
    return query select 'not_found'::text; return;
  end if;

  update core.organizations
     set wake_runner_on_inbound = p_enabled
   where id = p_organization_id;

  perform core.record_audit(
    p_organization_id,
    case when p_enabled then 'runner.wake_on_inbound_enabled' else 'runner.wake_on_inbound_disabled' end,
    'organization', p_organization_id,
    jsonb_build_object('wake_runner_on_inbound', v_before),
    jsonb_build_object('wake_runner_on_inbound', p_enabled),
    null
  );

  return query select case when p_enabled then 'enabled' else 'disabled' end::text;
end;
$function$;

CREATE OR REPLACE FUNCTION crm.add_meeting_evidence(p_meeting_id uuid, p_kind text, p_body text DEFAULT NULL::text, p_visibility text DEFAULT 'internal'::text, p_artifact_ref text DEFAULT NULL::text, p_media_type text DEFAULT NULL::text, p_byte_size bigint DEFAULT NULL::bigint)
 RETURNS TABLE(outcome text, evidence_id uuid, lead_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_row   crm.meetings;
  v_body  text := nullif(btrim(coalesce(p_body, '')), '');
  v_ref   text := nullif(btrim(coalesce(p_artifact_ref, '')), '');
  v_id    uuid;
begin
  select m.* into v_row from crm.meetings m where m.id = p_meeting_id;
  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_row.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid, null::uuid; return;
  end if;

  -- uploaded_by references core.users; a token whose subject has no row
  -- would fail the write with a foreign-key error. Named instead (review).
  if v_actor is not null and not exists (select 1 from core.users u where u.id = v_actor) then
    return query select 'unknown_actor'::text, null::uuid, v_row.lead_id; return;
  end if;

  -- §9.2's list, the table's CHECK said by name before it is hit.
  if p_kind is null or p_kind not in ('recording', 'transcript', 'image', 'chat_export', 'document', 'notes', 'summary') then
    return query select 'invalid_kind'::text, null::uuid, v_row.lead_id; return;
  end if;
  if p_visibility is null or p_visibility not in ('internal', 'client_visible') then
    return query select 'invalid_visibility'::text, null::uuid, v_row.lead_id; return;
  end if;
  -- meeting_evidence_carries_something, by name: a row with neither a
  -- reference nor a body is a claim that evidence exists.
  if v_body is null and v_ref is null then
    return query select 'nothing_to_attach'::text, null::uuid, v_row.lead_id; return;
  end if;
  if length(coalesce(p_body, '')) > 20000 then
    return query select 'too_long'::text, null::uuid, v_row.lead_id; return;
  end if;
  if p_byte_size is not null and p_byte_size <= 0 then
    return query select 'invalid_size'::text, null::uuid, v_row.lead_id; return;
  end if;

  insert into crm.meeting_evidence
    (organization_id, meeting_id, lead_id, kind, visibility, artifact_ref, body, media_type, byte_size, uploaded_by)
  values
    (v_row.organization_id, v_row.id, v_row.lead_id, p_kind, p_visibility, v_ref, v_body,
     nullif(btrim(coalesce(p_media_type, '')), ''), p_byte_size, v_actor)
  returning id into v_id;

  perform core.record_audit(
    v_row.organization_id,
    'meeting.evidence_added',
    'meeting',
    v_row.id,
    null,
    jsonb_build_object(
      'evidence_id', v_id,
      'kind', p_kind,
      'visibility', p_visibility,
      'has_reference', v_ref is not null,
      'has_body', v_body is not null,
      'lead_id', v_row.lead_id
    )
  );

  return query select 'attached'::text, v_id, v_row.lead_id;
end;
$function$;

CREATE OR REPLACE FUNCTION crm.cancel_meeting(p_meeting_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, meeting_id uuid, lead_id uuid, provider_event_id text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor  uuid := (select auth.uid());
  v_row    crm.meetings;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select m.* into v_row from crm.meetings m where m.id = p_meeting_id for update;
  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid, null::text; return;
  end if;

  -- Definer means RLS did not filter that read: an authenticated caller must
  -- own the row and hold the write the row policy (meetings_write) demands —
  -- core.can_write() rather than core.is_internal(), because review found the first
  -- draft admitting a contractor the row itself refuses. The service role is
  -- the Scheduler agent acting on a client's request, and is trusted.
  if v_actor is not null
     and (v_row.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid, null::uuid, null::text; return;
  end if;

  if v_row.status = 'cancelled' then
    return query select 'already_cancelled'::text, v_row.id, v_row.lead_id, v_row.provider_event_id; return;
  end if;
  -- §9.1: a meeting that happened, or was missed, does not un-happen.
  if v_row.status in ('completed', 'no_show') then
    return query select 'wrong_state'::text, v_row.id, v_row.lead_id, v_row.provider_event_id; return;
  end if;

  -- History is not deleted (§8): the agreed time, the booking key and the
  -- provider event stay on the row; only the status and the cancellation
  -- facts change. meetings_drop_stale_reminders removes the queued reminder.
  update crm.meetings
     set status              = 'cancelled',
         outcome             = 'cancelled',
         cancelled_at        = clock_timestamp(),
         cancellation_reason = v_reason
   where crm.meetings.id = v_row.id;

  perform core.record_audit(
    v_row.organization_id,
    'meeting.cancelled',
    'meeting',
    v_row.id,
    jsonb_build_object('status', v_row.status, 'confirmed_start_at', v_row.confirmed_start_at),
    jsonb_build_object(
      'status', 'cancelled',
      'reason', v_reason,
      'lead_id', v_row.lead_id,
      'provider_event_id', v_row.provider_event_id,
      -- Said in the record rather than implied: nothing cancelled it there.
      'provider_event_cancelled', false
    )
  );

  return query select 'cancelled'::text, v_row.id, v_row.lead_id, v_row.provider_event_id;
end;
$function$;

CREATE OR REPLACE FUNCTION crm.clear_third_party_charge(p_organization_id uuid, p_service text)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
begin
  if (select auth.uid()) is not null and not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text; return;
  end if;

  select c.id into v_id
    from crm.third_party_charges c
   where c.organization_id = p_organization_id
     and lower(btrim(c.service)) = lower(btrim(p_service))
     and c.active;

  if v_id is null then
    return query select 'no_charge'::text; return;
  end if;

  -- Retired rather than deleted, so a quotation already sent still points at
  -- something. The same reason `crm.portfolio_items.is_active` exists.
  perform set_config('crm.charge_write', 'on', true);
  update crm.third_party_charges set active = false where id = v_id;

  perform core.record_audit(
    p_organization_id, 'third_party_charge.withdrawn', 'third_party_charge', v_id,
    jsonb_build_object('service', btrim(p_service)), null, null
  );

  return query select 'cleared'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION crm.clear_whatsapp_template(p_organization_id uuid, p_situation_key text, p_language_code text DEFAULT NULL::text)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
begin
  if (select auth.uid()) is not null and not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text; return;
  end if;

  select t.id into v_id from crm.whatsapp_templates t
   where t.organization_id = p_organization_id
     and t.situation_key = p_situation_key
     -- EDIT (G-217): a null language withdraws the only one, which is what an
     -- Admin who has registered one language means. With two registered it
     -- withdraws nothing rather than guessing which — an unasked question is
     -- better than a wrong answer about what a client will receive.
     and (p_language_code is null or lower(t.language_code) = lower(btrim(p_language_code)))
     and t.active;

  if v_id is null then
    return query select 'no_template'::text; return;
  end if;

  -- Deactivated, never deleted: which template a past send used is part of
  -- the record of what this agency said.
  update crm.whatsapp_templates set active = false where id = v_id;

  perform core.record_audit(
    p_organization_id, 'whatsapp_template.withdrawn', 'whatsapp_template', v_id,
    jsonb_build_object('situation', p_situation_key, 'language', p_language_code), null, null
  );

  return query select 'cleared'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION crm.complete_meeting(p_meeting_id uuid, p_outcome text DEFAULT 'completed'::text, p_note text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, meeting_id uuid, lead_id uuid, evidence_id uuid, analysis text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor    uuid := (select auth.uid());
  v_row      crm.meetings;
  v_evidence uuid;
  v_filed    text;
  v_analysis text;
begin
  -- §9.1: an authorized PERSON marks it. The worker has no auth.uid(), and a
  -- meeting completed by nobody is the inference the specification forbids.
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, null::uuid, null::uuid, null::text; return;
  end if;
  -- Argument-only refusals before the lock: their answer cannot change
  -- while the row is locked, and a mistyped form should not wait behind
  -- another operator's completion (review).
  if p_outcome is null or p_outcome not in ('completed', 'failed', 'follow_up_required') then
    return query select 'invalid_outcome'::text, null::uuid, null::uuid, null::uuid, null::text; return;
  end if;
  if length(coalesce(p_note, '')) > 20000 then
    return query select 'note_too_long'::text, null::uuid, null::uuid, null::uuid, null::text; return;
  end if;
  select m.* into v_row from crm.meetings m where m.id = p_meeting_id for update;
  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid, null::uuid, null::uuid, null::text; return;
  end if;

  -- completed_by references core.users. A token whose subject has no row
  -- would fail the write with a foreign-key error; named instead — after
  -- the tenancy guard, so a stranger is a stranger before anything else.
  if not exists (select 1 from core.users u where u.id = v_actor) then
    return query select 'unknown_actor'::text, v_row.id, v_row.lead_id, null::uuid, null::text; return;
  end if;

  if v_row.status = 'completed' then
    return query select 'already_completed'::text, v_row.id, v_row.lead_id, null::uuid, null::text; return;
  end if;
  -- §9: only a booked meeting can have happened.
  if v_row.status <> 'booked' then
    return query select 'wrong_state'::text, v_row.id, v_row.lead_id, null::uuid, null::text; return;
  end if;
  -- Also held at the row by meetings_conclude_after_start; answered here by name.
  if v_row.confirmed_start_at is not null and clock_timestamp() < v_row.confirmed_start_at then
    return query select 'not_yet_started'::text, v_row.id, v_row.lead_id, null::uuid, null::text; return;
  end if;

  update crm.meetings
     set status       = 'completed',
         outcome      = p_outcome,
         completed_at = clock_timestamp(),
         completed_by = v_actor
   where crm.meetings.id = v_row.id;

  -- The note goes through the evidence door: one insert path, one audit.
  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    select e.outcome, e.evidence_id into v_filed, v_evidence
      from crm.add_meeting_evidence(v_row.id, 'notes', p_note, 'internal') e;
    if v_filed is distinct from 'attached' then
      raise exception 'meeting_note: the evidence door answered %', v_filed;
    end if;
  end if;

  -- §9.3: MARK COMPLETED → VALIDATE EVIDENCE → LINK ARTIFACTS → CREATE AI
  -- ANALYSIS TASK. The gate is the existing one, and its refusal
  -- ('no_evidence') is returned, not swallowed.
  select a.outcome into v_analysis from crm.request_meeting_analysis(v_row.id) a;

  perform core.record_audit(
    v_row.organization_id,
    'meeting.completed',
    'meeting',
    v_row.id,
    jsonb_build_object('status', v_row.status, 'confirmed_start_at', v_row.confirmed_start_at),
    jsonb_build_object(
      'status', 'completed',
      'outcome', p_outcome,
      'completed_by', v_actor,
      'lead_id', v_row.lead_id,
      'evidence_id', v_evidence,
      'analysis', v_analysis
    )
  );

  return query select 'completed'::text, v_row.id, v_row.lead_id, v_evidence, v_analysis;
end;
$function$;

CREATE OR REPLACE FUNCTION crm.link_internal_recipient(p_organization_id uuid, p_phone text, p_title text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, conversation_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  if (select auth.uid()) is not null and not coalesce((select core.is_owner()), false) then
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
$function$;

CREATE OR REPLACE FUNCTION crm.note_availability_read(p_meeting_id uuid, p_availability_source text, p_availability_read_at timestamp with time zone)
 RETURNS TABLE(outcome text, meeting_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_row   crm.meetings;
begin
  select m.* into v_row from crm.meetings m where m.id = p_meeting_id for update;
  if v_row.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if v_actor is not null
     and (v_row.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if v_row.status not in ('requested', 'proposed') then
    return query select 'wrong_state'::text, v_row.id; return;
  end if;
  if nullif(btrim(coalesce(p_availability_source, '')), '') is null or p_availability_read_at is null then
    return query select 'never_checked'::text, v_row.id; return;
  end if;
  -- The moment cannot be from the future: a caller claiming a read it has
  -- not made yet is the thing the freshness bound exists to refuse.
  if p_availability_read_at > clock_timestamp() + interval '1 minute' then
    return query select 'never_checked'::text, v_row.id; return;
  end if;

  update crm.meetings
     set availability_source  = p_availability_source,
         availability_read_at = p_availability_read_at
   where crm.meetings.id = v_row.id;

  return query select 'noted'::text, v_row.id;
end;
$function$;

CREATE OR REPLACE FUNCTION crm.propose_meeting_slots(p_meeting_id uuid, p_slots jsonb, p_availability_source text, p_availability_read_at timestamp with time zone, p_duration_minutes integer)
 RETURNS TABLE(outcome text, meeting_id uuid, lead_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_row   crm.meetings;
  v_slot  jsonb;
  v_start timestamptz;
  v_end   timestamptz;
begin
  select m.* into v_row from crm.meetings m where m.id = p_meeting_id for update;
  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid; return;
  end if;
  if v_actor is not null
     and (v_row.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid, null::uuid; return;
  end if;

  -- §6.2: a proposal is made to a request, or re-made after "none of those
  -- work"; a booked or concluded meeting is not offered times.
  if v_row.status not in ('requested', 'proposed') then
    return query select 'wrong_state'::text, v_row.id, v_row.lead_id; return;
  end if;
  -- §5: what is offered was READ. No source, no moment, no offer.
  if nullif(btrim(coalesce(p_availability_source, '')), '') is null or p_availability_read_at is null then
    return query select 'never_checked'::text, v_row.id, v_row.lead_id; return;
  end if;
  if p_duration_minutes is null or p_duration_minutes < 5 or p_duration_minutes > 480 then
    return query select 'invalid_duration'::text, v_row.id, v_row.lead_id; return;
  end if;
  if p_slots is null or jsonb_typeof(p_slots) <> 'array' then
    return query select 'invalid_slots'::text, v_row.id, v_row.lead_id; return;
  end if;
  if jsonb_array_length(p_slots) = 0 then
    -- §5.3: a full calendar is an answer, and it is not this door's to hide.
    return query select 'nothing_to_offer'::text, v_row.id, v_row.lead_id; return;
  end if;
  if jsonb_array_length(p_slots) > 3 then
    return query select 'invalid_slots'::text, v_row.id, v_row.lead_id; return;
  end if;
  -- Each slot is a real instant pair that ends after it starts and is at
  -- least as long as the meeting; anything else is not a slot.
  for v_slot in select * from jsonb_array_elements(p_slots) loop
    begin
      v_start := (v_slot->>'startAt')::timestamptz;
      v_end   := (v_slot->>'endAt')::timestamptz;
    exception when others then
      return query select 'invalid_slots'::text, v_row.id, v_row.lead_id; return;
    end;
    if v_start is null or v_end is null or v_end <= v_start
       or v_end - v_start < make_interval(mins => p_duration_minutes) then
      return query select 'invalid_slots'::text, v_row.id, v_row.lead_id; return;
    end if;
  end loop;

  update crm.meetings
     set status               = 'proposed',
         proposed_slots       = p_slots,
         availability_source  = p_availability_source,
         availability_read_at = p_availability_read_at,
         duration_minutes     = p_duration_minutes
   where crm.meetings.id = v_row.id;

  perform core.record_audit(
    v_row.organization_id,
    'meeting.proposed',
    'meeting',
    v_row.id,
    jsonb_build_object('status', v_row.status, 'proposed_slots', v_row.proposed_slots),
    jsonb_build_object(
      'status', 'proposed',
      'slots', p_slots,
      'availability_source', p_availability_source,
      'availability_read_at', p_availability_read_at,
      'duration_minutes', p_duration_minutes,
      'lead_id', v_row.lead_id
    )
  );

  return query select 'proposed'::text, v_row.id, v_row.lead_id;
end;
$function$;

CREATE OR REPLACE FUNCTION crm.record_no_show(p_meeting_id uuid, p_note text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, meeting_id uuid, lead_id uuid, evidence_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor    uuid := (select auth.uid());
  v_row      crm.meetings;
  v_evidence uuid;
  v_filed    text;
  -- [ADM-103 edit 1 of 2] the sequence this no-show starts, and whether it is
  -- new. A second no-show on the same meeting cannot happen (already_recorded
  -- refuses it), so `created` false here means a sequence was started by
  -- something else for this meeting — reported rather than hidden.
  v_sequence uuid;
  v_created  boolean;
  v_triggered timestamptz;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, null::uuid, null::uuid; return;
  end if;
  if length(coalesce(p_note, '')) > 20000 then
    return query select 'note_too_long'::text, null::uuid, null::uuid, null::uuid; return;
  end if;
  select m.* into v_row from crm.meetings m where m.id = p_meeting_id for update;
  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid, null::uuid, null::uuid; return;
  end if;

  if not exists (select 1 from core.users u where u.id = v_actor) then
    return query select 'unknown_actor'::text, v_row.id, v_row.lead_id, null::uuid; return;
  end if;

  if v_row.status = 'no_show' then
    return query select 'already_recorded'::text, v_row.id, v_row.lead_id, null::uuid; return;
  end if;
  if v_row.status <> 'booked' then
    return query select 'wrong_state'::text, v_row.id, v_row.lead_id, null::uuid; return;
  end if;
  -- §8: "Do not infer completion from time alone" - and the other direction:
  -- nobody has failed to attend a meeting that has not begun. Also at the row.
  if v_row.confirmed_start_at is not null and clock_timestamp() < v_row.confirmed_start_at then
    return query select 'not_yet_started'::text, v_row.id, v_row.lead_id, null::uuid; return;
  end if;

  -- completed_at / completed_by carry the MARKING's actor and moment: the
  -- constraint meetings_completion_is_authorized demands them for no_show
  -- precisely so that a no-show is somebody's statement.
  update crm.meetings
     set status       = 'no_show',
         outcome      = 'no_show',
         completed_at = clock_timestamp(),
         completed_by = v_actor
   where crm.meetings.id = v_row.id;

  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    select e.outcome, e.evidence_id into v_filed, v_evidence
      from crm.add_meeting_evidence(v_row.id, 'notes', p_note, 'internal') e;
    if v_filed is distinct from 'attached' then
      raise exception 'meeting_note: the evidence door answered %', v_filed;
    end if;
  end if;

  -- [ADM-103 edit 2 of 2] §8's follow-up, now that a situation carries it.
  -- Triggered at the AGREED START, so the cadence is measured from the
  -- meeting the client missed rather than from the moment somebody got round
  -- to recording it. The conversation and contact are carried through so the
  -- consent chokepoint has something to check; a meeting with neither still
  -- starts a sequence, and the worker stops it by name rather than sending
  -- into nothing.
  -- One reading of the trigger moment, used by both the sequence and the
  -- audit row: two calls to clock_timestamp() differ by microseconds, and a
  -- record that disagrees with the thing it records is worth avoiding.
  v_triggered := coalesce(v_row.confirmed_start_at, clock_timestamp());

  -- A follow-up is a MESSAGE, and a message needs a thread. A meeting with no
  -- conversation has nowhere to send one, so no sequence is started and the
  -- audit row says why. Starting one anyway would write a row the worker must
  -- stop on its next tick, and the audit would have claimed a follow-up that
  -- was never going to happen. Review of ADM-103 found that claim.
  if v_row.conversation_id is not null then
    select s.sequence_id, s.created into v_sequence, v_created
      from crm.start_follow_up_sequence(
        v_row.organization_id,
        'missed_meeting',
        'meeting',
        v_row.id,
        v_triggered,
        v_row.conversation_id,
        v_row.contact_id
      ) s;
  end if;

  perform core.record_audit(
    v_row.organization_id,
    'meeting.no_show',
    'meeting',
    v_row.id,
    jsonb_build_object('status', v_row.status, 'confirmed_start_at', v_row.confirmed_start_at),
    jsonb_build_object(
      'status', 'no_show',
      'recorded_by', v_actor,
      'lead_id', v_row.lead_id,
      'evidence_id', v_evidence,
      -- [ADM-103 edit 2 of 2, continued] where the sentence saying the
      -- decision was still open used to be. The sequence id is recorded so
      -- the follow-up can be found from the no-show, and `started_here` says
      -- whether this call started it.
      'follow_up', case
        when v_row.conversation_id is null then
          jsonb_build_object('situation', 'missed_meeting', 'started', false, 'reason', 'no_conversation')
        else
          jsonb_build_object(
            'situation', 'missed_meeting',
            'sequence_id', v_sequence,
            'started_here', v_created,
            'triggered_at', v_triggered
          )
      end
    )
  );

  return query select 'no_show'::text, v_row.id, v_row.lead_id, v_evidence;
end;
$function$;

CREATE OR REPLACE FUNCTION crm.request_meeting(p_lead_id uuid, p_mode text, p_timezone text, p_purpose text DEFAULT NULL::text, p_conversation_id uuid DEFAULT NULL::uuid, p_requested_message_id uuid DEFAULT NULL::uuid, p_contact_id uuid DEFAULT NULL::uuid, p_opportunity_id uuid DEFAULT NULL::uuid, p_requested_start_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_requested_window_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_duration_minutes integer DEFAULT NULL::integer)
 RETURNS TABLE(outcome text, meeting_id uuid, lead_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_lead  crm.leads;
  v_open  uuid;
  v_new   uuid;
  v_zone  text := btrim(coalesce(p_timezone, ''));
begin
  -- §9.1's shape, as every other door has it: a request is somebody's
  -- statement that a client asked. The service role is admitted because the
  -- Scheduler agent records a request the client made in a thread it was
  -- reading — the same reason cancel admits it and completion does not.
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid, null::uuid; return;
  end if;

  -- ── argument-only refusals, before any row is locked ──────────────────
  if p_mode is null or p_mode not in ('call', 'video_meeting', 'in_person_meeting', 'other') then
    return query select 'invalid_request'::text, null::uuid, null::uuid; return;
  end if;
  if not (select core.is_known_timezone(v_zone)) then
    return query select 'invalid_timezone'::text, null::uuid, null::uuid; return;
  end if;
  -- Stored in the CANONICAL spelling, not the caller's. `is_known_timezone`
  -- compares case-insensitively, so `asia/kolkata` passes and would then be
  -- printed to a person exactly like that on every meeting page. The name is
  -- read back from the same catalogue the predicate consulted.
  select z.name into v_zone
    from pg_catalog.pg_timezone_names z
   where lower(z.name) = lower(v_zone)
   limit 1;
  if p_duration_minutes is not null and p_duration_minutes <= 0 then
    return query select 'invalid_request'::text, null::uuid, null::uuid; return;
  end if;
  -- §4.1: a window without a start is not a window, and one that ends before
  -- it begins is not a time. The row's own CHECK says so too; refusing by name
  -- here means a caller is told which argument was wrong.
  if p_requested_window_end is not null
     and (p_requested_start_at is null or p_requested_window_end < p_requested_start_at) then
    return query select 'invalid_request'::text, null::uuid, null::uuid; return;
  end if;
  if length(coalesce(p_purpose, '')) > 2000 then
    return query select 'invalid_request'::text, null::uuid, null::uuid; return;
  end if;

  -- [G-249 review edit 1 of 1] `for update`. The lead row is the lock that
  -- makes "one live meeting per lead" true under concurrency: two jobs from
  -- two messages by the same client, claimed by two overlapping runner
  -- invocations, both read no-live-meeting and both insert without it.
  select l.* into v_lead from crm.leads l where l.id = p_lead_id for update;
  if v_lead.id is null then
    return query select 'unknown_lead'::text, null::uuid, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_lead.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid, v_lead.id; return;
  end if;

  if v_actor is not null and not exists (select 1 from core.users u where u.id = v_actor) then
    return query select 'unknown_actor'::text, null::uuid, v_lead.id; return;
  end if;

  -- The thread, the message and the contact must belong to this tenant, and
  -- the message to the thread. A foreign key alone would admit another
  -- organization's row and another conversation's message.
  if p_conversation_id is not null and not exists (
       select 1 from crm.conversations c
        where c.id = p_conversation_id and c.organization_id = v_lead.organization_id) then
    return query select 'unknown_thread'::text, null::uuid, v_lead.id; return;
  end if;
  if p_requested_message_id is not null and not exists (
       select 1 from crm.conversation_messages m
        where m.id = p_requested_message_id
          and m.organization_id = v_lead.organization_id
          and (p_conversation_id is null or m.conversation_id = p_conversation_id)) then
    return query select 'unknown_message'::text, null::uuid, v_lead.id; return;
  end if;
  if p_contact_id is not null and not exists (
       select 1 from crm.contacts ct
        where ct.id = p_contact_id and ct.organization_id = v_lead.organization_id) then
    return query select 'invalid_request'::text, null::uuid, v_lead.id; return;
  end if;
  if p_opportunity_id is not null and not exists (
       select 1 from sales.opportunities o
        where o.id = p_opportunity_id and o.organization_id = v_lead.organization_id) then
    return query select 'invalid_request'::text, null::uuid, v_lead.id; return;
  end if;

  -- ── one live request per lead ─────────────────────────────────────────
  select m.id into v_open
    from crm.meetings m
   where m.lead_id = v_lead.id
     and m.organization_id = v_lead.organization_id
     and m.status in ('requested', 'proposed', 'booked')
   order by m.created_at
   limit 1;
  if v_open is not null then
    return query select 'already_requested'::text, v_open, v_lead.id; return;
  end if;

  insert into crm.meetings (
    organization_id, lead_id, contact_id, opportunity_id, conversation_id, requested_message_id,
    requested_mode, requested_start_at, requested_window_end,
    timezone, duration_minutes, purpose, created_by, status
  ) values (
    v_lead.organization_id, v_lead.id, p_contact_id, p_opportunity_id, p_conversation_id, p_requested_message_id,
    p_mode, p_requested_start_at, p_requested_window_end,
    v_zone, p_duration_minutes, nullif(btrim(coalesce(p_purpose, '')), ''), v_actor, 'requested'
  )
  returning id into v_new;

  perform core.record_audit(
    v_lead.organization_id,
    'meeting.requested',
    'meeting',
    v_new,
    null::jsonb,
    jsonb_build_object(
      'status', 'requested',
      'lead_id', v_lead.id,
      'mode', p_mode,
      'timezone', v_zone,
      -- What the client named, kept apart from anything agreed (§4.1).
      'requested_start_at', p_requested_start_at,
      'requested_window_end', p_requested_window_end,
      'conversation_id', p_conversation_id,
      'requested_message_id', p_requested_message_id,
      'recorded_by', v_actor
    )
  );

  return query select 'requested'::text, v_new, v_lead.id;
end;
$function$;

CREATE OR REPLACE FUNCTION crm.reschedule_meeting(p_meeting_id uuid, p_reason text DEFAULT NULL::text, p_requested_start_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_requested_window_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_requested_mode text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, meeting_id uuid, new_meeting_id uuid, lead_id uuid, provider_event_id text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor  uuid := (select auth.uid());
  v_row    crm.meetings;
  v_new    uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_mode   text := coalesce(nullif(btrim(coalesce(p_requested_mode, '')), ''), null);
begin
  select m.* into v_row from crm.meetings m where m.id = p_meeting_id for update;
  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::text; return;
  end if;
  -- The service role is the Scheduler agent acting on a client's request;
  -- an authenticated caller needs the row policy's own write.
  if v_actor is not null
     and (v_row.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid, null::uuid, null::uuid, null::text; return;
  end if;
  -- §8 "identify current booking": only a booking is rescheduled. A request
  -- or a proposal is re-offered through the offer door; a concluded meeting
  -- is history.
  if v_row.status <> 'booked' then
    return query select 'wrong_state'::text, v_row.id, null::uuid, v_row.lead_id, v_row.provider_event_id; return;
  end if;
  if v_mode is not null and v_mode not in ('call', 'video_meeting', 'in_person_meeting', 'other') then
    return query select 'invalid_request'::text, v_row.id, null::uuid, v_row.lead_id, v_row.provider_event_id; return;
  end if;
  if p_requested_window_end is not null and (p_requested_start_at is null or p_requested_window_end < p_requested_start_at) then
    return query select 'invalid_request'::text, v_row.id, null::uuid, v_row.lead_id, v_row.provider_event_id; return;
  end if;
  -- created_by references core.users: a token whose subject has no row is
  -- named, not a foreign-key error after the old row was already cancelled.
  if v_actor is not null and not exists (select 1 from core.users u where u.id = v_actor) then
    return query select 'unknown_actor'::text, v_row.id, null::uuid, v_row.lead_id, v_row.provider_event_id; return;
  end if;

  -- The old booking, kept: cancelled with the reason, every other column as
  -- it was. meetings_drop_stale_reminders drops its queued reminder.
  update crm.meetings
     set status              = 'cancelled',
         outcome             = 'cancelled',
         cancelled_at        = clock_timestamp(),
         cancellation_reason = left('rescheduled' || coalesce(': ' || v_reason, ''), 2000)
   where crm.meetings.id = v_row.id;

  -- The new request, carrying what identifies the meeting. `requested_mode`
  -- is what the client now asks for, else what was booked, else what was
  -- first asked. `timezone` and `duration_minutes` are carried so the offer
  -- can be made in the same terms; `created_by` is the person who did this.
  insert into crm.meetings (
    organization_id, lead_id, contact_id, opportunity_id, conversation_id, requested_message_id,
    requested_mode, requested_start_at, requested_window_end,
    timezone, duration_minutes, purpose, created_by, supersedes_id, status
  ) values (
    v_row.organization_id, v_row.lead_id, v_row.contact_id, v_row.opportunity_id, v_row.conversation_id, v_row.requested_message_id,
    coalesce(v_mode, v_row.booked_mode, v_row.requested_mode), p_requested_start_at, p_requested_window_end,
    v_row.timezone, v_row.duration_minutes, v_row.purpose, v_actor, v_row.id, 'requested'
  )
  returning id into v_new;

  perform core.record_audit(
    v_row.organization_id,
    'meeting.rescheduled',
    'meeting',
    v_row.id,
    jsonb_build_object('status', v_row.status, 'confirmed_start_at', v_row.confirmed_start_at, 'confirmed_end_at', v_row.confirmed_end_at),
    jsonb_build_object(
      'status', 'cancelled',
      'reason', v_reason,
      'new_meeting_id', v_new,
      'requested_start_at', p_requested_start_at,
      'requested_window_end', p_requested_window_end,
      'lead_id', v_row.lead_id,
      'provider_event_id', v_row.provider_event_id,
      'provider_event_cancelled', false
    )
  );

  return query select 'rescheduled'::text, v_row.id, v_new, v_row.lead_id, v_row.provider_event_id;
end;
$function$;

CREATE OR REPLACE FUNCTION crm.set_third_party_charge(p_organization_id uuid, p_service text, p_charge text, p_source text DEFAULT NULL::text, p_checked_on date DEFAULT NULL::date)
 RETURNS TABLE(outcome text, charge_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_id    uuid;
  v_when  date := coalesce(p_checked_on, current_date);
begin
  if v_actor is not null and not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text, null::uuid;
    return;
  end if;

  if coalesce(btrim(p_service), '') = '' or coalesce(btrim(p_charge), '') = '' then
    return query select 'incomplete'::text, null::uuid;
    return;
  end if;

  -- A date in the future is somebody confirming a fee they have not seen yet,
  -- which is the one input that makes the staleness warning lie.
  if v_when > current_date then
    return query select 'not_yet'::text, null::uuid;
    return;
  end if;

  perform set_config('crm.charge_write', 'on', true);

  select c.id into v_id
    from crm.third_party_charges c
   where c.organization_id = p_organization_id
     and lower(btrim(c.service)) = lower(btrim(p_service));

  if v_id is null then
    insert into crm.third_party_charges (
      organization_id, service, charge, source, checked_on, created_by
    )
    values (p_organization_id, btrim(p_service), btrim(p_charge), nullif(btrim(p_source), ''), v_when, v_actor)
    returning crm.third_party_charges.id into v_id;
  else
    update crm.third_party_charges c
       set charge = btrim(p_charge),
           source = nullif(btrim(p_source), ''),
           checked_on = v_when,
           active = true
     where c.id = v_id;
  end if;

  perform core.record_audit(
    p_organization_id, 'third_party_charge.set', 'third_party_charge', v_id,
    null,
    jsonb_build_object('service', btrim(p_service), 'charge', btrim(p_charge), 'checkedOn', v_when),
    null
  );

  return query select 'set'::text, v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION crm.set_whatsapp_template(p_organization_id uuid, p_situation_key text, p_template_name text, p_language_code text, p_parameters text[] DEFAULT '{}'::text[])
 RETURNS TABLE(outcome text, template_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_id    uuid;
begin
  if v_actor is not null and not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if coalesce(btrim(p_template_name), '') = '' or coalesce(btrim(p_language_code), '') = '' then
    return query select 'incomplete'::text, null::uuid; return;
  end if;

  select t.id into v_id
    from crm.whatsapp_templates t
   where t.organization_id = p_organization_id
     and t.situation_key = p_situation_key
     -- EDIT (G-217): and the LANGUAGE. Without it, registering the Hindi
     -- template for a situation overwrote the English one, which is the
     -- opposite of what the person doing it intended.
     and lower(t.language_code) = lower(btrim(p_language_code))
     and t.active;

  if v_id is null then
    insert into crm.whatsapp_templates (
      organization_id, situation_key, template_name, language_code, parameters, created_by
    )
    values (p_organization_id, p_situation_key, btrim(p_template_name), btrim(p_language_code),
            coalesce(p_parameters, '{}'::text[]), v_actor)
    returning crm.whatsapp_templates.id into v_id;
  else
    update crm.whatsapp_templates t
       set template_name = btrim(p_template_name),
           parameters = coalesce(p_parameters, '{}'::text[]),
           -- Re-registering is how an Admin says Meta approved it again after
           -- a rejection, so it comes back approved rather than staying dead.
           status = 'approved'
     where t.id = v_id;
  end if;

  perform core.record_audit(
    p_organization_id, 'whatsapp_template.set', 'whatsapp_template', v_id,
    jsonb_build_object(
      'situation_key', p_situation_key,
      'template_name', btrim(p_template_name),
      'language_code', btrim(p_language_code)
    ), null, null
  );

  return query select 'set'::text, v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION crm.set_whatsapp_template_status(p_organization_id uuid, p_situation_key text, p_status text)
 RETURNS TABLE(outcome text, template_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_id    uuid;
begin
  if v_actor is not null and not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if p_status not in ('draft','submitted','approved','rejected','paused','disabled','archived') then
    return query select 'unknown_status'::text, null::uuid; return;
  end if;

  -- The one the Admin is looking at: the live row for this situation,
  -- whatever its current status. Ordered so a re-registration after a
  -- rejection resolves to the newest rather than to the rejected one.
  select t.id into v_id
    from crm.whatsapp_templates t
   where t.organization_id = p_organization_id
     and t.situation_key = p_situation_key
     and t.active
   order by t.created_at desc
   limit 1;

  if v_id is null then
    return query select 'not_registered'::text, null::uuid; return;
  end if;

  update crm.whatsapp_templates t set status = p_status where t.id = v_id;

  perform core.record_audit(
    p_organization_id, 'whatsapp_template.status', 'whatsapp_template', v_id,
    jsonb_build_object('situation_key', p_situation_key, 'status', p_status)
  );

  return query select 'set'::text, v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION finance.confirm_billing_mode(p_project_id uuid, p_mode text, p_source text DEFAULT 'client_confirmation'::text, p_note text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, profile_id uuid, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor   uuid := (select auth.uid());
  v_project projects.projects;
  v_live    finance.billing_profiles;
  v_new     uuid;
  v_version int;
begin
  -- Arguments this function cannot act on are refused before any row is
  -- locked: a caller who passed 'GST ' learns that without holding a lock on
  -- somebody's project.
  if p_mode is null or p_mode not in ('gst', 'non_gst') then
    return query select 'invalid_mode'::text, null::uuid, null::int; return;
  end if;
  if p_source is null or p_source not in ('client_confirmation', 'internal') then
    return query select 'invalid_source'::text, null::uuid, null::int; return;
  end if;

  -- A PERSON. §4.1 says this must not be inferred, and an unattended process
  -- confirming a billing mode is precisely an inference wearing a record's
  -- clothes.
  if v_actor is null then
    return query select 'needs_person'::text, null::uuid, null::int; return;
  end if;

  select p.* into v_project from projects.projects p where p.id = p_project_id for update;
  if v_project.id is null or v_project.deleted_at is not null then
    return query select 'unknown_project'::text, null::uuid, null::int; return;
  end if;

  if v_project.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid, null::int; return;
  end if;

  select bp.* into v_live
    from finance.billing_profiles bp
   where bp.project_id = v_project.id and bp.status = 'active';

  -- Confirming what is already confirmed is not a new version. §4.3 asks that
  -- the preference be preserved "unless legitimately changed", and a repeated
  -- click is not a change.
  if v_live.id is not null and v_live.mode = p_mode then
    return query select 'unchanged'::text, v_live.id, v_live.version; return;
  end if;

  v_version := coalesce(v_live.version, 0) + 1;

  if v_live.id is not null then
    update finance.billing_profiles set status = 'superseded' where id = v_live.id;
  end if;

  insert into finance.billing_profiles (
    organization_id, project_id, client_account_id, version, status, mode,
    -- A mode change carries the details it can still legitimately carry: the
    -- legal name and address do not stop being true because the mode changed.
    -- The GSTIN does not come across to a non-GST profile — the constraint
    -- refuses it, and that refusal is the §4.3 rule made structural.
    legal_name, billing_address, billing_state,
    gstin,
    confirmed_by, source, note
  ) values (
    v_project.organization_id, v_project.id, v_project.client_account_id, v_version, 'active', p_mode,
    v_live.legal_name, v_live.billing_address, v_live.billing_state,
    case when p_mode = 'gst' then v_live.gstin end,
    v_actor, p_source, p_note
  )
  returning id into v_new;

  perform core.emit_event(
    v_project.organization_id, 'project.billing_mode_confirmed', 'project', v_project.id,
    jsonb_build_object('profile_id', v_new, 'mode', p_mode, 'version', v_version, 'source', p_source),
    null
  );

  perform core.record_audit(
    v_project.organization_id, 'project.billing_mode_confirmed', 'project', v_project.id,
    case when v_live.id is not null then jsonb_build_object('mode', v_live.mode, 'version', v_live.version) end,
    jsonb_build_object('mode', p_mode, 'version', v_version, 'profile_id', v_new, 'confirmed_by', v_actor),
    null
  );

  return query select
    case when v_live.id is null then 'confirmed' else 'superseded' end,
    v_new, v_version;
end;
$function$;

CREATE OR REPLACE FUNCTION finance.record_billing_details(p_project_id uuid, p_legal_name text DEFAULT NULL::text, p_billing_address text DEFAULT NULL::text, p_billing_state text DEFAULT NULL::text, p_gstin text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, profile_id uuid, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor   uuid := (select auth.uid());
  v_project projects.projects;
  v_live    finance.billing_profiles;
  v_new     uuid;
  v_gstin   text := nullif(btrim(upper(coalesce(p_gstin, ''))), '');
  v_name    text;
  v_addr    text;
  v_state   text;
begin
  if v_actor is null then
    return query select 'needs_person'::text, null::uuid, null::int; return;
  end if;

  select p.* into v_project from projects.projects p where p.id = p_project_id for update;
  if v_project.id is null or v_project.deleted_at is not null then
    return query select 'unknown_project'::text, null::uuid, null::int; return;
  end if;

  if v_project.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid, null::int; return;
  end if;

  select bp.* into v_live
    from finance.billing_profiles bp
   where bp.project_id = v_project.id and bp.status = 'active';

  -- §16: "Missing billing mode — block invoice." Details before a mode would
  -- be a profile that exists without anybody having decided how this project
  -- is billed, which is the state this whole table was added to end.
  if v_live.id is null then
    return query select 'no_mode'::text, null::uuid, null::int; return;
  end if;

  -- §4.3 again, at the door this time: a GSTIN offered for a non-GST project
  -- is refused by name rather than dropped silently, because a person who
  -- typed one believes it was stored.
  if v_gstin is not null and v_live.mode <> 'gst' then
    return query select 'gstin_on_non_gst'::text, v_live.id, v_live.version; return;
  end if;

  v_name  := coalesce(nullif(btrim(coalesce(p_legal_name, '')), ''), v_live.legal_name);
  v_addr  := coalesce(nullif(btrim(coalesce(p_billing_address, '')), ''), v_live.billing_address);
  v_state := coalesce(nullif(btrim(coalesce(p_billing_state, '')), ''), v_live.billing_state);
  v_gstin := coalesce(v_gstin, v_live.gstin);

  if v_name is not distinct from v_live.legal_name
     and v_addr is not distinct from v_live.billing_address
     and v_state is not distinct from v_live.billing_state
     and v_gstin is not distinct from v_live.gstin then
    return query select 'unchanged'::text, v_live.id, v_live.version; return;
  end if;

  update finance.billing_profiles set status = 'superseded' where id = v_live.id;

  insert into finance.billing_profiles (
    organization_id, project_id, client_account_id, version, status, mode,
    legal_name, billing_address, billing_state, gstin, confirmed_by, source, note
  ) values (
    v_project.organization_id, v_project.id, v_project.client_account_id,
    v_live.version + 1, 'active', v_live.mode,
    v_name, v_addr, v_state, v_gstin, v_actor, v_live.source, v_live.note
  )
  returning id into v_new;

  perform core.record_audit(
    v_project.organization_id, 'project.billing_details_recorded', 'project', v_project.id,
    jsonb_build_object('version', v_live.version),
    jsonb_build_object('version', v_live.version + 1, 'profile_id', v_new, 'recorded_by', v_actor),
    null
  );

  return query select 'recorded'::text, v_new, v_live.version + 1;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.activate_project_plan(p_plan_id uuid)
 RETURNS TABLE(outcome text, findings text[], version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_plan  projects.project_plans;
  v_count int;
  v_open  int;
  v_check record;
begin
  -- A person finalises a plan. §12: "actual phase transition authority remains
  -- with AgencyOS workflow/policy and responsible agents" — and a blueprint
  -- going live is what the pre-kickoff gate reads, so somebody owns it.
  if v_actor is null then
    return query select 'needs_person'::text, '{}'::text[], null::int; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = p_plan_id for update;
  if v_plan.id is null then
    return query select 'unknown_plan'::text, '{}'::text[], null::int; return;
  end if;

  if v_plan.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, '{}'::text[], null::int; return;
  end if;

  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text, '{}'::text[], v_plan.version; return;
  end if;

  -- §7 requires a deliverables register. An empty plan that reads `active`
  -- would satisfy the pre-kickoff gate while containing nothing.
  select count(*) into v_count from projects.plan_deliverables d where d.plan_id = v_plan.id;
  if v_count = 0 then
    return query select 'no_deliverables'::text, '{}'::text[], v_plan.version; return;
  end if;

  -- [G-257 edit 2 of 2] Planning §10: "never guesses an unclear client
  -- requirement", and PLAN-I09 validates ambiguity before ProjectPlanReady. A
  -- plan carrying an unanswered question is a plan that guessed the answer, so
  -- it cannot go live until every clarification is resolved or routed to a
  -- change request. Checked HERE rather than by a constraint because it is a
  -- rule about a moment, not about a row.
  select count(*) into v_open
    from projects.plan_clarifications c
   where c.plan_id = v_plan.id
     and c.status not in ('resolved', 'routed_to_change_request');
  if v_open > 0 then
    return query select 'open_clarifications'::text, '{}'::text[], v_plan.version; return;
  end if;

  -- [G-265 edit 2 of 3] Planning §18 / PLAN-I09: "emit ProjectPlanReady only
  -- after validation pass." `project.plan_activated` IS that event, so the
  -- pass is required here rather than by a second event meaning the same
  -- thing. The findings come back so §18's checklist can be acted on.
  select * into v_check from projects.validate_project_plan(v_plan.id);
  if not v_check.valid then
    return query select 'invalid'::text, v_check.findings, v_plan.version; return;
  end if;

  update projects.project_plans
     set status = 'superseded'
   where project_id = v_plan.project_id and status = 'active';

  update projects.project_plans
     set status = 'active', activated_at = now(), activated_by = v_actor
   where id = v_plan.id;

  perform core.emit_event(
    v_plan.organization_id, 'project.plan_activated', 'project', v_plan.project_id,
    jsonb_build_object('plan_id', v_plan.id, 'version', v_plan.version, 'deliverables', v_count),
    null
  );

  perform core.record_audit(
    v_plan.organization_id, 'project.plan_activated', 'project', v_plan.project_id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'active', 'plan_id', v_plan.id, 'version', v_plan.version, 'activated_by', v_actor),
    null
  );

  return query select 'activated'::text, '{}'::text[], v_plan.version;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.add_plan_deliverable(p_plan_id uuid, p_name text, p_applicable_phase text, p_readiness_criteria text, p_evidence_required text, p_scope_item_id uuid DEFAULT NULL::uuid, p_proposal_item_id uuid DEFAULT NULL::uuid, p_owner_role text DEFAULT NULL::text, p_ambiguity_note text DEFAULT NULL::text, p_position integer DEFAULT 0)
 RETURNS TABLE(outcome text, deliverable_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_plan  projects.project_plans;
  v_new   uuid;
begin
  -- §4.1, at the door as well as in the constraint: a deliverable with no
  -- approved source is a feature this agent invented, and the caller is told
  -- so by name rather than by a constraint violation.
  if p_scope_item_id is null and p_proposal_item_id is null then
    return query select 'no_approved_source'::text, null::uuid; return;
  end if;

  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'needs_person'::text, null::uuid; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = p_plan_id for update;
  if v_plan.id is null then
    return query select 'unknown_plan'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_plan.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text, null::uuid; return;
  end if;

  insert into projects.plan_deliverables (
    organization_id, plan_id, position, name, scope_item_id, proposal_item_id,
    applicable_phase, owner_role, readiness_criteria, evidence_required, ambiguity_note
  ) values (
    v_plan.organization_id, v_plan.id, coalesce(p_position, 0), p_name,
    p_scope_item_id, p_proposal_item_id, p_applicable_phase, p_owner_role,
    p_readiness_criteria, p_evidence_required, nullif(btrim(coalesce(p_ambiguity_note, '')), '')
  )
  returning id into v_new;

  return query select 'added'::text, v_new;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.add_plan_dependency(p_plan_id uuid, p_kind text, p_description text, p_needed_by_phase text, p_owner_role text, p_window_start date DEFAULT NULL::date, p_window_end date DEFAULT NULL::date, p_timing_basis text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, dependency_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_plan  projects.project_plans;
  v_new   uuid;
begin
  -- §4.3 and §11, refused before the lock and by name: a window with no
  -- stated basis is a guarantee nobody can defend.
  if (p_window_start is not null or p_window_end is not null)
     and coalesce(btrim(coalesce(p_timing_basis, '')), '') = '' then
    return query select 'dates_need_a_basis'::text, null::uuid; return;
  end if;

  -- §4.4: the Planning Agent does not take over client communication.
  if p_kind in ('client_information', 'client_access') and p_owner_role is distinct from 'project_manager' then
    return query select 'client_items_are_pms'::text, null::uuid; return;
  end if;

  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'needs_person'::text, null::uuid; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = p_plan_id for update;
  if v_plan.id is null then
    return query select 'unknown_plan'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_plan.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text, null::uuid; return;
  end if;

  insert into projects.plan_dependencies (
    organization_id, plan_id, kind, description, needed_by_phase,
    needed_by_window_start, needed_by_window_end, timing_basis, owner_role
  ) values (
    v_plan.organization_id, v_plan.id, p_kind, p_description, p_needed_by_phase,
    p_window_start, p_window_end, nullif(btrim(coalesce(p_timing_basis, '')), ''), p_owner_role
  )
  returning id into v_new;

  return query select 'added'::text, v_new;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.add_plan_milestone(p_plan_id uuid, p_name text, p_kind text, p_phase text, p_gate_criteria text, p_payment_milestone_id uuid DEFAULT NULL::uuid, p_window_start date DEFAULT NULL::date, p_window_end date DEFAULT NULL::date, p_timing_basis text DEFAULT NULL::text, p_position integer DEFAULT 0)
 RETURNS TABLE(outcome text, milestone_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_plan  projects.project_plans;
  v_pm    projects.milestones;
  v_new   uuid;
begin
  -- §11, refused before the lock and by name.
  if (p_window_start is not null or p_window_end is not null)
     and coalesce(btrim(coalesce(p_timing_basis, '')), '') = '' then
    return query select 'dates_need_a_basis'::text, null::uuid; return;
  end if;

  -- §7's finance map, both directions, named rather than left to a constraint.
  if p_kind = 'finance_gate' and p_payment_milestone_id is null then
    return query select 'finance_gate_needs_a_milestone'::text, null::uuid; return;
  end if;
  if p_kind <> 'finance_gate' and p_payment_milestone_id is not null then
    return query select 'only_finance_gates_name_a_milestone'::text, null::uuid; return;
  end if;

  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'needs_person'::text, null::uuid; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = p_plan_id for update;
  if v_plan.id is null then
    return query select 'unknown_plan'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_plan.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text, null::uuid; return;
  end if;

  -- A finance gate must map THIS project's payment milestone. Pointing at
  -- another project's would put that client's money in this client's plan.
  if p_payment_milestone_id is not null then
    select m.* into v_pm from projects.milestones m where m.id = p_payment_milestone_id;
    if v_pm.id is null or v_pm.project_id is distinct from v_plan.project_id then
      return query select 'wrong_project'::text, null::uuid; return;
    end if;
  end if;

  insert into projects.plan_milestones (
    organization_id, plan_id, position, name, kind, phase, gate_criteria,
    target_window_start, target_window_end, timing_basis, payment_milestone_id
  ) values (
    v_plan.organization_id, v_plan.id, coalesce(p_position, 0), p_name, p_kind, p_phase, p_gate_criteria,
    p_window_start, p_window_end, nullif(btrim(coalesce(p_timing_basis, '')), ''), p_payment_milestone_id
  )
  returning id into v_new;

  return query select 'added'::text, v_new;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.add_plan_note(p_plan_id uuid, p_kind text, p_statement text, p_owner_role text DEFAULT NULL::text, p_escalation_path text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, note_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_plan  projects.project_plans;
  v_new   uuid;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'needs_person'::text, null::uuid; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = p_plan_id for update;
  if v_plan.id is null then
    return query select 'unknown_plan'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_plan.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text, null::uuid; return;
  end if;

  insert into projects.plan_notes (organization_id, plan_id, kind, statement, owner_role, escalation_path)
  values (v_plan.organization_id, v_plan.id, p_kind, p_statement,
          nullif(btrim(coalesce(p_owner_role, '')), ''),
          nullif(btrim(coalesce(p_escalation_path, '')), ''))
  returning id into v_new;

  return query select 'added'::text, v_new;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.add_team_default(p_display_name text, p_phone text, p_role text DEFAULT NULL::text, p_position integer DEFAULT 0)
 RETURNS TABLE(outcome text, member_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_new   uuid;
begin
  -- The same shape the column checks, refused here first so a person pasting a
  -- name into the number field is told which field, not which constraint.
  if v_phone is null or v_phone !~ '^\+?[0-9]{6,20}$' then
    return query select 'invalid_phone'::text, null::uuid; return;
  end if;

  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  v_org := (select core.current_organization_id());
  if v_org is null or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  -- One row per number: two entries for the same phone is two names for one
  -- person in a group of eight. Answered rather than raised, because adding
  -- somebody who is already there is not a mistake worth an error.
  select d.id into v_new
    from projects.group_team_defaults d
   where d.organization_id = v_org and d.phone = v_phone;
  if v_new is not null then
    return query select 'already_listed'::text, v_new; return;
  end if;

  insert into projects.group_team_defaults (organization_id, display_name, phone, role, position)
  values (v_org, btrim(p_display_name), v_phone, nullif(btrim(coalesce(p_role, '')), ''), coalesce(p_position, 0))
  returning id into v_new;

  return query select 'added'::text, v_new;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.confirm_group_created(p_setup_id uuid, p_note text DEFAULT NULL::text)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
     or not coalesce((select core.can_write()), false) then
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
$function$;

CREATE OR REPLACE FUNCTION projects.draft_project_plan(p_project_id uuid, p_objective text DEFAULT NULL::text, p_change_reason text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, plan_id uuid, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor   uuid := (select auth.uid());
  v_project projects.projects;
  v_scope   projects.scope_versions;
  v_live    projects.project_plans;
  v_draft   projects.project_plans;
  v_version int;
  v_new     uuid;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid, null::int; return;
  end if;

  select p.* into v_project from projects.projects p where p.id = p_project_id for update;
  if v_project.id is null or v_project.deleted_at is not null then
    return query select 'unknown_project'::text, null::uuid, null::int; return;
  end if;

  if v_actor is not null
     and (v_project.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid, null::int; return;
  end if;

  select pp.* into v_draft from projects.project_plans pp
   where pp.project_id = v_project.id and pp.status = 'draft';
  if v_draft.id is not null then
    return query select 'already_drafting'::text, v_draft.id, v_draft.version; return;
  end if;

  select pp.* into v_live from projects.project_plans pp
   where pp.project_id = v_project.id and pp.status = 'active';

  v_version := coalesce(v_live.version, 0) + 1;

  -- §4.8: a second version says why it exists.
  if v_version > 1 and coalesce(btrim(p_change_reason), '') = '' then
    return query select 'needs_reason'::text, null::uuid, null::int; return;
  end if;

  -- §3: the approved scope is an INPUT. A plan drafted with no approved scope
  -- would be a plan of things nobody agreed to — §4.1's whole prohibition.
  select sv.* into v_scope
    from projects.scope_versions sv
   where sv.project_id = v_project.id and sv.status <> 'draft'
   order by sv.version desc
   limit 1;
  if v_scope.id is null then
    return query select 'no_scope'::text, null::uuid, null::int; return;
  end if;

  insert into projects.project_plans (
    organization_id, project_id, version, status, scope_version_id, objective, change_reason, created_by
  ) values (
    v_project.organization_id, v_project.id, v_version, 'draft', v_scope.id,
    coalesce(nullif(btrim(coalesce(p_objective, '')), ''), v_live.objective),
    nullif(btrim(coalesce(p_change_reason, '')), ''),
    v_actor
  )
  returning id into v_new;

  perform core.emit_event(
    v_project.organization_id, 'project.plan_drafted', 'project', v_project.id,
    jsonb_build_object('plan_id', v_new, 'version', v_version, 'scope_version_id', v_scope.id),
    null
  );

  return query select 'drafted'::text, v_new, v_version;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.draft_screen_baseline(p_project_id uuid, p_change_reason text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, baseline_id uuid, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor    uuid := (select auth.uid());
  v_phase3   projects.phase_three;
  v_scope    projects.scope_versions;
  v_existing projects.screen_baselines;
  v_last     int;
  v_new      uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, null::int; return;
  end if;

  select p3.* into v_phase3
    from projects.phase_three p3
   where p3.project_id = p_project_id
   for update;

  if v_phase3.id is null then
    -- §3: Phase 3 must be active. A screen baseline for a project whose UI
    -- finalization has not started is work nobody asked for.
    return query select 'no_phase_three'::text, null::uuid, null::int; return;
  end if;

  if v_phase3.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid, null::int; return;
  end if;

  -- §7.3: "required by approved scope." The ACTIVE baseline, because a
  -- superseded one is what the project used to be.
  select sv.* into v_scope
    from projects.scope_versions sv
   where sv.project_id = p_project_id
     and sv.status = 'active'
   order by sv.version desc
   limit 1;

  if v_scope.id is null then
    return query select 'no_scope'::text, null::uuid, null::int; return;
  end if;

  select sb.* into v_existing
    from projects.screen_baselines sb
   where sb.project_id = p_project_id
     and sb.status in ('draft', 'review')
   limit 1;

  if v_existing.id is not null then
    return query select 'already_drafting'::text, v_existing.id, v_existing.version; return;
  end if;

  select coalesce(max(sb.version), 0) into v_last
    from projects.screen_baselines sb
   where sb.project_id = p_project_id;

  -- From v2 a reason is required, the same rule G-256 made for the operational
  -- plan and for the same reason: a second version with no stated cause is a
  -- rewrite wearing a version number.
  if v_last > 0 and (p_change_reason is null or length(btrim(p_change_reason)) = 0) then
    return query select 'needs_reason'::text, null::uuid, null::int; return;
  end if;

  insert into projects.screen_baselines
    (organization_id, project_id, version, scope_version_id, change_reason, created_by)
  values
    (v_phase3.organization_id, p_project_id, v_last + 1, v_scope.id,
     nullif(btrim(coalesce(p_change_reason, '')), ''), v_actor)
  returning id into v_new;

  -- §14: the phase is in screen definition while a baseline is open.
  update projects.phase_three
     set state = 'screen_definition'
   where id = v_phase3.id
     and state in ('context_loading', 'screen_definition');

  perform core.record_audit(
    v_phase3.organization_id, 'project.screen_list_drafted', 'screen_baseline', v_new, null,
    jsonb_build_object('projectId', p_project_id, 'version', v_last + 1)
  );

  perform core.emit_event(
    v_phase3.organization_id, 'project.screen_list_drafted', 'screen_baseline', v_new,
    jsonb_build_object('projectId', p_project_id, 'version', v_last + 1)
  );

  return query select 'drafted'::text, v_new, v_last + 1;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.finalize_screen_baseline(p_baseline_id uuid)
 RETURNS TABLE(outcome text, screen_count integer, findings text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor    uuid := (select auth.uid());
  v_row      projects.screen_baselines;
  v_snapshot jsonb;
  v_count    int;
  v_uncovered int;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::int, '{}'::text[]; return;
  end if;

  select sb.* into v_row
    from projects.screen_baselines sb
   where sb.id = p_baseline_id
   for update;

  if v_row.id is null then
    return query select 'unknown_baseline'::text, null::int, '{}'::text[]; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::int, '{}'::text[]; return;
  end if;

  if v_row.status = 'finalized' then
    return query select 'already_finalized'::text, v_row.screen_count, '{}'::text[]; return;
  end if;

  -- §7.3: "the COMPLETE screen list." An empty list is not a list.
  select count(*) into v_count
    from projects.screens s
   where s.project_id = v_row.project_id
     and s.status <> 'superseded';

  if v_count = 0 then
    return query select 'no_screens'::text, 0, '{}'::text[]; return;
  end if;

  -- §7.3's completeness, checked against the baseline's OWN scope version.
  -- The August trigger already refuses a design entering review while an
  -- included item has no screen; this is the same rule asked at a different
  -- moment, because a baseline is finalized long before any design is filed.
  select count(*) into v_uncovered
    from projects.scope_items si
   where si.scope_version_id = v_row.scope_version_id
     and si.inclusion = 'included'
     and not exists (
       select 1
         from projects.screen_scope_items ssi
         join projects.screens s on s.id = ssi.screen_id
        where ssi.scope_item_id = si.id
          and s.project_id = v_row.project_id
          and s.status <> 'superseded'
     );

  if v_uncovered > 0 then
    return query select 'uncovered_scope'::text, v_count,
      array[format('uncovered_scope_items:%s', v_uncovered)]::text[];
    return;
  end if;

  -- THE SNAPSHOT. Every field §13's contract names, as it stands right now.
  select jsonb_agg(
           jsonb_build_object(
             'screenKey', s.screen_key,
             'name', s.name,
             'userRole', s.user_role,
             'purpose', s.purpose,
             'requiredSections', s.required_sections,
             'requiredData', s.required_data,
             'actions', s.actions,
             'dependencies', s.dependencies,
             'entryPoint', s.entry_point,
             'exitAction', s.exit_action,
             'states', jsonb_build_object(
               'empty', s.has_empty_state,
               'loading', s.has_loading_state,
               'error', s.has_error_state,
               'success', s.has_success_state
             ),
             'scopeItemIds', coalesce((
               select jsonb_agg(ssi.scope_item_id)
                 from projects.screen_scope_items ssi
                where ssi.screen_id = s.id
             ), '[]'::jsonb)
           )
           order by s.screen_key
         )
    into v_snapshot
    from projects.screens s
   where s.project_id = v_row.project_id
     and s.status <> 'superseded';

  update projects.screen_baselines
     set status = 'finalized',
         screens = coalesce(v_snapshot, '[]'::jsonb),
         screen_count = v_count,
         finalized_at = now()
   where id = v_row.id;

  -- Which list each screen was last carried into. A stamp, not a reference:
  -- the screen outlives the baseline and editing it later must not reach back
  -- into the snapshot.
  update projects.screens
     set baseline_version = v_row.version
   where project_id = v_row.project_id
     and status <> 'superseded';

  -- §14: a finalized list is what opens theme generation.
  update projects.phase_three
     set state = 'theme_generation'
   where project_id = v_row.project_id
     and state = 'screen_definition';

  perform core.record_audit(
    v_row.organization_id, 'project.screen_list_finalized', 'screen_baseline', v_row.id, null,
    jsonb_build_object('projectId', v_row.project_id, 'version', v_row.version, 'screens', v_count)
  );

  perform core.emit_event(
    v_row.organization_id, 'project.screen_list_finalized', 'screen_baseline', v_row.id,
    jsonb_build_object('projectId', v_row.project_id, 'version', v_row.version, 'screens', v_count)
  );

  return query select 'finalized'::text, v_count, '{}'::text[];
end;
$function$;

CREATE OR REPLACE FUNCTION projects.gate_plan_milestone(p_milestone_id uuid, p_dependency_id uuid)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_ms    projects.plan_milestones;
  v_dep   projects.plan_dependencies;
  v_plan  projects.project_plans;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'needs_person'::text; return;
  end if;

  select pm.* into v_ms from projects.plan_milestones pm where pm.id = p_milestone_id;
  if v_ms.id is null then
    return query select 'unknown_milestone'::text; return;
  end if;

  select pd.* into v_dep from projects.plan_dependencies pd where pd.id = p_dependency_id;
  if v_dep.id is null then
    return query select 'unknown_dependency'::text; return;
  end if;

  -- Both must belong to the SAME plan. A milestone gated by another plan's
  -- dependency is a wait nobody will ever satisfy.
  if v_dep.plan_id is distinct from v_ms.plan_id then
    return query select 'different_plan'::text; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = v_ms.plan_id for update;

  if v_actor is not null
     and (v_plan.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text; return;
  end if;

  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text; return;
  end if;

  insert into projects.plan_milestone_dependencies (organization_id, milestone_id, dependency_id)
  values (v_ms.organization_id, v_ms.id, v_dep.id)
  on conflict (milestone_id, dependency_id) do nothing;

  if not found then
    return query select 'already_gated'::text; return;
  end if;

  return query select 'gated'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.map_group(p_setup_id uuid, p_conversation_id uuid)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
     or not coalesce((select core.can_write()), false) then
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
$function$;

CREATE OR REPLACE FUNCTION projects.mark_clarification_asked(p_clarification_id uuid)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.plan_clarifications;
begin
  -- A PERSON. This records that somebody asked a client a question, which is
  -- an event outside this system, and an unattended process cannot witness it.
  if v_actor is null then
    return query select 'needs_person'::text; return;
  end if;

  select c.* into v_row from projects.plan_clarifications c where c.id = p_clarification_id for update;
  if v_row.id is null then
    return query select 'unknown_clarification'::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;

  if v_row.status <> 'open' then
    return query select 'already_asked'::text; return;
  end if;

  update projects.plan_clarifications
     set status = 'asked', asked_at = now(), asked_by = v_actor
   where id = v_row.id;

  return query select 'asked'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.raise_clarification(p_plan_id uuid, p_question text, p_impact text, p_scope_item_id uuid DEFAULT NULL::uuid, p_deliverable_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(outcome text, clarification_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_plan  projects.project_plans;
  v_new   uuid;
begin
  -- §14's source evidence, refused before the lock and by name.
  if p_scope_item_id is null and p_deliverable_id is null then
    return query select 'no_source'::text, null::uuid; return;
  end if;

  -- The Planning Agent raises these, so the service role may. What it may not
  -- do is answer one.
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = p_plan_id for update;
  if v_plan.id is null then
    return query select 'unknown_plan'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_plan.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text, null::uuid; return;
  end if;

  insert into projects.plan_clarifications (
    organization_id, plan_id, question, impact, scope_item_id, deliverable_id
  ) values (
    v_plan.organization_id, v_plan.id, p_question, p_impact, p_scope_item_id, p_deliverable_id
  )
  returning id into v_new;

  perform core.emit_event(
    v_plan.organization_id, 'project.clarification_required', 'project', v_plan.project_id,
    jsonb_build_object('clarification_id', v_new, 'plan_id', v_plan.id),
    null
  );

  return query select 'raised'::text, v_new;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.record_clarification_answer(p_clarification_id uuid, p_answer text, p_answered_via text DEFAULT NULL::text)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.plan_clarifications;
begin
  -- An empty answer is not an answer, and storing one would move the status to
  -- `answered` while leaving the question unanswered — the precise shape of
  -- the guess §10 forbids.
  if coalesce(btrim(coalesce(p_answer, '')), '') = '' then
    return query select 'empty_answer'::text; return;
  end if;

  if v_actor is null then
    return query select 'needs_person'::text; return;
  end if;

  select c.* into v_row from projects.plan_clarifications c where c.id = p_clarification_id for update;
  if v_row.id is null then
    return query select 'unknown_clarification'::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;

  if v_row.status in ('resolved', 'routed_to_change_request') then
    return query select 'already_settled'::text; return;
  end if;
  -- An answer to a question nobody asked is a guess wearing a client's voice.
  if v_row.status = 'open' then
    return query select 'not_asked'::text; return;
  end if;

  update projects.plan_clarifications
     set status = 'answered', answer = btrim(p_answer), answered_at = now(),
         answered_by = v_actor, answered_via = nullif(btrim(coalesce(p_answered_via, '')), '')
   where id = v_row.id;

  return query select 'answered'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.record_kickoff(p_project_id uuid, p_evidence_ref text)
 RETURNS TABLE(outcome text, unmet text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor   uuid := (select auth.uid());
  v_project projects.projects;
  v_phase   projects.phase_two;
  v_ready   record;
  v_started record;
  v_evidence text := nullif(btrim(coalesce(p_evidence_ref, '')), '');
begin
  -- §5.11's "record kickoff timestamp/evidence", enforced. A kickoff with no
  -- evidence is this system claiming a client was told something nobody can
  -- show them being told. Refused before the lock.
  if v_evidence is null then
    return query select 'no_evidence'::text, '{}'::text[]; return;
  end if;

  -- A PERSON. PM-09 is the PM sending a message to a client; on this
  -- deployment a person sends it, and the same person records that they did.
  if v_actor is null then
    return query select 'needs_person'::text, '{}'::text[]; return;
  end if;

  select p.* into v_project from projects.projects p where p.id = p_project_id for update;
  if v_project.id is null or v_project.deleted_at is not null then
    return query select 'unknown_project'::text, '{}'::text[]; return;
  end if;

  if v_project.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, '{}'::text[]; return;
  end if;

  select pt.* into v_phase from projects.phase_two pt where pt.project_id = v_project.id;
  if v_phase.id is null then
    -- Phase 2 never started, so there is no phase to complete. Announcing a
    -- kickoff for one would be announcing the end of something that never
    -- began.
    return query select 'no_phase_two'::text, '{}'::text[]; return;
  end if;

  if v_phase.state = 'completed' then
    return query select 'already_done'::text, '{}'::text[]; return;
  end if;

  select * into v_ready from projects.pre_kickoff_readiness(v_project.id);
  -- No override. PM §15: "kickoff gate fails - do not announce kickoff;
  -- surface missing gates." The gaps come back so a person can act on them.
  if not v_ready.ready then
    return query select 'not_ready'::text, v_ready.unmet; return;
  end if;

  -- §5.11's "set project ACTIVE", through the door that already owns the
  -- status rather than an update here. A second way to become active is a
  -- second set of conditions to keep honest.
  select * into v_started from projects.start_project(v_project.id, null);
  if v_started.outcome not in ('started', 'already_active') then
    return query select 'project_would_not_start'::text, coalesce(v_started.unmet, '{}'::text[]); return;
  end if;

  -- PM §11's ladder, both steps, because the moment the message went out and
  -- the moment the phase closed are different facts even when they are one
  -- second apart.
  update projects.phase_two
     set state = 'kickoff_sent', kickoff_at = now()
   where id = v_phase.id;

  update projects.phase_two
     set state = 'completed', completed_at = now()
   where id = v_phase.id;

  perform core.emit_event(
    v_project.organization_id, 'project.phase_two_completed', 'project', v_project.id,
    jsonb_build_object('phase_two_id', v_phase.id, 'evidence_ref', v_evidence, 'kicked_off_by', v_actor),
    null
  );

  -- §9's structured handoff out. Nothing subscribes to it yet, which is the
  -- same shape Phase 1 shipped `opportunity.handed_off` in and for the same
  -- reason: the receiver is the next phase, and the next phase does not exist.
  perform core.emit_event(
    v_project.organization_id, 'project.phase_three_ready', 'project', v_project.id,
    jsonb_build_object('phase_two_id', v_phase.id, 'handoff_id', v_phase.handoff_id),
    null
  );

  perform core.record_audit(
    v_project.organization_id, 'project.phase_two_completed', 'project', v_project.id,
    jsonb_build_object('state', v_phase.state, 'project_status', v_project.status),
    jsonb_build_object('state', 'completed', 'project_status', 'active',
                       'evidence_ref', v_evidence, 'kicked_off_by', v_actor),
    null
  );

  return query select 'kicked_off'::text, '{}'::text[];
end;
$function$;

CREATE OR REPLACE FUNCTION projects.remove_team_default(p_member_id uuid)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.group_team_defaults;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  select d.* into v_row from projects.group_team_defaults d where d.id = p_member_id for update;
  if v_row.id is null then
    return query select 'unknown_member'::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;

  -- Safe because a card's member list is a COPY (G-253): deleting somebody
  -- here cannot reach into a group that already exists. That is the property
  -- the copy was chosen for.
  delete from projects.group_team_defaults where id = v_row.id;
  return query select 'removed'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.request_group_setup(p_project_id uuid)
 RETURNS TABLE(outcome text, setup_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
          or not coalesce((select core.can_write()), false)) then
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
$function$;

CREATE OR REPLACE FUNCTION projects.resolve_clarification(p_clarification_id uuid)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.plan_clarifications;
begin
  if v_actor is null then
    return query select 'needs_person'::text; return;
  end if;

  select c.* into v_row from projects.plan_clarifications c where c.id = p_clarification_id for update;
  if v_row.id is null then
    return query select 'unknown_clarification'::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;

  if v_row.status in ('resolved', 'routed_to_change_request') then
    return query select 'already_settled'::text; return;
  end if;

  -- The whole rule, in one refusal: a clarification cannot be closed without
  -- the client's answer. Closing it empty is deciding what they meant.
  if v_row.status <> 'answered' then
    return query select 'no_answer'::text; return;
  end if;

  update projects.plan_clarifications
     set status = 'resolved', resolved_at = now()
   where id = v_row.id;

  perform core.emit_event(
    v_row.organization_id, 'project.clarification_resolved', 'project',
    (select pp.project_id from projects.project_plans pp where pp.id = v_row.plan_id),
    jsonb_build_object('clarification_id', v_row.id, 'ending', 'answered'),
    null
  );

  return query select 'resolved'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.revise_group_setup(p_setup_id uuid, p_suggested_name text DEFAULT NULL::text, p_members jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
          or not coalesce((select core.can_write()), false)) then
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
$function$;

CREATE OR REPLACE FUNCTION projects.route_clarification_to_change_request(p_clarification_id uuid, p_change_request_id uuid)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.plan_clarifications;
  v_plan  projects.project_plans;
  v_cr    projects.change_requests;
begin
  if v_actor is null then
    return query select 'needs_person'::text; return;
  end if;

  select c.* into v_row from projects.plan_clarifications c where c.id = p_clarification_id for update;
  if v_row.id is null then
    return query select 'unknown_clarification'::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;

  if v_row.status in ('resolved', 'routed_to_change_request') then
    return query select 'already_settled'::text; return;
  end if;

  select cr.* into v_cr from projects.change_requests cr where cr.id = p_change_request_id;
  if v_cr.id is null or v_cr.organization_id is distinct from v_row.organization_id then
    return query select 'unknown_change_request'::text; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = v_row.plan_id;
  -- The change request must be for THIS project. Routing a question to another
  -- project's change request would price this client's new work onto that one.
  if v_cr.project_id is distinct from v_plan.project_id then
    return query select 'wrong_project'::text; return;
  end if;

  update projects.plan_clarifications
     set status = 'routed_to_change_request',
         change_request_id = v_cr.id,
         resolved_at = now(),
         -- §10: routing is itself the ending, so the row stops being open even
         -- though no client answer was recorded. The asked_at stamp is kept.
         asked_at = coalesce(v_row.asked_at, now())
   where id = v_row.id;

  perform core.emit_event(
    v_row.organization_id, 'project.clarification_resolved', 'project', v_plan.project_id,
    jsonb_build_object('clarification_id', v_row.id, 'ending', 'change_request', 'change_request_id', v_cr.id),
    null
  );

  perform core.record_audit(
    v_row.organization_id, 'project.clarification_routed', 'project', v_plan.project_id,
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('status', 'routed_to_change_request', 'clarification_id', v_row.id,
                       'change_request_id', v_cr.id, 'routed_by', v_actor),
    null
  );

  return query select 'routed'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.set_team_default_active(p_member_id uuid, p_active boolean)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.group_team_defaults;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  select d.* into v_row from projects.group_team_defaults d where d.id = p_member_id for update;
  if v_row.id is null then
    return query select 'unknown_member'::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;

  if v_row.active = p_active then
    return query select 'unchanged'::text; return;
  end if;

  update projects.group_team_defaults set active = p_active where id = v_row.id;
  return query select 'set'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.start_phase_two(p_project_id uuid)
 RETURNS TABLE(outcome text, phase_two_id uuid, handoff_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor   uuid := (select auth.uid());
  v_project projects.projects;
  v_handoff ai.handoffs;
  v_existing projects.phase_two;
  v_new     uuid;
begin
  -- The service role starts Phase 2 because the trigger for it is an EVENT,
  -- not a click: the binding happened, and a job acts on it. A person may
  -- also start it (a repair after a lost event), which is why the actor path
  -- exists at all.
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid, null::uuid; return;
  end if;

  -- Locked: two jobs for one project — a replayed event and a repair — must
  -- not both pass the existence check and both insert.
  select p.* into v_project from projects.projects p where p.id = p_project_id for update;
  if v_project.id is null or v_project.deleted_at is not null then
    return query select 'unknown_project'::text, null::uuid, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_project.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid, null::uuid; return;
  end if;

  select pt.* into v_existing from projects.phase_two pt where pt.project_id = v_project.id;
  if v_existing.id is not null then
    return query select 'already_started'::text, v_existing.id, v_existing.handoff_id; return;
  end if;

  -- Master §5.1: "Block invalid/incomplete handoff instead of inventing
  -- missing data." No packet, no Phase 2 — and the refusal is named so the
  -- remediation is somebody's task rather than a mystery.
  select h.* into v_handoff
    from ai.handoffs h
   where h.project_id = v_project.id
     and h.organization_id = v_project.organization_id
     and h.from_agent = 'sales'
     and h.to_agent = 'project_manager'
     and h.subject_type = 'opportunity'
   order by h.created_at
   limit 1;
  if v_handoff.id is null then
    return query select 'no_handoff'::text, null::uuid, null::uuid; return;
  end if;

  insert into projects.phase_two (organization_id, project_id, handoff_id, state)
  values (v_project.organization_id, v_project.id, v_handoff.id, 'context_loading')
  returning id into v_new;

  -- The packet is no longer sitting at `queued` with no receiver.
  update ai.handoffs
     set status = 'accepted',
         accepted_at = coalesce(accepted_at, now())
   where id = v_handoff.id
     and status = 'queued';

  perform core.record_audit(
    v_project.organization_id,
    'project.phase_two_started',
    'project',
    v_project.id,
    null::jsonb,
    jsonb_build_object(
      'phase_two_id', v_new,
      'handoff_id', v_handoff.id,
      'opportunity_id', v_handoff.subject_id,
      'state', 'context_loading',
      'pm_agent', 'project_manager',
      'started_by', v_actor
    ),
    v_handoff.correlation_id
  );

  return query select 'started'::text, v_new, v_handoff.id;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.verify_group(p_setup_id uuid)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
     or not coalesce((select core.can_write()), false) then
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
$function$;

CREATE OR REPLACE FUNCTION sales.clear_approved_offer(p_organization_id uuid)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
begin
  if (select auth.uid()) is not null and not coalesce((select core.is_owner()), false) then
    return query select 'forbidden'::text;
    return;
  end if;

  perform set_config('sales.offer_write', 'on', true);

  update sales.approved_offers
     set active = false
   where organization_id = p_organization_id and active
  returning id into v_id;

  if v_id is null then
    return query select 'none_active'::text;
    return;
  end if;

  perform core.record_audit(
    p_organization_id, 'offer.withdrawn', 'approved_offer', v_id, null, null, null
  );

  return query select 'cleared'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION sales.clear_payment_structure(p_organization_id uuid, p_name text)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
begin
  if (select auth.uid()) is not null and not coalesce((select core.is_owner()), false) then
    return query select 'forbidden'::text; return;
  end if;

  select s.id into v_id
    from sales.payment_structures s
   where s.organization_id = p_organization_id and s.name = btrim(p_name) and s.active;

  if v_id is null then
    return query select 'no_structure'::text; return;
  end if;

  perform set_config('sales.payment_write', 'on', true);
  update sales.payment_structures set active = false where id = v_id;

  perform core.record_audit(
    p_organization_id, 'payment_structure.withdrawn', 'payment_structure', v_id,
    jsonb_build_object('name', btrim(p_name)), null, null
  );

  return query select 'cleared'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION sales.record_won_handoff(p_opportunity_id uuid, p_project_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(outcome text, handoff_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor        uuid := (select auth.uid());
  v_opp          sales.opportunities;
  v_project      projects.projects;
  v_lead         crm.leads;
  v_contact      crm.contacts;
  v_proposal     sales.proposals;
  v_approval     approvals.approval_requests;
  v_requirement  crm.requirement_versions;
  v_conversation uuid;
  v_summary_seq  int;
  v_consent      text;
  v_trust        uuid[];
  v_switch       text;
  v_verdict      text;
  v_existing     ai.handoffs;
  v_prev         projects.projects;
  v_rebound      boolean := false;
  v_id           uuid;
  -- A fresh chain. A human won this deal; there is no agent run to inherit a
  -- correlation from, and the handoff is the root of whatever Phase 2 does.
  v_correlation  uuid := gen_random_uuid();
  v_unresolved   jsonb := '[]'::jsonb;
  v_payment_evidence jsonb;
begin
  select o.* into v_opp
    from sales.opportunities o
   where o.id = p_opportunity_id
   for update;

  if v_opp.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and v_opp.organization_id is distinct from (select core.current_organization_id()) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  -- A DEFINER door is open to whoever may call it, and this one is granted to
  -- authenticated. The tables it writes admit far fewer: handoffs_write is
  -- admin-only, outbox_insert owner/ops_admin-only. A portal client of the
  -- same organization must not be able to write a handoff, emit the event and
  -- sign the audit row by calling this directly — review found it could.
  -- Staff may: the trigger runs as whoever moved the stage, which any member
  -- with lead.write can do, and conversion is the same people.
  if v_actor is not null and not coalesce((select core.is_internal()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_opp.stage <> 'won' then
    return query select 'not_won'::text, null::uuid; return;
  end if;

  -- A project, when one is named, must be THIS deal's, in this tenant, and
  -- alive. A handoff pointing at somebody else's project is worse than none.
  -- The trigger names none: at the win there is no project yet.
  if p_project_id is not null then
    select p.* into v_project
      from projects.projects p
     where p.id = p_project_id
       and p.deleted_at is null;

    if v_project.id is null
       or v_project.opportunity_id is distinct from v_opp.id
       or v_project.organization_id <> v_opp.organization_id then
      return query select 'project_mismatch'::text, null::uuid; return;
    end if;
  end if;

  -- Idempotent, under the lock. The trigger wrote this row at the win; a
  -- conversion binds its project to it; a second click, or a re-run that
  -- repairs a half-finished one, finds it and stops.
  select h.* into v_existing
    from ai.handoffs h
   where h.organization_id = v_opp.organization_id
     and h.subject_type = 'opportunity'
     and h.subject_id   = v_opp.id
     and h.from_agent   = 'sales'
     and h.to_agent     = 'project_manager';

  if v_existing.id is not null then
    if v_project.id is null or v_existing.project_id = v_project.id then
      return query select 'already_recorded'::text, v_existing.id; return;
    end if;
    if v_existing.project_id is not null then
      select p.* into v_prev from projects.projects p where p.id = v_existing.project_id;
      if v_prev.id is not null and v_prev.deleted_at is null then
        -- Bound to a LIVE project of this deal already. Two projects from one
        -- win is not a handoff this row can describe; refused by name (and
        -- projects_opportunity_key refuses the second project at the row).
        return query select 'project_mismatch'::text, v_existing.id; return;
      end if;
      -- Bound to a project raised by mistake and soft-deleted. The projects
      -- model allows a fresh one (projects_opportunity_key is partial on
      -- deleted_at); review found this row then refusing the fresh one forever
      -- and the projection presenting the dead one. The packet follows the
      -- live project — and says so.
      v_rebound := true;
    end if;
    -- Bind. The packet was assembled at the win from the latest accepted
    -- version — the selector conversion uses too — so a project raised from
    -- some other version is a fact worth naming, not a reason to refuse the
    -- conversion (ADM-72: visible, never fabricated, never silently fixed).
    v_unresolved := v_existing.unresolved - 'project_proposal_differs';
    if v_project.proposal_id is not null
       and (v_existing.artifacts->0->>'proposal_id') is distinct from v_project.proposal_id::text then
      v_unresolved := v_unresolved || '"project_proposal_differs"'::jsonb;
    end if;
    if v_rebound then
      v_unresolved := v_unresolved || '"project_rebound"'::jsonb;
    end if;
    update ai.handoffs h
       set project_id = v_project.id,
           context    = h.context || jsonb_strip_nulls(jsonb_build_object(
                          'project_id', v_project.id,
                          'client_account_id', coalesce(v_project.client_account_id, v_opp.client_account_id),
                          'previous_project_id', case when v_rebound then v_existing.project_id end)),
           unresolved = v_unresolved
     where h.id = v_existing.id;
    perform core.record_audit(
      v_opp.organization_id, 'opportunity.handoff_bound', 'opportunity', v_opp.id,
      null,
      jsonb_strip_nulls(jsonb_build_object('handoff_id', v_existing.id, 'project_id', v_project.id,
                                           'previous_project_id', case when v_rebound then v_existing.project_id end)),
      v_existing.correlation_id
    );
    return query select 'project_bound'::text, v_existing.id; return;
  end if;

  -- ── the facts, each read from the table that owns it ──────────────────

  -- §13.4 Commercial: the exact accepted version. `accepted` is terminal, so
  -- a re-quoted, re-accepted deal has more than one, and the synthesis found
  -- two selectors in this repository disagreeing about which (the gate:
  -- decided_at desc; conversion: version desc). The gate now uses conversion's.
  -- At the win — the trigger's call — there is no project, and the latest
  -- accepted version is the answer, by the same selector; a project named on
  -- the call (a repair run after a lost trigger) supplies its own.
  if v_project.proposal_id is not null then
    select p.* into v_proposal
      from sales.proposals p
     where p.id = v_project.proposal_id
       and p.opportunity_id = v_opp.id
       and p.status = 'accepted';
  end if;
  if v_proposal.id is null then
    select p.* into v_proposal
      from sales.proposals p
     where p.opportunity_id = v_opp.id
       and p.status = 'accepted'
     order by p.version desc
     limit 1;
  end if;

  if v_proposal.id is not null then
    -- §13.4 Approval: the decision that authorized THIS version. A standalone
    -- quotation carries its approval id; a plan-set member does not — the set
    -- was approved once, on the recommended plan, and the id sits on the set
    -- (sync_plan_set_decision). The synthesis caught the first draft listing
    -- 'approval' as absent for every 3-plan deal, which was a false absence.
    if v_proposal.approval_request_id is not null then
      select a.* into v_approval
        from approvals.approval_requests a
       where a.id = v_proposal.approval_request_id;
    elsif v_proposal.plan_set_id is not null then
      select a.* into v_approval
        from sales.proposal_plan_sets ps
        join approvals.approval_requests a on a.id = ps.approval_request_id
       where ps.id = v_proposal.plan_set_id
         and ps.organization_id = v_opp.organization_id;
    end if;
    -- §13.4 Requirements: the exact version this quotation was priced against.
    if v_proposal.requirement_version_id is not null then
      select r.* into v_requirement
        from crm.requirement_versions r
       where r.id = v_proposal.requirement_version_id;
    end if;
  end if;

  -- §13.4 Lead/client, and Doc 09 §33's context: who, in what language, with
  -- what standing consent, and which thread the summary belongs to.
  if v_opp.lead_id is not null then
    select l.* into v_lead from crm.leads l where l.id = v_opp.lead_id;
  end if;
  if v_lead.contact_id is not null then
    select c.* into v_contact from crm.contacts c where c.id = v_lead.contact_id;
  end if;
  if v_opp.lead_id is not null then
    select cv.id into v_conversation
      from crm.conversations cv
     where cv.lead_id = v_opp.lead_id
     order by cv.created_at desc
     limit 1;
  end if;
  if v_conversation is not null then
    select s.through_seq into v_summary_seq
      from crm.conversation_summaries s
     where s.conversation_id = v_conversation;
  end if;
  if v_contact.id is not null then
    select cc.status into v_consent
      from crm.communication_consent cc
     where cc.organization_id = v_opp.organization_id
       and cc.contact_id = v_contact.id
       and cc.channel = 'whatsapp';
  end if;
  -- Doc 09 §33: "trust concerns". The rows, not a paraphrase of them.
  if v_opp.lead_id is not null then
    select coalesce(array_agg(ob.id order by ob.created_at), '{}'::uuid[])
      into v_trust
      from sales.objections ob
     where ob.lead_id = v_opp.lead_id
       and ob.kind = 'trust';
  end if;

  -- §13.4 Payment/exception: the configured verification reference. What the
  -- gate says AT THIS MOMENT, and whether the switch that would demand
  -- payment evidence is on — so a reader knows which rule the deal closed
  -- under, not merely that it closed.
  select o.settings->>'won_requires_payment_evidence' into v_switch
    from core.organizations o
   where o.id = v_opp.organization_id;
  v_verdict := sales.won_gate_verdict(v_opp.id);

  -- When the switch is on and the gate passed, WHAT passed it. The synthesis
  -- found the first draft recording the rule the deal closed under and not the
  -- evidence — and §13.4 asks for "the configured verification reference".
  -- Same two forms the gate itself accepts, read the same way; the exception
  -- first because it names this exact version.
  if v_switch = 'on' and v_verdict is null and v_proposal.id is not null then
    select jsonb_build_object('kind', 'payment_exception', 'approval_id', a.id, 'decided_at', a.decided_at)
      into v_payment_evidence
      from approvals.approval_requests a
     where a.organization_id = v_opp.organization_id
       and a.subject_type = 'proposal' and a.subject_id = v_proposal.id
       and a.state = 'approved'
       and coalesce(a.payload->>'kind', '') = 'payment_exception'
     order by a.decided_at desc
     limit 1;
    -- The client the GATE keys on: the deal's own account, which a returning
    -- client has at the win; the project's is null on the trigger path.
    if v_payment_evidence is null and coalesce(v_project.client_account_id, v_opp.client_account_id) is not null then
      select jsonb_build_object('kind', 'captured_payment', 'payment_id', pay.id, 'invoice_id', inv.id,
                                'amount_minor', pay.amount_minor, 'captured_at', pay.captured_at)
        into v_payment_evidence
        from finance.payments pay
        join finance.invoices inv on inv.id = pay.invoice_id
       where inv.organization_id = v_opp.organization_id
         and inv.client_account_id = coalesce(v_project.client_account_id, v_opp.client_account_id)
         and pay.status = 'captured'
       order by pay.captured_at desc nulls last
       limit 1;
    end if;
  end if;

  -- ── what is ABSENT, by name (ADM-72) ──────────────────────────────────
  if v_proposal.id is null then v_unresolved := v_unresolved || '"accepted_quotation"'::jsonb; end if;
  if v_requirement.id is null then v_unresolved := v_unresolved || '"requirement_version"'::jsonb; end if;
  -- A version that exists but was never accepted is carried by reference AND
  -- named: draft_proposal stores p_requirement_version_id verbatim and checks
  -- nothing about it, so "exact APPROVED requirement version" is not a
  -- guarantee this row can give — only a fact it can report.
  if v_requirement.id is not null and v_requirement.status <> 'accepted' then
    v_unresolved := v_unresolved || '"requirement_version_not_accepted"'::jsonb;
  end if;
  if v_approval.id is null then v_unresolved := v_unresolved || '"approval"'::jsonb; end if;
  if v_contact.id is null then v_unresolved := v_unresolved || '"contact"'::jsonb; end if;
  -- §13.4 Acceptance: "authorized actor". record_proposal_response takes the
  -- contact as optional, so an acceptance can exist with nobody named on it.
  -- Carried as it is, and named as weak.
  if v_proposal.id is not null and v_proposal.responded_by_contact_id is null then
    v_unresolved := v_unresolved || '"acceptance_actor"'::jsonb;
  end if;
  if v_summary_seq is null then v_unresolved := v_unresolved || '"conversation_summary"'::jsonb; end if;
  if v_switch = 'on' and v_verdict is not null then v_unresolved := v_unresolved || '"payment_evidence"'::jsonb; end if;

  -- ── the handoff ───────────────────────────────────────────────────────
  --
  -- References, never copied prose — the table's own rule. A receiver reads
  -- the current facts through its own RLS rather than a sender's snapshot.
  insert into ai.handoffs (
    organization_id, correlation_id, from_agent, to_agent, status,
    project_id, subject_type, subject_id, objective, requested_action,
    context, requirements, artifacts, decisions, constraints, state, unresolved
  ) values (
    v_opp.organization_id, v_correlation, 'sales', 'project_manager', 'queued',
    v_project.id, 'opportunity', v_opp.id,
    'Onboard the won deal: ' || v_opp.name,
    'onboard',
    jsonb_strip_nulls(jsonb_build_object(
      'opportunity_id',    v_opp.id,
      'lead_id',           v_opp.lead_id,
      'contact_id',        v_contact.id,
      'client_account_id', coalesce(v_project.client_account_id, v_opp.client_account_id),
      'project_id',        v_project.id,
      'owner_id',          v_opp.owner_id,
      'language',          v_contact.preferred_language,
      'conversation_id',   v_conversation,
      'summary_through_seq', v_summary_seq,
      'whatsapp_consent',  v_consent
    )),
    case when v_requirement.id is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
      'requirement_version_id', v_requirement.id,
      'status',                 v_requirement.status
    )) end,
    case when v_proposal.id is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
      'kind',        'proposal',
      'proposal_id', v_proposal.id,
      'version',     v_proposal.version,
      'total_minor', v_proposal.total_minor,
      'currency',    v_proposal.currency,
      'sent_at',     v_proposal.sent_at,
      'sent_message_ref', v_proposal.sent_message_ref
    )) end,
    -- coalesce: jsonb_agg over zero rows is NULL, and the column is NOT NULL.
    -- A deal with neither an approval nor a proposal (an ADM-72 project) is
    -- exactly the row that would otherwise fail here, which is exactly the row
    -- whose absences the packet exists to record.
    coalesce((select jsonb_agg(d) from (
      select jsonb_strip_nulls(jsonb_build_object(
        'kind', 'approval', 'approval_id', v_approval.id, 'state', v_approval.state,
        'decided_at', v_approval.decided_at, 'decided_by', v_approval.decided_by,
        'approved_by_name', v_proposal.approved_by_name, 'approved_by_role', v_proposal.approved_by_role
      )) as d where v_approval.id is not null
      union all
      select jsonb_strip_nulls(jsonb_build_object(
        'kind', 'acceptance', 'proposal_id', v_proposal.id,
        'decided_at', v_proposal.decided_at, 'responded_by_contact_id', v_proposal.responded_by_contact_id,
        'has_note', v_proposal.response_note is not null
      )) where v_proposal.id is not null
    ) x), '[]'::jsonb),
    jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object(
        'kind', 'payment_gate',
        'requires_payment_evidence', coalesce(v_switch, 'off'),
        'verdict_at_handoff', v_verdict,
        'evidence', v_payment_evidence
      )),
      jsonb_build_object('kind', 'trust_concerns', 'objection_ids', to_jsonb(coalesce(v_trust, '{}'::uuid[])))
    ),
    jsonb_build_object('won_at', v_opp.closed_at, 'recorded_at', clock_timestamp()),
    v_unresolved
  )
  returning id into v_id;

  -- Doc 09 §33: a real workflow event. Declared above; no subscriber while
  -- Phase 2 is not activated, and that is the design rather than an omission.
  perform core.emit_event(
    v_opp.organization_id, 'opportunity.handed_off', 'opportunity', v_opp.id,
    jsonb_strip_nulls(jsonb_build_object(
      'handoff_id', v_id, 'project_id', v_project.id, 'proposal_id', v_proposal.id,
      'requirement_version_id', v_requirement.id, 'unresolved', v_unresolved
    )),
    v_correlation
  );

  -- §13.4 field 9: the audit row joins the trail the handoff row and the outbox
  -- event already share, so the three are one story under one correlation id.
  perform core.record_audit(
    v_opp.organization_id, 'opportunity.handed_off', 'opportunity', v_opp.id,
    null,
    jsonb_build_object('handoff_id', v_id, 'project_id', v_project.id, 'unresolved', v_unresolved),
    v_correlation
  );

  return query select 'recorded'::text, v_id;

exception
  -- handoffs_won_handoff_key, when two conversions of one deal pass the
  -- pre-check at once. The answer is the row the other one wrote.
  when unique_violation then
    select h.* into v_existing
      from ai.handoffs h
     where h.organization_id = v_opp.organization_id
       and h.subject_type = 'opportunity' and h.subject_id = v_opp.id
       and h.from_agent = 'sales' and h.to_agent = 'project_manager';
    return query select 'already_recorded'::text, v_existing.id;
end;
$function$;

CREATE OR REPLACE FUNCTION sales.set_approved_offer(p_organization_id uuid, p_label text, p_condition text, p_discount_pct integer, p_valid_until date DEFAULT NULL::date)
 RETURNS TABLE(outcome text, offer_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_id    uuid;
  v_cap   numeric;
begin
  if v_actor is not null and not coalesce((select core.is_owner()), false) then
    return query select 'forbidden'::text, null::uuid;
    return;
  end if;

  -- The INPUT is judged before the caller is resolved, so a bad date reports
  -- itself as a bad date. The first version checked the author first and
  -- answered `no_author` to an expired offer, which is a true statement about
  -- a different problem.
  --
  -- An offer that has already expired is a mistake, not a configuration.
  if p_valid_until is not null and p_valid_until < current_date then
    return query select 'already_expired'::text, null::uuid;
    return;
  end if;

  -- G-195. Unconfigured, the DDL's 1-50 is the only bound and this is a no-op.
  select nullif(o.settings->>'negotiation_max_discount_pct', '')::numeric into v_cap
    from core.organizations o
   where o.id = p_organization_id;
  if v_cap is not null and p_discount_pct > v_cap then
    return query select 'above_configured_cap'::text, null::uuid;
    return;
  end if;

  /**
   * An author is required, and there is no sensible fallback: the whole point
   * of the row is whose decision it carries.
   *
   * A signed-in owner names themselves. An identity-less caller — the service
   * role, the verification scripts — falls back to the organization's owner
   * MEMBERSHIP, which is what binds a person to an organization (core.users is
   * global and carries no organization at all). An organization with no owner
   * yet cannot author an offer, and says so rather than writing one nobody
   * decided.
   */
  if v_actor is null then
    select m.user_id into v_actor
      from core.memberships m
     where m.organization_id = p_organization_id and m.role = 'owner'
     order by m.created_at
     limit 1;
  end if;
  if v_actor is null then
    return query select 'no_author'::text, null::uuid;
    return;
  end if;

  -- Retire the standing one first. Not deleted: a concession that was once
  -- made is part of the record of what this agency offered.
  perform set_config('sales.offer_write', 'on', true);

  update sales.approved_offers
     set active = false
   where organization_id = p_organization_id and active;

  insert into sales.approved_offers (
    organization_id, label, condition, discount_pct, valid_until, created_by
  )
  values (
    p_organization_id, btrim(p_label), btrim(p_condition), p_discount_pct, p_valid_until, v_actor
  )
  returning id into v_id;

  perform core.record_audit(
    p_organization_id, 'offer.authorised', 'approved_offer', v_id,
    null,
    jsonb_build_object('label', btrim(p_label), 'discount_pct', p_discount_pct, 'valid_until', p_valid_until),
    null
  );

  return query select 'set'::text, v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION sales.set_payment_structure(p_organization_id uuid, p_name text, p_milestones jsonb, p_min_amount_minor bigint DEFAULT NULL::bigint, p_max_amount_minor bigint DEFAULT NULL::bigint)
 RETURNS TABLE(outcome text, structure_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_actor  uuid := (select auth.uid());
  v_id     uuid;
  v_total  numeric := 0;
  v_count  int;
  v_row    jsonb;
  v_pos    int := 0;
begin
  if v_actor is not null and not coalesce((select core.is_owner()), false) then
    return query select 'forbidden'::text, null::uuid;
    return;
  end if;

  if jsonb_typeof(p_milestones) <> 'array' then
    return query select 'invalid_milestones'::text, null::uuid;
    return;
  end if;

  select count(*) into v_count from jsonb_array_elements(p_milestones);
  if v_count < 1 or v_count > 8 then
    -- One is a real schedule — "everything up front" — and eight is past any
    -- schedule a client will read. Both bounds are here rather than in the
    -- form so a direct call cannot write a thirty-milestone document.
    return query select 'invalid_milestones'::text, null::uuid;
    return;
  end if;

  for v_row in select * from jsonb_array_elements(p_milestones) loop
    if jsonb_typeof(v_row->'pct') <> 'number'
       or coalesce(btrim(v_row->>'label'), '') = ''
       or length(btrim(v_row->>'label')) > 120
       or (v_row->>'pct')::numeric <= 0
       or (v_row->>'pct')::numeric > 100 then
      return query select 'invalid_milestones'::text, null::uuid;
      return;
    end if;
    v_total := v_total + (v_row->>'pct')::numeric;
  end loop;

  -- Reported as its own outcome rather than left to the deferred trigger: a
  -- person who typed 30/30/30 deserves to be told the total is ninety, not to
  -- be handed a constraint violation at commit.
  if v_total <> 100 then
    return query select 'does_not_sum'::text, null::uuid;
    return;
  end if;

  if p_min_amount_minor is not null and p_max_amount_minor is not null
     and p_min_amount_minor >= p_max_amount_minor then
    return query select 'invalid_band'::text, null::uuid;
    return;
  end if;

  perform set_config('sales.payment_write', 'on', true);

  select s.id into v_id
    from sales.payment_structures s
   where s.organization_id = p_organization_id and s.name = btrim(p_name);

  if v_id is null then
    insert into sales.payment_structures (
      organization_id, name, min_amount_minor, max_amount_minor, created_by
    )
    values (p_organization_id, btrim(p_name), p_min_amount_minor, p_max_amount_minor, v_actor)
    returning id into v_id;
  else
    update sales.payment_structures
       set min_amount_minor = p_min_amount_minor,
           max_amount_minor = p_max_amount_minor,
           active = true
     where id = v_id;
    -- Qualified, because this function's own OUT parameter is called
    -- `structure_id`: an unqualified reference is ambiguous and PL/pgSQL
    -- refuses it at CALL time, not at creation — so the first save worked and
    -- every later one answered 42702.
    delete from sales.payment_milestones m where m.structure_id = v_id;
  end if;

  for v_row in select * from jsonb_array_elements(p_milestones) loop
    insert into sales.payment_milestones (organization_id, structure_id, position, label, pct)
    values (p_organization_id, v_id, v_pos, btrim(v_row->>'label'), (v_row->>'pct')::numeric);
    v_pos := v_pos + 1;
  end loop;

  perform core.record_audit(
    p_organization_id, 'payment_structure.set', 'payment_structure', v_id,
    null,
    jsonb_build_object('name', btrim(p_name), 'milestones', p_milestones,
                       'min_amount_minor', p_min_amount_minor, 'max_amount_minor', p_max_amount_minor),
    null
  );

  return query select 'set'::text, v_id;
end;
$function$;

-- ── the standing check ─────────────────────────────────────────────────

create or replace function core.fail_open_authority_guards()
returns table (
  schema_name   text,
  function_name text,
  arguments     text,
  occurrences   int
)
language sql
stable
security definer
set search_path = ''
as $$
  -- The four predicates that can be NULL, because each is
  -- `core.current_user_role() in (...)` and the role can be absent. Both
  -- spellings are caught: the bare call, and the one wrapped in a scalar
  -- subquery.
  --
  -- It scans the WHOLE body, comments included, and the first draft of this
  -- function failed its own check for exactly that reason: the comment here
  -- used to spell out the bad form as an example, and the scan found it. That
  -- is the right behaviour kept rather than worked around — a comment quoting
  -- an uncoalesced guard is itself worth rewording, and narrowing the scan to
  -- exclude comments would hide a guard somebody commented out and left.
  select n.nspname::text,
         p.proname::text,
         pg_catalog.pg_get_function_identity_arguments(p.oid),
         (select count(*)::int
            from pg_catalog.regexp_matches(
              p.prosrc,
              'not\s+(\(\s*select\s+)?core\.(is_admin|is_owner|can_write|is_internal)\s*\(', 'g'))
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname not in ('pg_catalog', 'information_schema')
     and p.prosrc ~ 'not\s+(\(\s*select\s+)?core\.(is_admin|is_owner|can_write|is_internal)\s*\('
   order by 1, 2, 3;
$$;

comment on function core.fail_open_authority_guards() is
  'G-281. Every function whose body negates a role predicate WITHOUT coalescing it. `not NULL` is NULL and plpgsql''s `if` does not execute a NULL condition, so such a guard falls through instead of refusing when the access token carries no role. Empty is the only acceptable answer, and a live verification says so in CI.';

revoke all on function core.fail_open_authority_guards() from public, anon;
grant execute on function core.fail_open_authority_guards() to authenticated, service_role;

notify pgrst, 'reload schema';
