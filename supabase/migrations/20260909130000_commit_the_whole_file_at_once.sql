-- ═══════════════════════════════════════════════════════════════════════════
-- Commit the whole file at once — G-224
-- ═══════════════════════════════════════════════════════════════════════════
--
-- An operator uploads a WhatsApp export, lands on the batch preview and sees an
-- "Importable" count: every phone-keyed exact/new record the matcher decided is
-- safe to file. Filing them is one record at a time — `crm.commit_import_record`
-- takes ONE id, and the screen calls it once per row. A file of hundreds is
-- hundreds of clicks to do a thing the operator already decided once ("import
-- this export"), which is the same shape G-219 fixed for enrolment.
--
-- ── why committing is safe to batch, and enrolment needed a gate ───────────
--
-- `crm.commit_import_record` writes a contact, a lead and — since G-218 — the
-- conversation the export was of. It sets NO consent row of its own (ADM-92's
-- consent is inferred by the inbound-message trigger from the transcript, not
-- by the commit), queues NO job and sends NOTHING. So filing a batch starts no
-- outreach: there is no campaign to turn itself on, and therefore no pilot gate
-- here — that gate belongs to enrolment, where the batch IS a campaign.
--
-- The window (G-214), the approved template (G-213) and the outreach limits
-- (G-216) still stand between a committed lead and a message, exactly as they
-- did before.
--
-- ── what a bulk commit is allowed to be ────────────────────────────────────
--
-- A ceiling, not a faucet. `p_limit` is the caller's own bound and MAX_PER_CALL
-- is the one they cannot raise, so a mistyped number cannot file a database in
-- one statement and an operator files a large export in passes they can watch.
--
-- And it goes THROUGH the single-record function, deliberately. Idempotency,
-- the phone-keyed-only rule and the no-timezone refusal are enforced there, so
-- they are enforced here for free — and a rule added there tomorrow cannot be
-- missing from the batch, which is the failure class G-219 named.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.commit_import_batch(
  p_batch_id uuid,
  p_limit int default 100
)
returns table (
  outcome      text,
  committed    int,
  already      int,
  skipped      int,
  uncommitted  int,
  remaining    int
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- The bound the caller cannot raise. An operator filing a large export does
  -- it in passes they can watch; a mistyped number cannot file a database.
  c_max          constant int := 500;
  v_actor        uuid := (select auth.uid());
  v_org          uuid;
  v_limit        int := least(greatest(coalesce(p_limit, 100), 1), c_max);
  v_rec          uuid;
  v_result       text;
  v_committed    int := 0;
  v_already      int := 0;
  v_skipped      int := 0;
  v_uncommitted  int := 0;
  v_remaining    int := 0;
begin
  select b.organization_id into v_org
    from crm.import_batches b where b.id = p_batch_id;
  if v_org is null then
    return query select 'not_found'::text, 0, 0, 0, 0, 0; return;
  end if;

  -- Authority: owner/ops_admin of the batch's own org, tenant DERIVED from the
  -- row and never trusted from the caller. The service role (jobs) is exempt.
  -- This is the same authority crm.commit_import_record applies per record, so
  -- the loop below never has to handle a 'forbidden' outcome.
  if v_actor is not null then
    if (select core.current_user_role()) not in ('owner', 'ops_admin') then
      return query select 'forbidden'::text, 0, 0, 0, 0, 0; return;
    end if;
    if v_org is distinct from (select core.current_organization_id()) then
      return query select 'forbidden'::text, 0, 0, 0, 0, 0; return;
    end if;
  end if;

  -- The rows that will never be reached by this action: uncommitted records
  -- that are not a clean phone decision (name-only, probable, conflict,
  -- unmatched). Counted rather than silently ignored, so an operator reading
  -- "committed 40" knows the rest need a human, not another pass.
  select count(*) into v_uncommitted
    from crm.import_records r
   where r.batch_id = p_batch_id
     and r.committed_at is null
     and not (r.auto_importable and r.classification in ('exact', 'new') and r.phone is not null);

  for v_rec in
    select r.id
      from crm.import_records r
     where r.batch_id = p_batch_id
       and r.committed_at is null
       and r.auto_importable
       and r.classification in ('exact', 'new')
       and r.phone is not null
     order by r.created_at
     limit v_limit
  loop
    -- Through the single-record function, deliberately. Every rule it enforces
    -- is enforced here for free, and a rule added there tomorrow cannot be
    -- missing from the batch — which is the failure this gap's sibling (G-219)
    -- is an instance of.
    select c.outcome into v_result from crm.commit_import_record(v_rec) c;

    if v_result = 'committed' then v_committed := v_committed + 1;
    else v_skipped := v_skipped + 1;   -- chiefly 'no_timezone': a transcript with no timeline
    end if;
  end loop;

  -- The rows this pass did not need to touch because an earlier one already
  -- filed them. Counted from the table rather than from the loop: the loop
  -- selects `committed_at is null`, so it can never SEE an already-committed
  -- row, and a counter incremented inside it was dead code that always read
  -- zero - which the live verifier's own idempotency check (re-run, expect
  -- two already) would have failed on the first run. Found by review.
  select count(*) into v_already
    from crm.import_records r
   where r.batch_id = p_batch_id
     and r.committed_at is not null
     and r.auto_importable
     and r.classification in ('exact', 'new')
     and r.phone is not null;

  -- What auto-importable work is left for the next pass, so the operator knows
  -- there is one.
  select count(*) into v_remaining
    from crm.import_records r
   where r.batch_id = p_batch_id
     and r.committed_at is null
     and r.auto_importable
     and r.classification in ('exact', 'new')
     and r.phone is not null;

  perform core.record_audit(
    v_org, 'import.batch_committed', 'import_batch', p_batch_id, null,
    jsonb_build_object(
      'committed', v_committed, 'already', v_already, 'skipped', v_skipped,
      'uncommitted', v_uncommitted, 'remaining', v_remaining, 'limit', v_limit));

  return query select 'committed'::text, v_committed, v_already, v_skipped,
                      v_uncommitted, v_remaining;
end;
$$;

comment on function crm.commit_import_batch(uuid, int) is
  'Commits the auto-importable records of one import batch — a bounded pass at a time, 500 the ceiling a caller cannot raise (G-224). Every record goes through crm.commit_import_record, so idempotency, the phone-keyed-only rule and the no-timezone refusal are the same code the single path uses and a rule added there cannot be missing here. SECURITY DEFINER; owner/ops_admin, tenant derived from the batch row, service role exempt. Returns a count per outcome and what remains, and unlike the reactivation batch there is NO pilot gate: committing files a contact and a lead and SENDS NOTHING, so it starts no campaign that could turn itself on.';

revoke all on function crm.commit_import_batch(uuid, int) from public, anon;
grant execute on function crm.commit_import_batch(uuid, int) to authenticated, service_role;
