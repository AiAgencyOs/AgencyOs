-- ═══════════════════════════════════════════════════════════════════════════
-- The bill is sent, chased automatically, and the bank statement is read.
--
-- Decision: reversed by the owner on 2026-09-29.
--
-- Three decisions from the owner's session of 2026-09-29 (AGENT_BRIEF_D.md,
-- decisions 1 and 2, and the composer template-send reversal), on the finance
-- screens SCR-051 (Invoices), SCR-053 (Payments / reconciliation) and
-- Settings › Finance:
--
--   1. finance.invoice_sends learns two things. `automatic` says the system
--      chased the bill rather than a person, and `conversation_id` says on
--      which WhatsApp thread. 20260929160000 wrote this table as a record
--      only ("nothing here sends anything"); the owner reversed that: an
--      invoice and its reminders GO over WhatsApp through the same governed
--      door quotations use (crm.send_outbound_message → provider), and this
--      table is where the act is written down beside the message it became.
--
--   2. Past-due reminders go AUTOMATICALLY, inside the 24-hour window as
--      text and outside it with an approved template, so the organization
--      gets two real columns — `invoice_reminders_enabled` and
--      `invoice_reminder_interval_days` — behind one audited door
--      (`core.set_invoice_reminder_policy`), the shape
--      `set_wake_runner_on_inbound` already has. Off by default: a deployment
--      that never opens Settings › Finance chases nobody, exactly as today.
--      The runner's sweep observes candidates (`observe_invoice_reminder_
--      candidates`), claims one reminder per invoice per interval
--      (`claim_invoice_reminder`, the invoice_sends row IS the claim) and
--      hands the message to the follow-up delivery handler. `invoice_reminder`
--      joins the template situations so an Admin can register the approved
--      template that carries the reminder when the window is shut.
--
--   3. finance.bank_statement_lines — the bank CSV upload (date, description,
--      amount, reference). 20260822260000 wrote reconciliation_items for lines
--      typed by hand and the panel said "there is no bank import". The upload
--      is that import: each CSV row is kept verbatim as a line, the panel
--      PROPOSES matches against recorded payments and pending claims by
--      amount and reference, and a person confirms one — which writes the
--      reconciliation_item (finding `matched`, naming the payment) through
--      `confirm_bank_line_match`, the same row the hand-typed path writes.
--      Nothing here alters a payment (Doc 15 §15).
--
-- Every governed write audits in its own transaction. No extensions.
-- Idempotent throughout.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the send record learns who sent it and on which thread ─────────────

alter table finance.invoice_sends
  add column if not exists automatic boolean not null default false;

alter table finance.invoice_sends
  add column if not exists conversation_id uuid references crm.conversations(id) on delete set null;

comment on column finance.invoice_sends.automatic is
  'True when the runner chased the bill on its own (owner decision 2026-09-29). sent_by is null on such a row; the interval that allowed it is in the audit row.';
comment on column finance.invoice_sends.conversation_id is
  'The WhatsApp thread the invoice or reminder was sent on, when AgencyOS sent it. message_ref then carries the external_ref of the crm.conversation_messages row, which is where the delivery state lives.';

create index if not exists invoice_sends_reminder_idx
  on finance.invoice_sends (organization_id, invoice_id, kind, sent_at desc);

drop trigger if exists org_match_invoice_sends_conversation on finance.invoice_sends;
create trigger org_match_invoice_sends_conversation
  before insert or update of conversation_id, organization_id on finance.invoice_sends
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');

-- The runner may say, on the row it wrote, why nothing went (consent
-- withdrawn, no thread). Only the note, only the service role: the row stays
-- append-only for every person.
grant update (note) on finance.invoice_sends to service_role;

-- The one door, carried forward VERBATIM from 20260929160000 with one
-- addition: `p_conversation_id`, the thread AgencyOS sent on. Dropped and
-- recreated rather than overloaded, because two functions of the same name
-- differing only in a defaulted trailing argument are ambiguous to a named-
-- argument RPC call and PostgREST refuses both.
drop function if exists finance.record_invoice_send(uuid, text, text, text, text, timestamptz);

create or replace function finance.record_invoice_send(
  p_invoice_id      uuid,
  p_kind            text,
  p_channel         text,
  p_note            text default null,
  p_message_ref     text default null,
  p_sent_at         timestamptz default null,
  p_conversation_id uuid default null
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
    organization_id, invoice_id, kind, channel, sent_by, sent_at, note, message_ref, conversation_id
  )
  values (
    v_invoice.organization_id, v_invoice.id, p_kind, p_channel, v_actor,
    coalesce(p_sent_at, now()), nullif(btrim(p_note), ''), nullif(btrim(p_message_ref), ''), p_conversation_id
  )
  returning id into v_id;

  perform core.record_audit(
    v_invoice.organization_id,
    case when p_kind = 'reminder' then 'invoice.reminded' else 'invoice.sent' end,
    'invoice',
    v_invoice.id,
    null,
    jsonb_build_object(
      'send_id', v_id, 'channel', p_channel, 'kind', p_kind, 'number', v_invoice.number,
      'conversation_id', p_conversation_id, 'automatic', false
    )
  );

  return query select 'recorded'::text, v_id;
end;
$$;

comment on function finance.record_invoice_send(uuid, text, text, text, text, timestamptz, uuid) is
  'SCR-051: records that an issued invoice was sent or chased on a channel — by hand, or by AgencyOS itself over WhatsApp (owner decision 2026-09-29), in which case p_conversation_id names the thread and p_message_ref the message. SECURITY INVOKER so invoice_sends_insert (owner/ops_admin) decides; audits invoice.sent / invoice.reminded in the same transaction.';

revoke all on function finance.record_invoice_send(uuid, text, text, text, text, timestamptz, uuid) from public, anon;
grant execute on function finance.record_invoice_send(uuid, text, text, text, text, timestamptz, uuid) to authenticated, service_role;

-- ── 2. the reminder policy: two real columns and one audited door ─────────

alter table core.organizations
  add column if not exists invoice_reminders_enabled boolean not null default false;

alter table core.organizations
  add column if not exists invoice_reminder_interval_days int not null default 7;

alter table core.organizations drop constraint if exists organizations_reminder_interval_is_days;
alter table core.organizations add constraint organizations_reminder_interval_is_days
  check (invoice_reminder_interval_days between 1 and 90);

comment on column core.organizations.invoice_reminders_enabled is
  'Settings › Finance: whether the runner chases past-due invoices on WhatsApp by itself. Off by default (owner decision 2026-09-29).';
comment on column core.organizations.invoice_reminder_interval_days is
  'Settings › Finance: the fewest days between two reminders for one invoice, and between the invoice being sent and the first reminder. 1–90.';

create or replace function core.set_invoice_reminder_policy(
  p_organization_id uuid,
  p_enabled         boolean,
  p_interval_days   int
)
returns table (outcome text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_before core.organizations;
begin
  if v_actor is not null and not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text; return;
  end if;
  if v_actor is not null and p_organization_id is distinct from (select core.current_organization_id()) then
    return query select 'forbidden'::text; return;
  end if;
  if p_interval_days is null or p_interval_days < 1 or p_interval_days > 90 then
    return query select 'invalid_interval'::text; return;
  end if;

  select * into v_before from core.organizations o where o.id = p_organization_id;
  if v_before.id is null then
    return query select 'not_found'::text; return;
  end if;

  update core.organizations
     set invoice_reminders_enabled = coalesce(p_enabled, false),
         invoice_reminder_interval_days = p_interval_days
   where id = p_organization_id;

  perform core.record_audit(
    p_organization_id,
    case when coalesce(p_enabled, false) then 'invoice_reminders.enabled' else 'invoice_reminders.disabled' end,
    'organization', p_organization_id,
    jsonb_build_object('enabled', v_before.invoice_reminders_enabled, 'interval_days', v_before.invoice_reminder_interval_days),
    jsonb_build_object('enabled', coalesce(p_enabled, false), 'interval_days', p_interval_days),
    null
  );

  return query select case when coalesce(p_enabled, false) then 'enabled' else 'disabled' end::text;
end;
$$;

comment on function core.set_invoice_reminder_policy(uuid, boolean, int) is
  'Settings › Finance: turns automatic past-due reminders on or off and sets the interval in days. Owner or ops_admin in the database as well as the service; audited both ways with the old and new values (owner decision 2026-09-29).';

revoke all on function core.set_invoice_reminder_policy(uuid, boolean, int) from public, anon;
grant execute on function core.set_invoice_reminder_policy(uuid, boolean, int) to authenticated, service_role;

-- The organizations row is what the runner's sweep and the settings page
-- read; the existing update policies on core.organizations still stand, and
-- the door above is the only writer of these two columns from the app.

-- ── 3. what the runner chases ─────────────────────────────────────────────

create or replace function finance.observe_invoice_reminder_candidates(p_limit int default 50)
returns table (
  invoice_id        uuid,
  organization_id   uuid,
  client_account_id uuid,
  project_id        uuid,
  invoice_number    text,
  currency          text,
  total_minor       bigint,
  paid_minor        bigint,
  due_at            timestamptz,
  interval_days     int
)
language sql
stable
security invoker
set search_path = ''
as $$
  select i.id, i.organization_id, i.client_account_id, i.project_id, i.number, i.currency,
         i.total_minor::bigint, i.paid_minor::bigint, i.due_at, o.invoice_reminder_interval_days
    from finance.invoices i
    join core.organizations o on o.id = i.organization_id
   where o.invoice_reminders_enabled
     and i.status in ('issued', 'partially_paid', 'overdue')
     and i.due_at is not null
     and i.due_at < now()
     -- Nothing sent or chased on this bill inside the interval: a bill sent
     -- yesterday is not chased today, and one chased on Monday waits.
     and not exists (
       select 1 from finance.invoice_sends s
        where s.invoice_id = i.id
          and s.sent_at > now() - make_interval(days => o.invoice_reminder_interval_days)
     )
   order by i.due_at
   limit p_limit
$$;

comment on function finance.observe_invoice_reminder_candidates(int) is
  'The runner''s observation: past-due invoices in organizations that turned reminders on, with no send or reminder recorded inside the interval. Observes only; claim_invoice_reminder is the claim. Service role only.';

revoke all on function finance.observe_invoice_reminder_candidates(int) from public, anon, authenticated;
grant execute on function finance.observe_invoice_reminder_candidates(int) to service_role;

create or replace function finance.claim_invoice_reminder(
  p_invoice_id      uuid,
  p_interval_days   int,
  p_conversation_id uuid default null
)
returns table (outcome text, send_id uuid, external_ref text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_invoice finance.invoices;
  v_id      uuid;
  v_ref     text;
begin
  select * into v_invoice from finance.invoices where id = p_invoice_id for update;
  if v_invoice.id is null then
    return query select 'not_found'::text, null::uuid, null::text; return;
  end if;
  if v_invoice.status not in ('issued', 'partially_paid', 'overdue')
     or v_invoice.due_at is null or v_invoice.due_at >= now() then
    return query select 'not_due'::text, null::uuid, null::text; return;
  end if;

  -- Restated under the lock: two overlapping ticks observe the same invoice,
  -- and the second must find the first's row rather than chase twice.
  if exists (
    select 1 from finance.invoice_sends s
     where s.invoice_id = v_invoice.id
       and s.sent_at > now() - make_interval(days => greatest(coalesce(p_interval_days, 1), 1))
  ) then
    return query select 'too_soon'::text, null::uuid, null::text; return;
  end if;

  v_id := gen_random_uuid();
  v_ref := 'invoice-reminder:' || v_id::text;

  insert into finance.invoice_sends (
    id, organization_id, invoice_id, kind, channel, sent_by, automatic, conversation_id, message_ref, note
  )
  values (
    v_id, v_invoice.organization_id, v_invoice.id, 'reminder', 'whatsapp', null, true, p_conversation_id, v_ref,
    'Automatic past-due reminder'
  );

  perform core.record_audit(
    v_invoice.organization_id,
    'invoice.reminded',
    'invoice',
    v_invoice.id,
    null,
    jsonb_build_object(
      'send_id', v_id, 'channel', 'whatsapp', 'kind', 'reminder', 'automatic', true,
      'number', v_invoice.number, 'interval_days', p_interval_days, 'conversation_id', p_conversation_id
    )
  );

  return query select 'claimed'::text, v_id, v_ref;
end;
$$;

comment on function finance.claim_invoice_reminder(uuid, int, uuid) is
  'The runner''s claim: one automatic reminder per invoice per interval, re-checked under the invoice lock. The invoice_sends row is the claim and carries the external_ref the outbound message is queued under. Audits invoice.reminded with automatic=true. Service role only.';

revoke all on function finance.claim_invoice_reminder(uuid, int, uuid) from public, anon, authenticated;
grant execute on function finance.claim_invoice_reminder(uuid, int, uuid) to service_role;

create or replace function finance.record_invoice_reminder_outcome(
  p_send_id uuid,
  p_note    text
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  update finance.invoice_sends
     set note = left(btrim(coalesce(p_note, '')), 600)
   where id = p_send_id
     and automatic;
  return found;
end;
$$;

comment on function finance.record_invoice_reminder_outcome(uuid, text) is
  'The runner writes, on its own automatic row only, why the reminder did not go (no consent, no thread) so the Reminders section says so instead of showing a silence. Service role only.';

revoke all on function finance.record_invoice_reminder_outcome(uuid, text) from public, anon, authenticated;
grant execute on function finance.record_invoice_reminder_outcome(uuid, text) to service_role;

-- ── 4. the reminder is a template situation ───────────────────────────────
--
-- Carried forward from 20260913160000 with one addition; the list is restated
-- rather than appended to because a CHECK cannot be appended to.

alter table crm.whatsapp_templates
  drop constraint if exists whatsapp_templates_situation_key_check;

alter table crm.whatsapp_templates
  add constraint whatsapp_templates_situation_key_check check (situation_key in (
    'no_response_after_quotation',
    'no_response_after_requirements',
    'no_response_after_proposal',
    'abandoned_conversation',
    'pending_approval',
    'inactive_lead',
    'post_project',
    'internal_approval',
    'quotation_approved',
    'internal_notice',
    'agent_message',
    'missed_meeting',
    -- Owner decision 2026-09-29: a past-due reminder outside the 24-hour
    -- window goes as the approved template registered here. No row is
    -- written: the words are approved at Meta and registered by a person.
    'invoice_reminder'
  ));

-- ── 5. the bank statement, line by line ───────────────────────────────────

create table if not exists finance.bank_statement_lines (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  reconciliation_id uuid not null references finance.reconciliations(id) on delete cascade,

  -- One upload is one batch; the line number is its position in the file.
  import_batch      uuid not null,
  source_filename   text check (source_filename is null or length(btrim(source_filename)) between 1 and 200),
  line_no           int  not null check (line_no > 0),

  -- The four CSV columns, verbatim as parsed. §29: keep the evidence.
  statement_date    date   not null,
  description       text   not null check (length(btrim(description)) between 1 and 500),
  amount_minor      bigint not null,
  reference         text   check (reference is null or length(btrim(reference)) between 1 and 200),

  -- pending → confirmed (a person matched it, item_id names the row) or
  -- ignored (a person said why it is not ours to reconcile).
  status            text not null default 'pending' check (status in ('pending', 'confirmed', 'ignored')),
  item_id           uuid references finance.reconciliation_items(id) on delete set null,
  ignored_reason    text check (ignored_reason is null or length(btrim(ignored_reason)) between 1 and 600),

  imported_by       uuid references core.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint bank_statement_lines_confirmed_names_an_item check (
    status <> 'confirmed' or item_id is not null
  ),
  constraint bank_statement_lines_ignored_says_why check (
    status <> 'ignored' or ignored_reason is not null
  ),
  constraint bank_statement_lines_one_per_batch_position unique (organization_id, import_batch, line_no)
);

create index if not exists bank_statement_lines_recon_idx
  on finance.bank_statement_lines (organization_id, reconciliation_id, status, statement_date);

comment on table finance.bank_statement_lines is
  'SCR-053: the bank statement as uploaded (CSV: date, description, amount, reference), one row per line, kept verbatim. A confirmed line names the reconciliation_item it became; an ignored line says why. Nothing here alters a payment (owner decision 2026-09-29).';

drop trigger if exists set_updated_at on finance.bank_statement_lines;
create trigger set_updated_at before update on finance.bank_statement_lines
  for each row execute function core.set_updated_at();

alter table finance.bank_statement_lines enable row level security;
alter table finance.bank_statement_lines force row level security;

drop policy if exists bank_statement_lines_select on finance.bank_statement_lines;
create policy bank_statement_lines_select on finance.bank_statement_lines
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

-- Owner and ops_admin, the pair reconciliations_write admits.
drop policy if exists bank_statement_lines_write on finance.bank_statement_lines;
create policy bank_statement_lines_write on finance.bank_statement_lines
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_admin()))
  with check (organization_id = (select core.current_organization_id()) and (select core.is_admin()));

drop trigger if exists org_match_bank_statement_lines_reconciliation on finance.bank_statement_lines;
create trigger org_match_bank_statement_lines_reconciliation
  before insert or update of reconciliation_id, organization_id on finance.bank_statement_lines
  for each row execute function core.enforce_parent_org('reconciliation_id', 'finance.reconciliations');

drop trigger if exists org_match_bank_statement_lines_item on finance.bank_statement_lines;
create trigger org_match_bank_statement_lines_item
  before insert or update of item_id, organization_id on finance.bank_statement_lines
  for each row execute function core.enforce_parent_org('item_id', 'finance.reconciliation_items');

drop trigger if exists freeze_org_bank_statement_lines on finance.bank_statement_lines;
create trigger freeze_org_bank_statement_lines
  before update of organization_id on finance.bank_statement_lines
  for each row execute function core.freeze_organization_id();

-- No delete: an uploaded line is evidence. A wrong upload is ignored with a reason.
grant select, insert, update on finance.bank_statement_lines to authenticated, service_role;

create or replace function finance.import_bank_statement_lines(
  p_reconciliation_id uuid,
  p_source_filename   text,
  p_lines             jsonb
)
returns table (outcome text, batch_id uuid, imported int)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_recon finance.reconciliations;
  v_batch uuid := gen_random_uuid();
  v_count int  := 0;
  v_line  jsonb;
  v_no    int  := 0;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, 0; return;
  end if;

  select * into v_recon from finance.reconciliations where id = p_reconciliation_id;
  if v_recon.id is null then
    return query select 'not_found'::text, null::uuid, 0; return;
  end if;
  if v_recon.status = 'closed' then
    return query select 'closed'::text, v_recon.id, 0; return;
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    return query select 'empty'::text, null::uuid, 0; return;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_no := v_no + 1;
    insert into finance.bank_statement_lines (
      organization_id, reconciliation_id, import_batch, source_filename, line_no,
      statement_date, description, amount_minor, reference, imported_by
    )
    values (
      v_recon.organization_id, v_recon.id, v_batch, nullif(btrim(coalesce(p_source_filename, '')), ''),
      coalesce((v_line->>'line_no')::int, v_no),
      (v_line->>'date')::date,
      btrim(v_line->>'description'),
      (v_line->>'amount_minor')::bigint,
      nullif(btrim(coalesce(v_line->>'reference', '')), ''),
      v_actor
    );
    v_count := v_count + 1;
  end loop;

  perform core.record_audit(
    v_recon.organization_id, 'bank_statement.imported', 'reconciliation', v_recon.id, null,
    jsonb_build_object('batch_id', v_batch, 'lines', v_count, 'source_filename', nullif(btrim(coalesce(p_source_filename, '')), ''))
  );

  return query select 'imported'::text, v_batch, v_count;
end;
$$;

comment on function finance.import_bank_statement_lines(uuid, text, jsonb) is
  'SCR-053: files one uploaded CSV (parsed by the app into date / description / amount_minor / reference) as one batch of bank_statement_lines on an open reconciliation. SECURITY INVOKER so bank_statement_lines_write (owner/ops_admin) decides; audits bank_statement.imported with the count.';

revoke all on function finance.import_bank_statement_lines(uuid, text, jsonb) from public, anon;
grant execute on function finance.import_bank_statement_lines(uuid, text, jsonb) to authenticated, service_role;

create or replace function finance.confirm_bank_line_match(
  p_line_id    uuid,
  p_payment_id uuid,
  p_reason     text default null
)
returns table (outcome text, item_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_line  finance.bank_statement_lines;
  v_recon finance.reconciliations;
  v_pay   finance.payments;
  v_item  uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  select * into v_line from finance.bank_statement_lines where id = p_line_id for update;
  if v_line.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if v_line.status <> 'pending' then
    return query select 'already_resolved'::text, v_line.item_id; return;
  end if;

  select * into v_recon from finance.reconciliations where id = v_line.reconciliation_id;
  if v_recon.status = 'closed' then
    return query select 'closed'::text, null::uuid; return;
  end if;

  select * into v_pay from finance.payments
   where id = p_payment_id and organization_id = v_line.organization_id;
  if v_pay.id is null then
    return query select 'payment_not_found'::text, null::uuid; return;
  end if;

  -- The same row the hand-typed path writes: the line verbatim, our reading
  -- beside it, finding `matched`, naming the payment. The item's own
  -- constraints (a match names a payment; the line is frozen) still stand.
  insert into finance.reconciliation_items (
    organization_id, reconciliation_id, statement_line, statement_date, amount_minor, reference, finding, payment_id, reason
  )
  values (
    v_line.organization_id, v_line.reconciliation_id,
    left(to_char(v_line.statement_date, 'YYYY-MM-DD') || '  ' || v_line.description
         || '  ' || (v_line.amount_minor::numeric / 100)::text
         || coalesce('  ' || v_line.reference, ''), 500),
    v_line.statement_date, v_line.amount_minor, v_line.reference, 'matched', v_pay.id,
    nullif(btrim(coalesce(p_reason, '')), '')
  )
  returning id into v_item;

  update finance.bank_statement_lines
     set status = 'confirmed', item_id = v_item
   where id = v_line.id;

  perform core.record_audit(
    v_line.organization_id, 'bank_statement_line.matched', 'reconciliation_item', v_item, null,
    jsonb_build_object(
      'line_id', v_line.id, 'reconciliation_id', v_line.reconciliation_id, 'payment_id', v_pay.id,
      'amount_minor', v_line.amount_minor, 'reference', v_line.reference, 'statement_date', v_line.statement_date
    )
  );

  return query select 'matched'::text, v_item;
end;
$$;

comment on function finance.confirm_bank_line_match(uuid, uuid, text) is
  'SCR-053: a person confirms a proposed match. Writes the reconciliation_item (finding matched, naming the payment) the hand-typed path would have written, marks the line confirmed, audits bank_statement_line.matched. Refuses on a closed period or a line already resolved. Alters no payment.';

revoke all on function finance.confirm_bank_line_match(uuid, uuid, text) from public, anon;
grant execute on function finance.confirm_bank_line_match(uuid, uuid, text) to authenticated, service_role;

create or replace function finance.ignore_bank_line(
  p_line_id uuid,
  p_reason  text
)
returns table (outcome text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_line  finance.bank_statement_lines;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    return query select 'no_reason'::text; return;
  end if;

  select * into v_line from finance.bank_statement_lines where id = p_line_id for update;
  if v_line.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_line.status <> 'pending' then
    return query select 'already_resolved'::text; return;
  end if;

  update finance.bank_statement_lines
     set status = 'ignored', ignored_reason = btrim(p_reason)
   where id = v_line.id;

  perform core.record_audit(
    v_line.organization_id, 'bank_statement_line.ignored', 'reconciliation', v_line.reconciliation_id, null,
    jsonb_build_object('line_id', v_line.id, 'amount_minor', v_line.amount_minor, 'reason', btrim(p_reason))
  );

  return query select 'ignored'::text;
end;
$$;

comment on function finance.ignore_bank_line(uuid, text) is
  'SCR-053: a person sets an uploaded line aside with a reason (bank charges, a transfer between own accounts). Audited; the line is kept.';

revoke all on function finance.ignore_bank_line(uuid, text) from public, anon;
grant execute on function finance.ignore_bank_line(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
