-- A payment claim can be sent back for more evidence, and a verification stays
-- what it was (PDF gap W1; SCR-054 "REJECT / NEED MORE EVIDENCE" and the
-- guardrail "verification actor, timestamp and evidence reference are
-- immutable audit data").
--
-- 1. A new claim status, `evidence_requested`, and the note that says what is
--    missing (`evidence_request_note`). It is not a decision: like `mismatch`
--    it is a state the claim leaves when somebody answers it, so it is still
--    decidable (confirm / reject / mismatch) and never settled.
--
-- 2. `finance.request_payment_evidence(claim, note)` — the one door into it.
--    Owner / ops_admin only, a note is required ("need what?"), refused on a
--    claim already verified or rejected, audited.
--
-- 3. The guard learns the immutability the PDF states. Until now a verified or
--    rejected claim could not change STATUS, but its `verified_by`,
--    `verified_at`, `verification_evidence` and `rejected_reason` could be
--    rewritten by an owner's direct update. They are frozen once the claim is
--    settled.
--
-- Redefines payment_submissions_guard and verify_payment_submission from their
-- latest bodies (20260821250000 + G-271); only the `evidence_requested`
-- handling and the frozen fields are added. Idempotent.

alter table finance.payment_submissions add column if not exists evidence_request_note text;

alter table finance.payment_submissions drop constraint if exists payment_submissions_status_check;
alter table finance.payment_submissions
  add constraint payment_submissions_status_check
  check (status = any (array['pending_verification', 'verified', 'rejected', 'mismatch', 'partially_verified', 'duplicate', 'refunded', 'evidence_requested']));

alter table finance.payment_submissions drop constraint if exists payment_submissions_evidence_request_says_what;
alter table finance.payment_submissions
  add constraint payment_submissions_evidence_request_says_what
  check (status <> 'evidence_requested' or (evidence_request_note is not null and length(btrim(evidence_request_note)) > 0));

comment on column finance.payment_submissions.evidence_request_note is
  'What a reviewer asked for when sending the claim back (status evidence_requested). Kept after the claim is answered.';

create or replace function finance.payment_submissions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  -- 1. A claim is what was claimed.
  if new.invoice_id         is distinct from old.invoice_id
     or new.amount_minor    is distinct from old.amount_minor
     or new.currency        is distinct from old.currency
     or new.method          is distinct from old.method
     or new.reference       is distinct from old.reference
     or new.submitted_by    is distinct from old.submitted_by
     or new.submitted_by_agent is distinct from old.submitted_by_agent
     or new.submitted_at    is distinct from old.submitted_at
  then
    raise exception 'a payment claim is what was claimed; record a new one rather than editing this one'
      using errcode = 'restrict_violation';
  end if;

  -- 2. A settled claim is settled. `mismatch` and `evidence_requested` are
  --    states a claim may still move out of; verified and rejected are final.
  if old.status not in ('pending_verification', 'mismatch', 'evidence_requested')
     and new.status is distinct from old.status then
    raise exception 'payment claim is already %', old.status
      using errcode = 'restrict_violation';
  end if;

  -- 2b. The verification record is immutable audit data (PDF SCR-054): once a
  --     claim is verified or rejected, who decided, when, and on what evidence
  --     cannot be rewritten — by anyone, through any path.
  if old.status in ('verified', 'rejected')
     and (new.verified_by is distinct from old.verified_by
          or new.verified_at is distinct from old.verified_at
          or new.verification_evidence is distinct from old.verification_evidence
          or new.rejected_reason is distinct from old.rejected_reason)
  then
    raise exception 'the verification of a % claim is immutable audit data', old.status
      using errcode = 'restrict_violation';
  end if;

  -- 3. You may only say that YOU checked it.
  if v_actor is not null
     and new.verified_by is not null
     and new.verified_by is distinct from old.verified_by
     and new.verified_by <> v_actor then
    raise exception 'a verification names the person who did it (Doc 15 §12)'
      using errcode = 'restrict_violation';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create or replace function finance.verify_payment_submission(
  p_submission_id uuid,
  p_verified_by uuid,
  p_evidence text,
  p_approve boolean default true,
  p_reason text default null,
  p_decision text default null
)
returns table (outcome text, status text)
language plpgsql
set search_path = ''
as $$
declare
  v_row finance.payment_submissions;
  v_decision text := coalesce(
    nullif(btrim(coalesce(p_decision, '')), ''),
    case when p_approve then 'confirm' else 'reject' end
  );
begin
  if v_decision not in ('confirm', 'reject', 'mismatch') then
    return query select 'unknown_decision'::text, null::text;
    return;
  end if;

  select s.* into v_row
    from finance.payment_submissions s
   where s.id = p_submission_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- Mismatch and evidence_requested are not settled: "requires resolution".
  if v_row.status not in ('pending_verification', 'mismatch', 'evidence_requested') then
    return query select 'settled'::text, v_row.status;
    return;
  end if;

  if p_verified_by is null then
    return query select 'no_verifier'::text, v_row.status;
    return;
  end if;

  if v_decision = 'confirm' then
    if p_evidence is null or length(trim(p_evidence)) = 0 then
      return query select 'no_evidence'::text, v_row.status;
      return;
    end if;

    update finance.payment_submissions
       set status = 'verified',
           verified_by = p_verified_by,
           verified_at = now(),
           verification_evidence = p_evidence,
           updated_at = now()
     where id = p_submission_id;

    return query select 'verified'::text, 'verified'::text;
    return;
  end if;

  if v_decision = 'mismatch' then
    if p_reason is null or length(trim(p_reason)) = 0 then
      return query select 'no_note'::text, v_row.status;
      return;
    end if;

    update finance.payment_submissions
       set status = 'mismatch',
           mismatch_note = p_reason,
           updated_at = now()
     where id = p_submission_id;

    return query select 'mismatch'::text, 'mismatch'::text;
    return;
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    return query select 'no_reason'::text, v_row.status;
    return;
  end if;

  update finance.payment_submissions
     set status = 'rejected',
         verified_by = p_verified_by,
         verified_at = now(),
         rejected_reason = p_reason,
         updated_at = now()
   where id = p_submission_id;

  return query select 'rejected'::text, 'rejected'::text;
end;
$$;

-- The door into evidence_requested.
create or replace function finance.request_payment_evidence(
  p_submission_id uuid,
  p_note text
)
returns table (outcome text, status text)
language plpgsql
set search_path = ''
as $$
declare
  v_row finance.payment_submissions;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if (select core.current_user_role()) not in ('owner', 'ops_admin') then
    return query select 'forbidden'::text, null::text;
    return;
  end if;

  select s.* into v_row
    from finance.payment_submissions s
   where s.id = p_submission_id
     and s.organization_id = (select core.current_organization_id())
   for update;
  if v_row.id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  if v_row.status not in ('pending_verification', 'mismatch', 'evidence_requested') then
    return query select 'settled'::text, v_row.status;
    return;
  end if;

  if v_note is null then
    return query select 'no_note'::text, v_row.status;
    return;
  end if;

  update finance.payment_submissions
     set status = 'evidence_requested',
         evidence_request_note = v_note,
         updated_at = now()
   where id = p_submission_id;

  perform core.record_audit(
    v_row.organization_id,
    'payment_submission.evidence_requested',
    'payment_submission',
    p_submission_id,
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('status', 'evidence_requested', 'note', v_note, 'invoiceId', v_row.invoice_id)
  );

  return query select 'requested'::text, 'evidence_requested'::text;
end;
$$;

revoke all on function finance.request_payment_evidence(uuid, text) from public, anon;
grant execute on function finance.request_payment_evidence(uuid, text) to authenticated, service_role;

comment on function finance.request_payment_evidence(uuid, text) is
  'Sends a payment claim back for more evidence (SCR-054 "NEED MORE EVIDENCE"). Owner / ops_admin only; a note saying what is missing is required; refused on a verified or rejected claim; audited. The claim stays decidable.';

notify pgrst, 'reload schema';
