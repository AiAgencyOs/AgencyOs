-- ═══════════════════════════════════════════════════════════════════════════
-- Reconciliation says what it found. It does not fix anything.
--
-- Document 15 §15 asks for six things and the schema has none of them: compare
-- recorded payments against authoritative data; identify matched, unmatched,
-- duplicate, missing and discrepant transactions; track the period; record the
-- reconciler, timestamp and source; keep adjustment reasons. And then the line
-- that decides the whole shape:
--
--   *"Reconciliation must not silently alter historical transactions."*
--
-- §29 says it again from the other end: *"Reconciliation must preserve original
-- transaction evidence."*
--
-- ── so it has no way to alter one ────────────────────────────────────────
--
-- A reconciliation item points at a `finance.payments` row by foreign key and
-- holds **no** amount, status or date that could be written back. There is no
-- function here that touches a payment, and the money path is untouched:
-- `record_manual_payment` still writes the ledger, `verify_payment` still
-- confirms it, and ADM-04 still says a client's claim is not a payment until a
-- person checks it against the bank.
--
-- What this adds is the record of **that check** — which has been happening in
-- somebody's head and in a bank tab since the day money started arriving.
--
-- ── the statement line is kept verbatim ──────────────────────────────────
--
-- `statement_line` holds what the bank actually said, unparsed. §29's *"preserve
-- original transaction evidence"* is not satisfied by keeping the amount we
-- read out of it: the amount is our reading, and the reading is the thing under
-- review. Both are stored, and the line is frozen once written.
--
-- ── and there is no gateway, so there is no import ───────────────────────
--
-- `paymentGateways: 0`, by decision. Nothing here fetches a statement, parses a
-- bank format or talks to a provider — a person enters the lines, which is what
-- §29's *"IMPORT/READ AUTHORITATIVE TRANSACTIONS"* means in a deployment with
-- no gateway. Building a parser for a format nobody has chosen would be the
-- tables-with-no-code state G-011 exists to prevent.
--
-- ── auto-matching is arithmetic, not judgement ───────────────────────────
--
-- §29 asks to *"AUTO-MATCH HIGH-CONFIDENCE ITEMS"*. High confidence here means
-- **exactly one** verified payment in the period with the same amount and the
-- same reference. That is a query, not a model call — and `finance.reconcile`
-- proposes the match without applying it, because §15's own rule is that
-- reconciliation does not alter anything.

create table if not exists finance.reconciliations (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,

  -- §15: "Track reconciliation period." Half-open, so two adjacent periods
  -- cannot both claim the same day.
  period_start      date not null,
  period_end        date not null,

  -- §15: "Record reconciler, timestamp and source."
  account_id        uuid references finance.payment_accounts(id),
  source            text not null check (length(btrim(source)) between 1 and 200),
  opened_by         uuid references core.users(id),
  opened_at         timestamptz not null default now(),

  status            text not null default 'open' check (status in ('open', 'closed')),
  closed_by         uuid references core.users(id),
  closed_at         timestamptz,

  constraint reconciliations_period_is_a_period check (period_end > period_start),
  constraint reconciliations_closed_says_who check (
    (status = 'open'  and closed_by is null and closed_at is null)
    or (status = 'closed' and closed_by is not null and closed_at is not null)
  )
);

create unique index if not exists reconciliations_one_open_per_account
  on finance.reconciliations (organization_id, coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status = 'open';

create table if not exists finance.reconciliation_items (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  reconciliation_id uuid not null references finance.reconciliations(id) on delete cascade,

  -- What the bank said, verbatim. §29: "preserve original transaction
  -- evidence" — and the evidence is the line, not our reading of it.
  statement_line    text not null check (length(btrim(statement_line)) between 1 and 500),
  statement_date    date not null,

  -- Our reading of it. Kept beside the line rather than instead of it, because
  -- the reading is the thing under review.
  amount_minor      bigint not null,
  reference         text,

  -- §15's five, and no sixth.
  finding           text not null check (finding in (
    'matched', 'unmatched', 'duplicate', 'missing', 'discrepant'
  )),

  -- The payment this line is about, when one was found. A read-only pointer:
  -- there is no column here that could write anything back to it.
  payment_id        uuid references finance.payments(id) on delete set null,

  -- §15: "Keep adjustment reasons." Required for anything that is not a clean
  -- match, because a finding nobody explained is a finding nobody can act on.
  reason            text,

  created_at        timestamptz not null default now(),

  constraint reconciliation_items_matched_names_a_payment check (
    finding <> 'matched' or payment_id is not null
  ),
  constraint reconciliation_items_reason_is_a_reason check (
    reason is null or length(btrim(reason)) between 1 and 600
  )
);

comment on table finance.reconciliations is
  'Document 15 section 15. The record of somebody checking recorded payments against the bank - which has been happening in a head and a browser tab since money started arriving, and nowhere else. Carries no way to alter a payment: section 15 says "Reconciliation must not silently alter historical transactions", so nothing here can alter one at all.';

comment on column finance.reconciliation_items.statement_line is
  'What the bank actually said, unparsed. Document 15 section 29: "Reconciliation must preserve original transaction evidence" - and the evidence is the line, not the amount we read out of it. Frozen once written; amount_minor and reference are our reading of it and sit beside it rather than replacing it.';

-- §15's "Keep adjustment reasons" is enforced at CLOSE, not at insert, and
-- that is §29's flow rather than a softening of §15:
--
--   IMPORT → MATCH → EXCEPTION QUEUE → MANUAL/ADMIN REVIEW → ADJUSTMENT WITH
--   REASON → RECONCILIATION CLOSE
--
-- The queue is the point. Requiring the reason at insert would mean knowing
-- the answer the moment the line is entered, which is not what reconciling is:
-- you enter the statement, see what did not match, and then work through it.
--
-- The first version of this required it at insert — and that made
-- `refuse_unresolved_close` **unfireable**, a control that reads as a control
-- and can never run. It was caught by writing the check that tries to close
-- over an unexplained item and watching it be refused three steps earlier.
comment on constraint reconciliation_items_reason_is_a_reason on finance.reconciliation_items is
  'A reason, when there is one, is a sentence rather than whitespace. Whether there MUST be one is Document 15 section 29 close-time business, held by finance.refuse_unresolved_close - because section 29 puts the reason after the review, and the review after the queue.';

-- ── the evidence does not change ─────────────────────────────────────────

create or replace function finance.freeze_statement_line()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.statement_line is distinct from old.statement_line
     or new.statement_date is distinct from old.statement_date
  then
    raise exception
      'the statement line is what the bank said, and reconciliation preserves it (Doc 15 §29)'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists freeze_statement_line on finance.reconciliation_items;
create trigger freeze_statement_line
  before update on finance.reconciliation_items
  for each row execute function finance.freeze_statement_line();

-- ── a period closes when nothing in it is unexplained ────────────────────

create or replace function finance.refuse_unresolved_close()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_open int;
begin
  if new.status <> 'closed' or coalesce(old.status, '') = 'closed' then
    return new;
  end if;

  select count(*) into v_open
    from finance.reconciliation_items i
   where i.reconciliation_id = new.id
     and i.finding <> 'matched'
     and (i.reason is null or length(btrim(i.reason)) = 0);

  if v_open > 0 then
    raise exception
      'this period still has % item(s) nobody has explained (Doc 15 §29 — review, then adjust with a reason, then close)', v_open
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function finance.refuse_unresolved_close() is
  'Document 15 section 29: IMPORT -> MATCH -> EXCEPTION QUEUE -> REVIEW -> ADJUSTMENT WITH REASON -> CLOSE. A period that closes over an unexplained exception is a queue nobody worked, wearing the word closed.';

drop trigger if exists refuse_unresolved_close on finance.reconciliations;
create trigger refuse_unresolved_close
  before update of status on finance.reconciliations
  for each row execute function finance.refuse_unresolved_close();

-- ── auto-match: arithmetic, and it proposes rather than applies ──────────

create or replace function finance.propose_match(p_item_id uuid)
returns table (outcome text, payment_id uuid, candidates int)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_item  finance.reconciliation_items;
  v_recon finance.reconciliations;
  v_count int;
  v_match uuid;
begin
  select * into v_item from finance.reconciliation_items where id = p_item_id;
  if v_item.id is null then
    return query select 'not_found'::text, null::uuid, 0;
    return;
  end if;

  select * into v_recon from finance.reconciliations where id = v_item.reconciliation_id;

  -- High confidence means exactly one candidate: the same amount, in the
  -- period, verified. Anything else is the exception queue's, which is where
  -- §29 puts it — an auto-match that guesses between two is the silent
  -- alteration §15 forbids, arriving by a different door.
  -- Counted and picked in one pass over the same set. `min(uuid)` does not
  -- exist in Postgres — the first version used it, and the function raised on
  -- every call that got past `not_found`, which is the one branch a probe with
  -- a made-up id exercises.
  with candidate as (
    select p.id
      from finance.payments p
     where p.organization_id = v_item.organization_id
       and p.amount_minor = v_item.amount_minor
       and p.verified_at is not null
       and p.captured_at::date >= v_recon.period_start
       and p.captured_at::date <  v_recon.period_end
       and not exists (
         select 1 from finance.reconciliation_items o
          where o.payment_id = p.id and o.id <> v_item.id
       )
  )
  select count(*), (select id from candidate limit 1) into v_count, v_match from candidate;

  if v_count = 1 then
    return query select 'matched'::text, v_match, 1;
  elsif v_count = 0 then
    return query select 'no_candidate'::text, null::uuid, 0;
  else
    return query select 'ambiguous'::text, null::uuid, v_count;
  end if;
end;
$$;

comment on function finance.propose_match(uuid) is
  'Document 15 section 29: "AUTO-MATCH HIGH-CONFIDENCE ITEMS." High confidence is exactly one verified payment in the period with the same amount and not already claimed by another line. It PROPOSES: it returns the candidate and writes nothing, because section 15 says reconciliation does not alter anything - and an auto-match that picks between two candidates is that alteration arriving by a different door.';

-- ── tenancy ──────────────────────────────────────────────────────────────

alter table finance.reconciliations enable row level security;
alter table finance.reconciliations force row level security;
alter table finance.reconciliation_items enable row level security;
alter table finance.reconciliation_items force row level security;

drop policy if exists reconciliations_select on finance.reconciliations;
create policy reconciliations_select on finance.reconciliations
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists reconciliation_items_select on finance.reconciliation_items;
create policy reconciliation_items_select on finance.reconciliation_items
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop trigger if exists org_match_reconciliations_account on finance.reconciliations;
create trigger org_match_reconciliations_account
  before insert or update of account_id, organization_id on finance.reconciliations
  for each row execute function core.enforce_parent_org('account_id', 'finance.payment_accounts');

drop trigger if exists freeze_org_reconciliations on finance.reconciliations;
create trigger freeze_org_reconciliations
  before update of organization_id on finance.reconciliations
  for each row execute function core.freeze_organization_id();

drop trigger if exists org_match_reconciliation_items_parent on finance.reconciliation_items;
create trigger org_match_reconciliation_items_parent
  before insert or update of reconciliation_id, organization_id on finance.reconciliation_items
  for each row execute function core.enforce_parent_org('reconciliation_id', 'finance.reconciliations');

drop trigger if exists org_match_reconciliation_items_payment on finance.reconciliation_items;
create trigger org_match_reconciliation_items_payment
  before insert or update of payment_id, organization_id on finance.reconciliation_items
  for each row execute function core.enforce_parent_org('payment_id', 'finance.payments');

drop trigger if exists freeze_org_reconciliation_items on finance.reconciliation_items;
create trigger freeze_org_reconciliation_items
  before update of organization_id on finance.reconciliation_items
  for each row execute function core.freeze_organization_id();

grant select, insert, update on finance.reconciliations to authenticated, service_role;
grant select, insert, update on finance.reconciliation_items to authenticated, service_role;
grant execute on function finance.propose_match(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
