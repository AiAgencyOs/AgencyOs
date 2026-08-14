-- ═══════════════════════════════════════════════════════════════════════════
-- A quotation that went cold says so.
--
-- Gap G-111. Decision ADM-71 granted (expiry becomes a persisted state,
-- `sent` → `lapsed`). Decisions ADM-77, ADM-78 and ADM-79 were the three
-- consequences that granting it exposed, and all three are now **delegated
-- decisions** taken under the owner's standing authorization, recorded in the
-- governance record with their reasoning.
--
-- ── ADM-77: a lapsed quotation may still be DECLINED ─────────────────────
--
-- `record_proposal_response` already accepted a refusal after the validity
-- date and refused only acceptance, deliberately — that is what a validity
-- period *is*. It bounds what a client may say yes to, not whether they may
-- say no.
--
-- Persisting the lapse would have removed that **silently**, because the
-- `not_sent` guard runs before the validity check: the moment the row read
-- `lapsed`, a decline came back `not_sent`. The client's ability to answer
-- would have disappeared as a side effect of a bookkeeping change nobody
-- connected to it.
--
-- So `lapsed` is admitted to the answerable set, and acceptance is refused
-- there for the same reason it was refused before.
--
-- ── ADM-78: lapsed is terminal, with two named exits ─────────────────────
--
-- **Not extendable and not revivable.** Both would mean editing a validity
-- date that has already passed, and a date that moves is a date that was never
-- a commitment. The record would then disagree with what the client was
-- actually told.
--
-- The two exits are the ones that need no invention:
--
--   `lapsed → rejected`    the client declines (ADM-77)
--   `lapsed → superseded`  a new version replaces it
--
-- To re-offer, issue a new version. That already works, leaves the original
-- intact, and is auditable — where reviving would overwrite the only evidence
-- of what expired.
--
-- ── ADM-79: internal only, and nothing is sent ───────────────────────────
--
-- Nobody is notified automatically, and no notification machinery is added.
--
-- Telling a client their offer expired is a **sales action a human takes**,
-- with a judgement about whether to re-offer, discount or let it go. An
-- automated message would also be client-facing communication, and the consent
-- policy governing that is ADM-81 — still open. Building a sender now would
-- either pre-empt that decision or quietly widen it.
--
-- Internally nothing needs sending either: the status change *is* the signal.
-- `proposals_live_version_key` stops counting the row as live, so a queue of
-- outstanding quotations stops showing it — which is the whole complaint
-- G-111 was raised about.
--
-- ── what leaving the live set means, and why it is not a new decision ────
--
-- `proposals_live_version_key` defines live as a version "still on its way to
-- an answer". A lapsed quote is not, so it leaves the live set and frees the
-- deal for a new quotation without superseding anything. That follows from the
-- index's own recorded rationale rather than from anything decided here.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the state ────────────────────────────────────────────────────────────

alter table sales.proposals drop constraint if exists proposals_status_check;
alter table sales.proposals add constraint proposals_status_check
  check (status in (
    'draft', 'pending_approval', 'approved', 'sent',
    'accepted', 'rejected', 'superseded',
    -- Sent, and its validity date passed without an answer. Distinct from
    -- `rejected`, which is an answer, and from `superseded`, which is a
    -- replacement — conflating any of the three would lose why the row ended.
    'lapsed'
  ));

comment on column sales.proposals.status is
  'draft, pending_approval, approved, sent, accepted, rejected, superseded, lapsed. lapsed means sent and its validity date passed unanswered (G-111, ADM-71): terminal except that a client may still decline it (ADM-77) and a new version may supersede it (ADM-78). Never extended or revived - a validity date that moves was never a commitment.';

-- ── the sweep ────────────────────────────────────────────────────────────
--
-- Shaped exactly like `approvals.expire_overdue`, which solves the same
-- problem for approvals: a bounded batch, `for update skip locked` so two
-- ticks never fight, and the row returned so the caller can log each one.
-- A second shape for the same job would be a second thing to reason about.

create or replace function sales.lapse_overdue_proposals(p_limit int default 50)
returns table (lapsed_id uuid, opportunity_id uuid, organization_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  for v_row in
    select p.id, p.opportunity_id, p.organization_id, p.version, p.total_minor, p.currency
      from sales.proposals p
     where p.status = 'sent'
       and p.valid_until is not null
       -- Strictly past. A quotation is valid *through* its last day, which is
       -- the same comparison `record_proposal_response` already makes — the
       -- two must agree or a quote could be unacceptable and not yet lapsed.
       and p.valid_until < (clock_timestamp() at time zone 'utc')::date
     order by p.valid_until
     limit p_limit
     for update skip locked
  loop
    update sales.proposals
       set status = 'lapsed'
     where sales.proposals.id = v_row.id;

    -- Emitted so the lapse is auditable and observable, NOT so that anything
    -- sends. ADM-79: no automated client-facing notification exists, and this
    -- event has no client-facing consumer.
    perform core.emit_event(
      v_row.organization_id, 'proposal.lapsed', 'proposal', v_row.id,
      jsonb_build_object(
        'opportunityId', v_row.opportunity_id,
        'version', v_row.version,
        'totalMinor', v_row.total_minor,
        'currency', v_row.currency
      )
    );

    lapsed_id := v_row.id;
    opportunity_id := v_row.opportunity_id;
    organization_id := v_row.organization_id;
    return next;
  end loop;
end;
$$;

comment on function sales.lapse_overdue_proposals(int) is
  'Moves sent quotations past their validity date to lapsed (G-111, ADM-71). Shaped like approvals.expire_overdue: bounded batch, for update skip locked so two ticks never fight. Emits proposal.lapsed for audit and observability - ADM-79 adds no automated client-facing notification, and this event has no client-facing consumer.';

revoke all on function sales.lapse_overdue_proposals(int) from public;
grant execute on function sales.lapse_overdue_proposals(int) to service_role;

-- ── answering a quotation that lapsed ────────────────────────────────────
--
-- Regenerated from the live definition with two changes and nothing else:
-- `lapsed` joins the answerable set, and the refusal for an unanswerable row
-- stops claiming the quote was never sent.

create or replace function sales.record_proposal_response(
  p_proposal_id uuid,
  p_response text,
  p_contact_id uuid default null::uuid,
  p_note text default null::text
)
returns table (outcome text, status text, decided_at timestamptz)
language plpgsql
set search_path to ''
as $function$
declare
  v_row sales.proposals;
  v_now timestamptz := clock_timestamp();
begin
  if p_response not in ('accepted', 'rejected') then
    return query select 'invalid_response'::text, null::text, null::timestamptz;
    return;
  end if;

  select p.* into v_row
    from sales.proposals p
   where p.id = p_proposal_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::text, null::timestamptz;
    return;
  end if;

  -- ADM-77. `lapsed` is answerable: the quote WAS sent, and its date passing
  -- bounds what may be accepted rather than whether the client may reply.
  --
  -- The outcome is `not_answerable` rather than `not_sent`. A lapsed row was
  -- sent, so `not_sent` was about to become false of exactly the rows this
  -- change creates — the same defect class as G-101's refusal reason and the
  -- ADM-74 announcement line, both of which told somebody something untrue.
  if v_row.status not in ('sent', 'lapsed') then
    return query select 'not_answerable'::text, v_row.status, null::timestamptz;
    return;
  end if;

  -- §15's validity period, enforced where it means something. A quote whose
  -- date has passed cannot be *accepted* - that is what a validity period is -
  -- but it can still be refused. Checked against the date as well as the
  -- status, because a row can be past its date before the sweep has run.
  if p_response = 'accepted'
     and v_row.valid_until is not null
     and v_row.valid_until < (v_now at time zone 'utc')::date
  then
    return query select 'expired'::text, v_row.status, null::timestamptz;
    return;
  end if;

  update sales.proposals
     set status                  = p_response,
         decided_at              = v_now,
         responded_by_contact_id = coalesce(p_contact_id, sales.proposals.responded_by_contact_id),
         response_note           = coalesce(p_note, sales.proposals.response_note)
   where sales.proposals.id = v_row.id;

  perform core.emit_event(
    v_row.organization_id, 'proposal.' || p_response, 'proposal', v_row.id,
    jsonb_build_object(
      'opportunityId', v_row.opportunity_id,
      'version', v_row.version,
      'totalMinor', v_row.total_minor,
      'currency', v_row.currency,
      'contactId', p_contact_id
    )
  );

  return query select 'recorded'::text, p_response, v_now;
end;
$function$;

comment on function sales.record_proposal_response(uuid, text, uuid, text) is
  'Records a client answer to a quotation. A lapsed quotation may still be DECLINED (ADM-77) - the validity period bounds acceptance, not the right to reply - and acceptance past the date is refused whether or not the sweep has run yet. Returns not_answerable rather than not_sent, because a lapsed row WAS sent.';
