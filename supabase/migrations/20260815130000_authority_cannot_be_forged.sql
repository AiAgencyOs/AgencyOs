-- ═══════════════════════════════════════════════════════════════════════════
-- Authority cannot be forged.
--
-- Two protections, one principle: a decision that grants authority — a
-- client's consent, a verdict that work is complete — must be impossible to
-- manufacture or erase by writing rows, even with the service role, even by
-- an admin, even by a compromised agent path. Prompts and TypeScript
-- contracts are advice; these triggers are the rule.
--
-- ── 1. consent is never deleted ───────────────────────────────────────────
--
-- ADM-70/ADM-81's design says withdrawn consent is A ROW, not an absence:
-- `crm.send_outbound_message` refuses on `status = 'withdrawn'`. But a row
-- can be deleted, and deletion was silent — the audit trigger fires on
-- INSERT OR UPDATE only. The forge-by-erasure: delete the withdrawn row,
-- insert a fresh 'granted' one, and an opted-out client is messageable again
-- with a clean-looking audit trail. Found by executing exactly that against
-- the live schema. The fix enforces the recorded design; it invents nothing.
--
-- ── 2. a handoff cannot declare itself done ───────────────────────────────
--
-- ADM-82: no agent may declare its own work complete, and completion is a
-- verdict given by the producer's declared verifier. The registry enforces
-- that at build time and `verdictFor` at runtime — but nothing stopped a row
-- from being BORN completed, a completed row from re-opening, or a
-- completion whose `verification` was `'"anything"'::jsonb`. The only
-- database check was IS NOT NULL. service_role and admin writes skip the
-- TypeScript layer entirely, so the rule now lives where those writes land.
--
-- The verifier legitimacy table mirrors `verification.verifiedBy` from
-- src/modules/agents/registry.ts the same way `ai.agent_handoff_targets`
-- mirrors `handoffTargets` (G-125): seeded, not migrated, and drift-checked
-- by scripts/verify-agent-definitions.mjs.
--
-- The status machine is an ENGINEERING DECISION, recorded here: nothing in
-- the application writes ai.handoffs yet (verified — no callers outside the
-- ceilings verify script, which inserts default-status rows and deletes
-- them), so the machine is pinned before the first writer exists rather
-- than reverse-engineered after one entrenches an accident.
--
--   queued            → accepted | rejected | cancelled
--   accepted          → running  | cancelled
--   running           → needs_input | awaiting_approval | failed_retryable
--                       | failed_permanent | completed | rejected | cancelled
--   needs_input       → running | cancelled
--   awaiting_approval → running | rejected | cancelled
--   failed_retryable  → running | failed_permanent | cancelled
--     (the same pair verification.ts's retry policy already produces)
--   completed, rejected, failed_permanent, cancelled — terminal. No exits.
--
-- A row is BORN 'queued' and nothing else: birth in any later state skips
-- every gate the machine exists to apply.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── consent: the delete refusal ───────────────────────────────────────────

-- Consent may leave only with the identity it belongs to. A blanket refusal
-- would make every contact - and through the cascade, every organization -
-- holding a consent row undeletable, which is the approvals-shaped trap that
-- broke CI once already. The attack this closes needs the CONTACT TO
-- SURVIVE: delete the withdrawn row, insert a granted one, message the
-- opted-out client. So the refusal is exactly that narrow: while the contact
-- and its organization both still exist, consent rows do not move. During a
-- cascade the parent row is already gone when this fires, and the delete is
-- the identity being erased, not a record being forged.

create or replace function crm.consent_reject_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from crm.contacts c where c.id = old.contact_id)
     and exists (select 1 from core.organizations o where o.id = old.organization_id)
  then
    raise exception
      'consent rows are never deleted while the contact exists: withdrawn is a row, not an absence (ADM-70, ADM-81). Withdraw by UPDATE, which is audited.'
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

comment on function crm.consent_reject_delete() is
  'Refuses DELETE on crm.communication_consent while the contact and organization both still exist. The no-consent-no-send rule reads rows; deleting a withdrawn row and inserting a granted one would re-permit sending to an opted-out contact with a clean audit trail, because the audit trigger fires on INSERT OR UPDATE only. Cascades pass: when the parent is already gone, the delete is the identity being erased, not a record being forged.';

drop trigger if exists communication_consent_no_delete on crm.communication_consent;
create trigger communication_consent_no_delete
  before delete on crm.communication_consent
  for each row execute function crm.consent_reject_delete();

-- The identity is immovable, or the delete guard above is a formality.
--
-- Review found the bypass: reparent a withdrawn row onto a throwaway contact,
-- delete THAT contact, and the cascade erases the withdrawal while the real
-- contact — with a now-free primary-key slot — survives to be re-granted. The
-- delete guard fires on the cascade and passes, because it checks the row's
-- CURRENT owner, which is the doomed one. Closing it there is impossible; the
-- forgery already happened in the UPDATE. So contact_id and organization_id
-- simply do not change: a consent row belongs to one identity for life.
create or replace function crm.consent_freeze_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.contact_id is distinct from old.contact_id
     or new.organization_id is distinct from old.organization_id then
    raise exception
      'a consent row does not change hands: contact_id and organization_id are fixed at insert (ADM-70, ADM-81). Reparenting is the erasure path the delete guard exists to stop.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function crm.consent_freeze_identity() is
  'Refuses any UPDATE that moves a consent row to a different contact or organization. Without this the delete guard is bypassable: reparent a withdrawn row onto a throwaway contact, delete that contact, and the cascade erases the withdrawal while the real contact survives to be re-granted.';

drop trigger if exists communication_consent_freeze_identity on crm.communication_consent;
create trigger communication_consent_freeze_identity
  before update of contact_id, organization_id on crm.communication_consent
  for each row execute function crm.consent_freeze_identity();

-- FOR EACH ROW triggers never see TRUNCATE. Both tables that hold authority
-- here refuse it outright — a statement-level guard is the only kind that can.
create or replace function crm.reject_truncate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception
    'table %.% is not truncated: it holds records whose deletion would erase authority (consent, verdicts). Remove rows through their owning identity.',
    tg_table_schema, tg_table_name
    using errcode = 'check_violation';
end;
$$;

comment on function crm.reject_truncate() is
  'Refuses TRUNCATE on a table holding authority-bearing records. FOR EACH ROW delete guards do not fire on TRUNCATE, so a one-statement wipe would slip past them; this statement-level trigger closes that.';

drop trigger if exists communication_consent_no_truncate on crm.communication_consent;
create trigger communication_consent_no_truncate
  before truncate on crm.communication_consent
  for each statement execute function crm.reject_truncate();

-- ── the verifier mirror ───────────────────────────────────────────────────

create table if not exists ai.agent_verifiers (
  producer text primary key references ai.agents(key) on delete cascade,
  verifier text not null references ai.agents(key) on delete restrict,
  check (producer <> verifier)
);

comment on table ai.agent_verifiers is
  'Who may declare a producer''s work complete - verification.verifiedBy from src/modules/agents/registry.ts, mirrored the way agent_handoff_targets mirrors handoffTargets (G-125, ADM-82). An agent absent here has no declared verifier and its work cannot be completed through a handoff at all. Seeded rather than migrated (the FK needs ai.agents populated); drift-checked by scripts/verify-agent-definitions.mjs.';

alter table ai.agent_verifiers enable row level security;

drop policy if exists agent_verifiers_read on ai.agent_verifiers;
create policy agent_verifiers_read on ai.agent_verifiers
  for select to authenticated
  using ((select core.is_internal()));

-- No write policy on purpose: the registry is the author and the seed is its
-- pen. authenticated writes fail RLS; service_role bypasses, which is what
-- the drift check exists to watch.

-- ── the handoff guard ─────────────────────────────────────────────────────

create or replace function ai.handoffs_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_legal boolean;
  v_declared text;
begin
  -- Birth: 'queued' only.
  if tg_op = 'INSERT' then
    if new.status <> 'queued' then
      raise exception
        'a handoff is born queued, not %: birth in a later state skips every gate the status machine applies (ADM-82).',
        new.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Same status: not a transition; other columns may change freely — except
  -- on a settled row, where the whole authority record is frozen. Without
  -- this, a completed handoff's verdict could be rewritten, its timestamp
  -- moved, or its from/to relabeled to reassign who did the work — all
  -- without a transition for the machine to see. from/to are covered here
  -- rather than left to enforce_handoff_target, which validates the pair but
  -- does not refuse relabeling a finished row.
  if new.status = old.status then
    if old.status in ('completed', 'rejected', 'failed_permanent', 'cancelled')
       and (new.verification is distinct from old.verification
            or new.completed_at is distinct from old.completed_at
            or new.from_agent is distinct from old.from_agent
            or new.to_agent   is distinct from old.to_agent)
    then
      raise exception
        'a % handoff is settled and its record is frozen (ADM-82): verdict, timestamp, and the agents it names do not change.',
        old.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Terminal states have no exits.
  if old.status in ('completed', 'rejected', 'failed_permanent', 'cancelled') then
    raise exception
      'a % handoff is settled and cannot become % (ADM-82, ADM-83): terminal is terminal.',
      old.status, new.status
      using errcode = 'check_violation';
  end if;

  v_legal := case old.status
    when 'queued'            then new.status in ('accepted', 'rejected', 'cancelled')
    when 'accepted'          then new.status in ('running', 'cancelled')
    when 'running'           then new.status in ('needs_input', 'awaiting_approval', 'failed_retryable', 'failed_permanent', 'completed', 'rejected', 'cancelled')
    when 'needs_input'       then new.status in ('running', 'cancelled')
    when 'awaiting_approval' then new.status in ('running', 'rejected', 'cancelled')
    when 'failed_retryable'  then new.status in ('running', 'failed_permanent', 'cancelled')
    else false
  end;

  if not v_legal then
    raise exception
      'a handoff does not go from % to % (ADM-82): the machine has no such edge.',
      old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- Completion is a verdict, and only the declared verifier gives one.
  if new.status = 'completed' then
    if new.verification is null
       or jsonb_typeof(new.verification) <> 'object'
       or new.verification->>'outcome' is distinct from 'verified'
       or jsonb_typeof(new.verification->'evidence') is distinct from 'array'
       or jsonb_array_length(new.verification->'evidence') < 1
    then
      raise exception
        'completion requires a verified verdict with at least one piece of evidence (ADM-82): {outcome: verified, verifier, evidence[]}.'
        using errcode = 'check_violation';
    end if;

    -- Every evidence item must have passed: verdictFor never emits
    -- outcome=verified alongside a failed item, and neither may a row.
    if exists (
      select 1 from jsonb_array_elements(new.verification->'evidence') e
       where jsonb_typeof(e) <> 'object'
          or (e->>'passed')::boolean is distinct from true
    ) then
      raise exception
        'completion evidence must be objects that passed (ADM-82): a verified verdict carries no failed evidence.'
        using errcode = 'check_violation';
    end if;

    -- Who signed it. Two legitimate shapes, both grounded in the mirror:
    --   1. the receiver did the work, and the receiver's declared verifier
    --      signed the verdict;
    --   2. the receiver IS the sender's declared verifier (work carried TO
    --      its judge - the QA shape), and signs the verdict itself. The
    --      subject of that verdict is the sender's work, not the
    --      receiver's, so producer <> verifier still holds.
    select v.verifier into v_declared
      from ai.agent_verifiers v
     where v.producer = new.to_agent;

    -- `is true` on each arm: v_declared is NULL when the receiver has no
    -- declared verifier, and NULL must read as "arm not satisfied", never as
    -- "cannot tell" — three-valued logic silently waved a forged verifier
    -- through here once, caught by this migration's own red probes.
    if not (
         ((new.verification->>'verifier') = v_declared) is true
         or (
           (new.verification->>'verifier') = new.to_agent
           and exists (
             select 1 from ai.agent_verifiers v2
              where v2.producer = new.from_agent
                and v2.verifier = new.to_agent
           )
         )
       )
    then
      raise exception
        'completion of a % -> % handoff must be signed by the declared verifier, and % is not it (ADM-82: producer never verifies its own work).',
        new.from_agent, new.to_agent, coalesce(new.verification->>'verifier', '(nobody)')
        using errcode = 'check_violation';
    end if;

    -- The guard stamps the time; the caller does not get to choose it. A
    -- caller-supplied completed_at would survive here and then be frozen by
    -- the branch above — a forged timestamp made permanent. now() is the one
    -- moment this verdict became true.
    new.completed_at := now();
  end if;

  return new;
end;
$$;

comment on function ai.handoffs_guard() is
  'The handoff status machine and the completion contract (ADM-82, ADM-83). Born queued; terminal states have no exits; edges are enumerated; completion requires a verified verdict - non-empty passed evidence, signed by the declared verifier from ai.agent_verifiers (or by the receiver when the receiver is the sender''s declared verifier: the work was carried to its judge). Lives in the database because service_role and admin writes never meet the TypeScript contract.';

drop trigger if exists handoffs_guard on ai.handoffs;
create trigger handoffs_guard
  before insert or update of status, verification, completed_at, from_agent, to_agent on ai.handoffs
  for each row execute function ai.handoffs_guard();

-- A settled verdict must not be erasable either. UPDATE-freezing it while
-- leaving DELETE open would just move the forgery: delete the completed row,
-- and the record that said the work passed is gone with no way to re-create
-- it (the machine refuses a completed birth). So a terminal handoff is not
-- deleted while its organization survives — the same cascade exemption the
-- consent guard uses, for the same reason: a real org teardown is an
-- identity being erased, not a verdict being hidden. A non-terminal handoff
-- stays freely deletable, which is what the ceilings verify script relies on.
create or replace function ai.handoffs_reject_terminal_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status in ('completed', 'rejected', 'failed_permanent', 'cancelled')
     and exists (select 1 from core.organizations o where o.id = old.organization_id)
  then
    raise exception
      'a settled (%) handoff is not deleted while its organization exists (ADM-82): the verdict is a record, and erasing it is forging by omission.',
      old.status
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

comment on function ai.handoffs_reject_terminal_delete() is
  'Refuses DELETE of a terminal handoff while its organization still exists. Freezing a settled verdict against UPDATE but not DELETE only moves the forgery - deleting the completed row erases the record that the work passed, and the machine refuses to re-create it. Cascades pass; non-terminal handoffs stay deletable.';

drop trigger if exists handoffs_no_terminal_delete on ai.handoffs;
create trigger handoffs_no_terminal_delete
  before delete on ai.handoffs
  for each row execute function ai.handoffs_reject_terminal_delete();

drop trigger if exists handoffs_no_truncate on ai.handoffs;
create trigger handoffs_no_truncate
  before truncate on ai.handoffs
  for each statement execute function crm.reject_truncate();
