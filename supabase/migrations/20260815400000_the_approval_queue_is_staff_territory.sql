-- ═══════════════════════════════════════════════════════════════════════════
-- The approval queue is staff-and-agent territory — a client cannot raise into it.
--
-- approvals.request_approval is SECURITY DEFINER and granted to authenticated,
-- and its only gate was tenant (G-084's org check). Its siblings in this exact
-- class each got an authority check too — decide_approval (owner/ops_admin/
-- delivery_lead) and cancel_request (#…220000, owner/ops_admin) — but
-- request_approval was left with the tenant gate alone. A client (the lowest-
-- privilege portal role) passes that gate — its JWT names the agency org — so it
-- could, over the Data API, insert a row into approvals.approval_requests (a
-- table it can neither select nor write directly), forge requested_by_id (no FK),
-- flood the queue past the one-pending-per-subject index (a DoS on the approval
-- centre), and — with p_audience='internal' — emit its own p_summary text into
-- the agency's internal WhatsApp group through the announcement. Within-tenant
-- and conferring no authority (a client still cannot approve anything), but an
-- unauthorized write + content-injection + queue-flood by the lowest role.
--
-- Both functions get the missing role gate, in the shape each already uses for
-- its service-role exemption: a caller WITH an identity must be core.is_internal()
-- (owner/ops_admin/delivery_lead/member/contractor); a caller with none (the
-- service role running a job or an agent) is exempt, so agent- and job-raised
-- approvals are untouched. resolve_policy (the config read request_approval calls,
-- and the audit's LOW: a client could read its agency's policy config directly)
-- gets the same, as a WHERE clause. Both reproduced verbatim + the injected gate.
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
  if v_actor is not null and not (select core.is_internal()) then
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

CREATE OR REPLACE FUNCTION approvals.resolve_policy(p_organization_id uuid, p_subject_type text, p_amount_minor bigint DEFAULT NULL::bigint)
 RETURNS approvals.approval_policies
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select *
    from approvals.approval_policies
   where organization_id = p_organization_id
     -- A session caller may resolve only their own org; the service role,
     -- whose current_organization_id() is null, is unrestricted.
     and (core.current_organization_id() is null
          or core.current_organization_id() = p_organization_id)
     -- …and a session caller must be internal to read policy config at all: a
     -- client's current_organization_id() is its agency's, so the tenant clause
     -- alone let it read the queue's config. The service role (null org) is
     -- unrestricted, exactly as above.
     and (core.current_organization_id() is null or core.is_internal())
     and subject_type    = p_subject_type
     and active
     and min_amount_minor <= coalesce(p_amount_minor, 0)
   order by min_amount_minor desc
   limit 1;
$function$;
