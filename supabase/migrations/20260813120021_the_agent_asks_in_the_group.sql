-- ═══════════════════════════════════════════════════════════════════════════
-- The agent asks in the group.
--
-- Gap G-110, decision ADM-11. G-109 built the channel and left both halves
-- sitting next to each other: the internal group is a conversation
-- `crm.send_outbound_message` can already post into, and
-- `approvals.approval_requests` holds what needs answering. Nothing joined
-- them, so the queue the Admin was promised existed only on a web page.
--
-- ── what goes there, and who decided ──────────────────────────────────────
--
-- docs/business-os/02-business-rules.md §5.1 is unusually specific, so nothing
-- here is invented: *"The internal group is an approval channel, not a chat
-- log. What the agent brings there: payment confirmations, anything carrying a
-- price or discount, delivery approvals (UI designs, prototypes, builds), QA
-- and production-ready sign-off, project starts against unmet conditions, and
-- refunds."*
--
-- That list is the approval engine's subject types, in different words. So the
-- rule this implements is simply: **an internal-audience approval request is
-- announced in the internal group.** Client-audience requests are not — those
-- are the client's decision, recorded by staff with evidence (ADM-08d), and
-- posting them internally would turn the approval channel back into the chat
-- log §5.1 says it is not.
--
-- ── the reference, and the problem it does not solve ──────────────────────
--
-- Each request gets a short code. A reply naming that code is correlated to
-- that request — not "the most recent pending one", which is wrong precisely
-- when it matters: §5.1 routes six kinds of approval through one group, so two
-- outstanding requests is the ordinary case, and a bare "approved" landing on
-- the wrong subject would settle a money decision against the wrong thing.
--
-- **A reply does not settle anything, and that is deliberate.** The engine
-- refuses a decision with no `auth.uid()` — directive §29, and the one rule
-- that stops an automation approving its own work. A WhatsApp sender is a
-- phone number; `core.users` has no phone, nothing verifies one, and the
-- number is spoofable at the provider boundary. Wiring a reply straight into
-- `decide_approval` would mean inventing a trust link between a phone and a
-- role, which is exactly the kind of thing ADM-08 built the snapshot-and-lock
-- to prevent.
--
-- ── and the reply half is not built, for a second reason ─────────────────
--
-- A correlation table and a matcher were written for this migration and then
-- **removed before it was committed**, because they had no possible producer.
-- `crm.ingest_whatsapp_message` always creates a `direct` conversation keyed
-- to a lead and a contact; it has no notion of a group at all. An inbound
-- message to the internal group would be filed as a new *lead* for whichever
-- staff member sent it, and would never reach a matcher expecting
-- `kind = 'internal_group'`.
--
-- G-109 built groups as an outbound channel only. Inbound group ingest is
-- **G-115**, and shipping a matcher that nothing could ever call would be the
-- tables-with-no-code state G-011 existed to fix — three weeks after fixing
-- it.
--
-- **ADM-65** is the other half of that question and the harder one: how does a
-- WhatsApp reply become an *authenticated* decision at all? No code is written
-- for it until it is answered.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. The reference
-- ═══════════════════════════════════════════════════════════════════════════

alter table approvals.approval_requests
  add column if not exists reference text;

-- Unique per organization across every request, settled or not — not only
-- among pending ones. A code that is recycled the moment its request settles
-- would make a late reply ("sorry, yes, approve A7C2") land on a different
-- decision entirely, which is the same class of error as matching on
-- most-recent-pending.
create unique index if not exists approval_requests_reference_key
  on approvals.approval_requests (organization_id, reference)
  where reference is not null;

comment on column approvals.approval_requests.reference is
  'The short code a person types in the internal WhatsApp group to name this request (G-110). Unique per organization forever, not merely among pending requests: a recycled code would make a late reply land on a different decision.';

/**
 * A short code somebody can read off a phone screen and type back.
 *
 * The alphabet drops 0/O, 1/I/L and U: the first two are the misreadings that
 * actually happen on a small screen, and the third keeps the generator from
 * spelling anything the Admin would rather it did not. Six characters over 29
 * symbols is ~594 million codes, so a collision inside one organization is a
 * retry rather than a design problem.
 */
create or replace function approvals.new_reference()
returns text
language sql
volatile
security invoker
set search_path = ''
as $$
  select string_agg(
    substr('ABCDEFGHJKMNPQRSTVWXYZ23456789', 1 + floor(random() * 29)::int, 1),
    ''
  )
  from generate_series(1, 6);
$$;

comment on function approvals.new_reference() is
  'A six-character code for the internal group, over an alphabet with the characters people misread on a phone removed.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Raising a request announces it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `request_approval` carried forward **from its own and only definition**
-- (20260812120011) with three marked additions: the reference, the event, and
-- nothing else. Regenerating a function from an older migration than the one
-- that last changed it is how D16 was silently reverted, so the provenance is
-- stated rather than assumed.

create or replace function approvals.request_approval(
  p_organization_id   uuid,
  p_subject_type      text,
  p_subject_id        uuid,
  p_requested_by_type text,
  p_requested_by_id   uuid default null,
  p_summary           text default null,
  p_payload           jsonb default null,
  p_amount_minor      bigint default null,
  p_audience          text default null,
  p_correlation_id    uuid default null
)
returns table (
  -- 'requested' | 'already_pending' | 'no_policy' | 'forbidden'
  outcome        text,
  request_id     uuid,
  state          text,
  required_role  text,
  sla_due_at     timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
$$;

comment on function approvals.request_approval(uuid, text, uuid, text, uuid, text, jsonb, bigint, text, uuid) is
  'Raises one approval request, or answers with the pending one that already exists. SECURITY DEFINER because the table takes no direct writes; a caller with an identity is bound to its own organization, and only an identity-less caller (the job runner, an agent) may name one. An internal-audience request also emits approval.requested, which is what announces it in the internal WhatsApp group (G-110).';

revoke all on function approvals.new_reference() from public;
grant execute on function approvals.new_reference() to authenticated, service_role;
