-- ═══════════════════════════════════════════════════════════════════════════
-- A payment that does not match is not a payment that did not happen.
--
-- Finance §4.7: *"Wait for explicit Admin **CONFIRM / REJECT / MISMATCH**
-- decision."* §6's state table: **MISMATCH — *"Amount/reference/problem
-- requires resolution"*, may open next gate: No.** §12's state machine ends
-- `VERIFIED/PAID | REJECTED/MISMATCH`. §16: *"Amount mismatch → MISMATCH; gate
-- remains closed."* §17's FIN-I05: *"Emit verified/rejected/mismatch events."*
--
-- Four locked places, and `verify_payment_submission` took a **boolean**.
--
-- That is the defect, and it is a shape rather than a missing branch: a
-- boolean cannot express three decisions, so the third one could not be
-- recorded no matter what anybody typed. A verifier looking at ₹29,500
-- against an invoice for ₹30,000 had two buttons — *it arrived* or *it did
-- not* — and both of them are lies about that row.
--
-- ── what makes MISMATCH different from REJECT ───────────────────────────
--
-- Not severity. **Finality.**
--
--   REJECT   — the claim is false. §16: *"reason stored; corrective flow."*
--              The submission is finished; whatever happens next is a new
--              claim.
--
--   MISMATCH — the claim is probably true and something does not line up.
--              §6's own words are *"requires resolution"*. The submission is
--              **still open**: the amount gets checked, the reference gets
--              corrected, the client is asked which account they paid into,
--              and then somebody confirms or rejects it **for real**.
--
-- So the door's `settled` refusal had to change. Today it refuses any row that
-- is not `pending_verification`, which would make a mismatch a dead end — the
-- one thing §6 says it is not. A mismatched submission may be decided again;
-- a verified or rejected one may not.
--
-- ── the gate stays closed, and nothing here does that ────────────────────
--
-- §16 says *"gate remains closed"* and **no line in this migration enforces
-- it**, deliberately. Verifying a submission has never moved money — that was
-- the point of splitting a claim from the ledger. `net_verified_minor` counts
-- `finance.payments`, and a mismatched claim never becomes one. The gate is
-- closed because nothing opened it, which is a stronger guarantee than a check
-- somebody has to remember to write.
--
-- ── a signature that does not break what is already deployed ────────────
--
-- `p_approve boolean` is kept and `p_decision text` is added beside it. That
-- redundancy is **transitional and is not an accident**: this repository
-- pushes migrations from a branch before the matching code merges, and the
-- deployed caller sends `p_approve`. A migration that replaced the boolean
-- would refuse every verification on production the moment it applied — the
-- exact regression G-261 caused three weeks' worth of work ago.
--
-- The old 5-argument function is dropped rather than left beside the new one,
-- because a defaulted parameter creates an OVERLOAD and not a replacement
-- (G-260). PostgREST resolves by argument NAMES, so a deployed call carrying
-- the five old names still binds to the new function with `p_decision` null.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── §6's vocabulary ──────────────────────────────────────────────────────

alter table finance.payment_submissions
  drop constraint if exists payment_submissions_status_check;
alter table finance.payment_submissions
  add constraint payment_submissions_status_check
    check (status in ('pending_verification', 'verified', 'rejected', 'mismatch',
                      'partially_verified', 'duplicate', 'refunded'));

-- §6: "Amount/reference/problem requires resolution." WHICH of those it is
-- decides who resolves it — an amount is a conversation with the client, a
-- reference is usually a typo, and "problem" is neither. A separate column
-- from `rejected_reason` because the two endings are different facts, and one
-- column holding both would make "was this rejected?" unanswerable.
alter table finance.payment_submissions
  add column if not exists mismatch_note text;

comment on column finance.payment_submissions.mismatch_note is
  'Finance section 6 - what did not line up: the amount, the reference, the receiving account, the date. Separate from rejected_reason because MISMATCH and REJECTED are different endings - one is unresolved and one is finished - and a single column holding both would make "was this rejected?" unanswerable.';

alter table finance.payment_submissions
  drop constraint if exists payment_submissions_mismatch_says_what;
alter table finance.payment_submissions
  add constraint payment_submissions_mismatch_says_what
    check (status <> 'mismatch'
           or (mismatch_note is not null and length(trim(mismatch_note)) > 0))
    not valid;

comment on constraint payment_submissions_mismatch_says_what on finance.payment_submissions is
  'A mismatch nobody described is a claim parked forever: the next person cannot tell what to resolve. The same rule payment_submissions_rejection_says_why holds for the other ending. NOT VALID because no existing row can carry this status - the value did not exist.';

-- ── the door, carried forward from 20260821250000 ────────────────────────
--
-- Dropped first: `p_decision` is a new defaulted argument, and a defaulted
-- argument makes an overload rather than a replacement (G-260). Two live
-- definitions of a money function is one too many.
drop function if exists finance.verify_payment_submission(uuid, uuid, text, boolean, text);

create or replace function finance.verify_payment_submission(
  p_submission_id uuid,
  p_verified_by   uuid,
  p_evidence      text,
  p_approve       boolean default true,
  p_reason        text default null,
  -- [G-271 edit 1 of 4] §4.7's third decision. Added BESIDE `p_approve` rather
  -- than replacing it: the deployed caller sends the boolean, and this
  -- repository pushes migrations before the code that matches them merges.
  -- 'confirm' | 'reject' | 'mismatch'; null falls back to the boolean, which
  -- is today's behaviour exactly.
  p_decision      text default null
)
returns table (
  -- [G-271 edit 2 of 4] 'mismatch' and 'no_note' added.
  -- 'verified' | 'rejected' | 'mismatch' | 'not_found' | 'settled'
  -- | 'no_evidence' | 'no_verifier' | 'no_reason' | 'no_note'
  -- | 'unknown_decision'
  outcome text,
  status  text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row finance.payment_submissions;
  -- [G-271 edit 3 of 4] One decision, resolved once, from either spelling.
  v_decision text := coalesce(
    nullif(btrim(coalesce(p_decision, '')), ''),
    case when p_approve then 'confirm' else 'reject' end
  );
begin
  -- Refused on the ARGUMENT, before the row is read: a caller sending a
  -- decision nobody defined has made a mistake about the vocabulary, not
  -- about this submission.
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

  -- [G-271 edit 4 of 4] A MISMATCH IS NOT SETTLED. §6: "requires resolution."
  -- The previous line refused everything that was not pending, which would
  -- have made a mismatch the one thing §6 says it is not — a dead end. A
  -- verified or rejected claim is still finished.
  if v_row.status not in ('pending_verification', 'mismatch') then
    return query select 'settled'::text, v_row.status;
    return;
  end if;

  -- §12: "Manual verification must record verifier and evidence."
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

    -- `verified_at` is NOT written, and neither is `verified_by`. A mismatch
    -- is not a verification, and stamping a verifier on it would make the
    -- queue of unchecked claims look shorter than it is.
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

comment on function finance.verify_payment_submission(uuid, uuid, text, boolean, text, text) is
  'Doc 15 section 12 and Finance section 4.7 - CONFIRM / REJECT / MISMATCH. A MISMATCH IS NOT SETTLED: section 6 says it "requires resolution", so a mismatched claim may be decided again and a verified or rejected one may not. A mismatch writes no verified_by and no verified_at, because it is not a verification and stamping one would make the queue of unchecked claims look shorter than it is. p_approve is kept beside p_decision so a deployed caller sending the boolean keeps working while the matching code merges. SECURITY INVOKER: the RLS policy is the authorization, and p_verified_by names a person because there is no agent form of this call - section 36 forbids agent self-approval for high-risk financial actions. Verifying does NOT write money; nothing here can open a gate, because net_verified_minor counts finance.payments and a mismatched claim never becomes one.';

revoke all on function finance.verify_payment_submission(uuid, uuid, text, boolean, text, text) from public, anon;
grant execute on function finance.verify_payment_submission(uuid, uuid, text, boolean, text, text)
  to authenticated, service_role;

-- ── the row guard, carried forward from 20260821250000 ───────────────────
--
-- **Found by driving it, not by reading it.** The door's own `settled` check
-- was changed above to let a mismatched claim be decided again — and the
-- UPDATE would still have been refused, because a trigger holds the same rule
-- independently and knows nothing about the new status. Two layers, one of
-- them changed: the shape this repository calls half a check, and the reason
-- the psql drive exists.
create or replace function finance.payment_submissions_guard()
returns trigger
language plpgsql
security invoker
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

  -- 2. A settled claim is settled.
  --
  -- [G-271 edit 1 of 1] `mismatch` joins `pending_verification` as a status a
  -- claim may still move out of. §6 calls it "requires resolution", and a
  -- resolution that the row refuses to record is not one. Everything else is
  -- unchanged: verified and rejected are still final.
  if old.status not in ('pending_verification', 'mismatch')
     and new.status is distinct from old.status then
    raise exception 'payment claim is already %', old.status
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

-- ── FIN-I05: "Emit verified/rejected/mismatch events" ────────────────────
--
-- The trigger emitted `payment.submitted` and `payment.verified` and stopped
-- there, so **a rejection was already silent** before MISMATCH existed. Both
-- halves are added together rather than adding the new one and leaving the
-- older gap, which would be a registry that announces one ending out of three.
insert into core.event_types (type, description, canonical) values
  ('payment.rejected',
   'Finance section 17 FIN-I05 - an Admin decided a payment claim was false. The reason is on the row (Doc 15 section 12). Nothing subscribes yet.',
   true),
  ('payment.mismatched',
   'Finance sections 4.7 and 6 - an Admin found the claim does not line up and it REQUIRES RESOLUTION. Not an ending: the claim stays open and may be decided again. Nothing subscribes yet.',
   true)
on conflict (type) do nothing;

-- Carried forward from 20260821270000 with two marked edits.
create or replace function finance.emit_payment_submission_event()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform core.emit_event(
      new.organization_id, 'payment.submitted', 'payment_submission', new.id,
      jsonb_build_object('invoice_id', new.invoice_id, 'amountMinor', new.amount_minor)
    );
    return new;
  end if;

  if new.status = 'verified' and old.status is distinct from 'verified' then
    perform core.emit_event(
      new.organization_id, 'payment.verified', 'payment_submission', new.id,
      jsonb_build_object('invoice_id', new.invoice_id, 'amountMinor', new.amount_minor)
    );
  end if;

  -- [G-271 edit 1 of 2] FIN-I05 asks for three and this emitted one. A
  -- rejection was silent before MISMATCH existed, so both are added here.
  if new.status = 'rejected' and old.status is distinct from 'rejected' then
    perform core.emit_event(
      new.organization_id, 'payment.rejected', 'payment_submission', new.id,
      jsonb_build_object('invoice_id', new.invoice_id, 'amountMinor', new.amount_minor)
    );
  end if;

  -- [G-271 edit 2 of 2] Emitted on EVERY entry into mismatch, including a
  -- second one after somebody tried to resolve it and could not. That repeat
  -- is the signal worth having: a claim bouncing between mismatch and
  -- resolution is one nobody is actually fixing.
  if new.status = 'mismatch' and old.status is distinct from 'mismatch' then
    perform core.emit_event(
      new.organization_id, 'payment.mismatched', 'payment_submission', new.id,
      jsonb_build_object(
        'invoice_id', new.invoice_id,
        'amountMinor', new.amount_minor,
        'note', new.mismatch_note
      )
    );
  end if;

  return new;
end;
$$;

notify pgrst, 'reload schema';
