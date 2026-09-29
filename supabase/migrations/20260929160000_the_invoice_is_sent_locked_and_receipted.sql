-- ═══════════════════════════════════════════════════════════════════════════
-- The invoice is sent, the period is locked, the expense keeps its receipt,
-- and the reconciliation finally gets a door.
--
-- Four bucket-B gaps from docs/AGENCYOS_ADMIN_REMAINING_GAPS.md, all on the
-- finance screens (SCR-051 Invoices, SCR-053 Payments, SCR-055 Expenses,
-- SCR-056 GST & tax). Each one was "the screen wants to record a fact and the
-- schema has nowhere to put it":
--
--   1. finance.invoice_sends — SCR-051 asks for send / reminder records. An
--      invoice leaves draft and becomes visible in the portal (that is what
--      `issue_invoice` does), but WHEN somebody actually sent it — on
--      WhatsApp, by email, by hand — and when they chased it, was in nobody's
--      head but the sender's. This is the record of that act. It sends
--      nothing: there is no invoice WhatsApp door in this repository (the
--      only document sender, `sendWhatsAppDocument`, is called for
--      quotations), so the form says "record that it was sent", not "send".
--
--   2. finance.tax_period_locks — SCR-056 asks to lock a reporting period.
--      Once a GST return is filed for a month, an invoice issued or voided
--      INTO that month changes a figure already reported. The lock is the
--      record that the return was filed; issueInvoice / voidInvoice in the
--      finance service refuse when the invoice's issue date falls inside an
--      active lock, and quote the lock's note back verbatim. Unlocking needs
--      a reason and both acts are audited, because an unlock is somebody
--      deciding to reopen a filed period.
--
--   3. finance.expenses.receipt_url — SCR-055 asks to attach a receipt; the
--      table had no column. A URL, like payment_submissions.proof_url: the
--      file lives wherever the agency keeps files and this is the pointer.
--
--   4. finance.reconciliations / reconciliation_items exist since
--      20260822260000 with SELECT policies only and no code over them (gap
--      row 053: "tables exist, no code"). An INSERT under forced RLS with no
--      INSERT policy is refused, so the service that never existed could not
--      have worked anyway. Write policies for owner / ops_admin, plus two
--      audited doors — open and close — because opening a period and
--      declaring it closed are the two decisions Doc 15 §29 puts a person's
--      name on. Items stay plain inserts/updates under RLS: the constraints
--      that migration already wrote (a match names a payment, the statement
--      line is frozen, a close over an unexplained item is refused) are the
--      rules, and they do not need a second copy in a function.
--
-- No extensions. Idempotent throughout.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. invoice sends and reminders ────────────────────────────────────────

create table if not exists finance.invoice_sends (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  invoice_id       uuid not null references finance.invoices(id) on delete cascade,

  kind             text not null check (kind in ('sent', 'reminder')),
  channel          text not null check (channel in ('whatsapp', 'email', 'manual')),

  sent_by          uuid references core.users(id) on delete set null,
  sent_at          timestamptz not null default now(),

  note             text check (note is null or length(btrim(note)) between 1 and 600),
  -- The provider's own id for the message, when the sender has one to paste.
  message_ref      text check (message_ref is null or length(btrim(message_ref)) between 1 and 200),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists invoice_sends_invoice_idx
  on finance.invoice_sends (organization_id, invoice_id, sent_at desc);

comment on table finance.invoice_sends is
  'SCR-051: the record that somebody sent an invoice, or chased it, on a channel, at a time. Records only - nothing here sends anything; the person did, and this is where they wrote it down.';

drop trigger if exists set_updated_at on finance.invoice_sends;
create trigger set_updated_at before update on finance.invoice_sends
  for each row execute function core.set_updated_at();

alter table finance.invoice_sends enable row level security;
alter table finance.invoice_sends force row level security;

drop policy if exists invoice_sends_select on finance.invoice_sends;
create policy invoice_sends_select on finance.invoice_sends
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

-- Owner and ops_admin: the two roles `invoice.issue` resolves to, and the
-- ones who send bills.
drop policy if exists invoice_sends_insert on finance.invoice_sends;
create policy invoice_sends_insert on finance.invoice_sends
  for insert to authenticated
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_admin())
  );

drop trigger if exists org_match_invoice_sends_invoice on finance.invoice_sends;
create trigger org_match_invoice_sends_invoice
  before insert or update of invoice_id, organization_id on finance.invoice_sends
  for each row execute function core.enforce_parent_org('invoice_id', 'finance.invoices');

drop trigger if exists freeze_org_invoice_sends on finance.invoice_sends;
create trigger freeze_org_invoice_sends
  before update of organization_id on finance.invoice_sends
  for each row execute function core.freeze_organization_id();

-- Append-only from the application's side: a send that happened is not
-- edited afterwards. No update or delete grant.
grant select, insert on finance.invoice_sends to authenticated, service_role;

-- The one door. SECURITY INVOKER: the insert policy above still decides, and
-- the audit row is written in the same transaction as the record.
create or replace function finance.record_invoice_send(
  p_invoice_id  uuid,
  p_kind        text,
  p_channel     text,
  p_note        text default null,
  p_message_ref text default null,
  p_sent_at     timestamptz default null
)
returns table (outcome text, send_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_invoice finance.invoices;
  v_id      uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid;
    return;
  end if;

  select * into v_invoice from finance.invoices where id = p_invoice_id;
  if v_invoice.id is null then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  -- A draft has not reached the client, so it cannot have been sent to one.
  if v_invoice.status in ('draft', 'pending_approval') then
    return query select 'not_issued'::text, null::uuid;
    return;
  end if;

  insert into finance.invoice_sends (
    organization_id, invoice_id, kind, channel, sent_by, sent_at, note, message_ref
  )
  values (
    v_invoice.organization_id, v_invoice.id, p_kind, p_channel, v_actor,
    coalesce(p_sent_at, now()), nullif(btrim(p_note), ''), nullif(btrim(p_message_ref), '')
  )
  returning id into v_id;

  perform core.record_audit(
    v_invoice.organization_id,
    case when p_kind = 'reminder' then 'invoice.reminded' else 'invoice.sent' end,
    'invoice',
    v_invoice.id,
    null,
    jsonb_build_object('send_id', v_id, 'channel', p_channel, 'kind', p_kind, 'number', v_invoice.number)
  );

  return query select 'recorded'::text, v_id;
end;
$$;

comment on function finance.record_invoice_send(uuid, text, text, text, text, timestamptz) is
  'SCR-051: records that an issued invoice was sent or chased on a channel. Sends nothing. SECURITY INVOKER so invoice_sends_insert (owner/ops_admin) decides; audits invoice.sent / invoice.reminded in the same transaction.';

revoke all on function finance.record_invoice_send(uuid, text, text, text, text, timestamptz) from public, anon;
grant execute on function finance.record_invoice_send(uuid, text, text, text, text, timestamptz) to authenticated, service_role;

-- ── 2. GST reporting period locks ─────────────────────────────────────────

create table if not exists finance.tax_period_locks (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- Half-open, like reconciliations: [period_start, period_end).
  period_start     date not null,
  period_end       date not null,

  locked_by        uuid references core.users(id) on delete set null,
  locked_at        timestamptz not null default now(),
  note             text check (note is null or length(btrim(note)) between 1 and 600),

  unlocked_at      timestamptz,
  unlocked_by      uuid references core.users(id) on delete set null,
  unlock_reason    text check (unlock_reason is null or length(btrim(unlock_reason)) between 1 and 600),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint tax_period_locks_period_is_a_period check (period_end > period_start),
  -- An unlock says who, when and why - or it has not happened.
  constraint tax_period_locks_unlock_says_why check (
    (unlocked_at is null and unlocked_by is null and unlock_reason is null)
    or (unlocked_at is not null and unlocked_by is not null and unlock_reason is not null)
  )
);

-- One ACTIVE lock per exact period; a re-lock after an unlock is a new row,
-- so the history of lock → unlock → lock is kept rather than overwritten.
create unique index if not exists tax_period_locks_one_active_per_period
  on finance.tax_period_locks (organization_id, period_start, period_end)
  where unlocked_at is null;

create index if not exists tax_period_locks_active_idx
  on finance.tax_period_locks (organization_id, period_start, period_end)
  where unlocked_at is null;

comment on table finance.tax_period_locks is
  'SCR-056: a reporting period whose GST return has been filed. While a lock is active the finance service refuses to issue or void an invoice whose issue date falls inside it. Unlocking needs a reason; both acts are audited.';

drop trigger if exists set_updated_at on finance.tax_period_locks;
create trigger set_updated_at before update on finance.tax_period_locks
  for each row execute function core.set_updated_at();

alter table finance.tax_period_locks enable row level security;
alter table finance.tax_period_locks force row level security;

drop policy if exists tax_period_locks_select on finance.tax_period_locks;
create policy tax_period_locks_select on finance.tax_period_locks
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists tax_period_locks_write on finance.tax_period_locks;
create policy tax_period_locks_write on finance.tax_period_locks
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_admin()))
  with check (organization_id = (select core.current_organization_id()) and (select core.is_admin()));

drop trigger if exists freeze_org_tax_period_locks on finance.tax_period_locks;
create trigger freeze_org_tax_period_locks
  before update of organization_id on finance.tax_period_locks
  for each row execute function core.freeze_organization_id();

grant select, insert, update on finance.tax_period_locks to authenticated, service_role;

create or replace function finance.lock_tax_period(
  p_period_start date,
  p_period_end   date,
  p_note         text default null
)
returns table (outcome text, lock_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_id    uuid;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid;
    return;
  end if;
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    return query select 'not_a_period'::text, null::uuid;
    return;
  end if;

  select id into v_id
    from finance.tax_period_locks
   where organization_id = v_org
     and period_start = p_period_start
     and period_end = p_period_end
     and unlocked_at is null;
  if v_id is not null then
    return query select 'already_locked'::text, v_id;
    return;
  end if;

  insert into finance.tax_period_locks (organization_id, period_start, period_end, locked_by, note)
  values (v_org, p_period_start, p_period_end, v_actor, nullif(btrim(p_note), ''))
  returning id into v_id;

  perform core.record_audit(
    v_org, 'tax_period.locked', 'tax_period_lock', v_id, null,
    jsonb_build_object('period_start', p_period_start, 'period_end', p_period_end, 'note', nullif(btrim(p_note), ''))
  );

  return query select 'locked'::text, v_id;
exception
  when unique_violation then
    -- Two people locked the same period at once; the first one's lock is the answer.
    select id into v_id
      from finance.tax_period_locks
     where organization_id = v_org and period_start = p_period_start and period_end = p_period_end and unlocked_at is null;
    return query select 'already_locked'::text, v_id;
end;
$$;

comment on function finance.lock_tax_period(date, date, text) is
  'SCR-056: locks a half-open reporting period after its return is filed. Owner/ops_admin via tax_period_locks_write; audits tax_period.locked in the same transaction.';

create or replace function finance.unlock_tax_period(
  p_lock_id uuid,
  p_reason  text
)
returns table (outcome text, lock_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_lock  finance.tax_period_locks;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid;
    return;
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    return query select 'no_reason'::text, p_lock_id;
    return;
  end if;

  select * into v_lock from finance.tax_period_locks where id = p_lock_id for update;
  if v_lock.id is null then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  if v_lock.unlocked_at is not null then
    return query select 'already_unlocked'::text, v_lock.id;
    return;
  end if;

  update finance.tax_period_locks
     set unlocked_at = now(), unlocked_by = v_actor, unlock_reason = btrim(p_reason)
   where id = v_lock.id;

  perform core.record_audit(
    v_lock.organization_id, 'tax_period.unlocked', 'tax_period_lock', v_lock.id,
    to_jsonb(v_lock),
    jsonb_build_object('period_start', v_lock.period_start, 'period_end', v_lock.period_end, 'unlock_reason', btrim(p_reason))
  );

  return query select 'unlocked'::text, v_lock.id;
end;
$$;

comment on function finance.unlock_tax_period(uuid, text) is
  'SCR-056: reopens a locked reporting period. Refuses without a reason; audits tax_period.unlocked with the reason in the same transaction.';

revoke all on function finance.lock_tax_period(date, date, text) from public, anon;
grant execute on function finance.lock_tax_period(date, date, text) to authenticated, service_role;
revoke all on function finance.unlock_tax_period(uuid, text) from public, anon;
grant execute on function finance.unlock_tax_period(uuid, text) to authenticated, service_role;

-- ── 3. the expense keeps its receipt ──────────────────────────────────────

alter table finance.expenses add column if not exists receipt_url text;

alter table finance.expenses drop constraint if exists expenses_receipt_url_is_a_url;
alter table finance.expenses add constraint expenses_receipt_url_is_a_url
  check (receipt_url is null or (receipt_url ~ '^https?://' and length(receipt_url) <= 2000));

comment on column finance.expenses.receipt_url is
  'SCR-055: where the receipt or vendor invoice lives, as a URL - the same shape as payment_submissions.proof_url. The file is not stored here.';

-- ── 4. reconciliation gets a door ─────────────────────────────────────────

drop policy if exists reconciliations_write on finance.reconciliations;
create policy reconciliations_write on finance.reconciliations
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_admin()))
  with check (organization_id = (select core.current_organization_id()) and (select core.is_admin()));

drop policy if exists reconciliation_items_write on finance.reconciliation_items;
create policy reconciliation_items_write on finance.reconciliation_items
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_admin()))
  with check (organization_id = (select core.current_organization_id()) and (select core.is_admin()));

create or replace function finance.open_reconciliation(
  p_period_start date,
  p_period_end   date,
  p_source       text,
  p_account_id   uuid default null
)
returns table (outcome text, reconciliation_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_id    uuid;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid;
    return;
  end if;
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    return query select 'not_a_period'::text, null::uuid;
    return;
  end if;
  if p_source is null or length(btrim(p_source)) = 0 then
    return query select 'no_source'::text, null::uuid;
    return;
  end if;

  insert into finance.reconciliations (organization_id, period_start, period_end, account_id, source, opened_by)
  values (v_org, p_period_start, p_period_end, p_account_id, btrim(p_source), v_actor)
  returning id into v_id;

  perform core.record_audit(
    v_org, 'reconciliation.opened', 'reconciliation', v_id, null,
    jsonb_build_object('period_start', p_period_start, 'period_end', p_period_end, 'source', btrim(p_source), 'account_id', p_account_id)
  );

  return query select 'opened'::text, v_id;
exception
  when unique_violation then
    -- reconciliations_one_open_per_account: this account already has an open period.
    select id into v_id
      from finance.reconciliations
     where organization_id = v_org
       and status = 'open'
       and coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(p_account_id, '00000000-0000-0000-0000-000000000000'::uuid);
    return query select 'already_open'::text, v_id;
end;
$$;

comment on function finance.open_reconciliation(date, date, text, uuid) is
  'Doc 15 §15/§29, SCR-053: opens a reconciliation period with its source and reconciler recorded. One open period per account (the partial unique index decides). Audits reconciliation.opened.';

create or replace function finance.close_reconciliation(p_reconciliation_id uuid)
returns table (outcome text, reconciliation_id uuid, unresolved int)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_recon finance.reconciliations;
  v_open  int;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, 0;
    return;
  end if;

  select * into v_recon from finance.reconciliations where id = p_reconciliation_id for update;
  if v_recon.id is null then
    return query select 'not_found'::text, null::uuid, 0;
    return;
  end if;
  if v_recon.status = 'closed' then
    return query select 'already_closed'::text, v_recon.id, 0;
    return;
  end if;

  -- The same count refuse_unresolved_close makes, answered as an outcome so
  -- the screen can say "3 items still unexplained" instead of an exception.
  select count(*) into v_open
    from finance.reconciliation_items i
   where i.reconciliation_id = v_recon.id
     and i.finding <> 'matched'
     and (i.reason is null or length(btrim(i.reason)) = 0);
  if v_open > 0 then
    return query select 'unresolved'::text, v_recon.id, v_open;
    return;
  end if;

  update finance.reconciliations
     set status = 'closed', closed_by = v_actor, closed_at = now()
   where id = v_recon.id;

  perform core.record_audit(
    v_recon.organization_id, 'reconciliation.closed', 'reconciliation', v_recon.id,
    to_jsonb(v_recon),
    jsonb_build_object('period_start', v_recon.period_start, 'period_end', v_recon.period_end, 'closed_by', v_actor)
  );

  return query select 'closed'::text, v_recon.id, 0;
end;
$$;

comment on function finance.close_reconciliation(uuid) is
  'Doc 15 §29, SCR-053: closes a period once every non-matched item carries a reason. refuse_unresolved_close still stands behind it; this answers the count as an outcome. Audits reconciliation.closed.';

revoke all on function finance.open_reconciliation(date, date, text, uuid) from public, anon;
grant execute on function finance.open_reconciliation(date, date, text, uuid) to authenticated, service_role;
revoke all on function finance.close_reconciliation(uuid) from public, anon;
grant execute on function finance.close_reconciliation(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
