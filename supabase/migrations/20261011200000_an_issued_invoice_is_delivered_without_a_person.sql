-- An issued invoice reaches the client without anyone pressing Send.
--
-- Phase 2 Finance §4.5 / Master §5.7: the M1 invoice is delivered to the client's
-- email AND the official project WhatsApp group, idempotently, with a failed
-- channel visible. Until now delivery was two staff-clicked buttons, and a
-- failure left no trace (`invoice_sends` records only what the provider
-- accepted). This is the per-channel record the spec calls InvoiceDelivery:
-- one row per invoice and channel, claimed before a send, settled after it,
-- and re-claimable until it is sent. Written only by the runner.

insert into core.event_types (type, description, canonical) values
  ('invoice.delivered', 'An issued invoice reached the client on a channel (email or whatsapp).', null)
on conflict (type) do nothing;

create table if not exists finance.invoice_deliveries (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  invoice_id      uuid not null references finance.invoices(id) on delete cascade,
  channel         text not null check (channel in ('whatsapp', 'email')),
  status          text not null default 'pending'
                  check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts        integer not null default 0 check (attempts >= 0),
  destination     text check (destination is null or length(btrim(destination)) between 1 and 320),
  conversation_id uuid references crm.conversations(id) on delete set null,
  message_ref     text check (message_ref is null or length(btrim(message_ref)) between 1 and 200),
  last_error      text check (last_error is null or length(btrim(last_error)) between 1 and 600),
  delivered_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint invoice_deliveries_one_per_channel unique (invoice_id, channel),
  constraint invoice_deliveries_sent_has_time check (status <> 'sent' or delivered_at is not null)
);

comment on table finance.invoice_deliveries is
  'Phase 2 Finance §14 InvoiceDelivery: one row per issued invoice and channel. pending = claimed, not settled; sent = the provider accepted it (delivered_at set); failed = an attempt failed and will be retried or has run out of retries; skipped = nothing could be attempted (no email configured, no address, no thread) with the reason in last_error. Only the runner writes it.';

create index if not exists invoice_deliveries_open_idx
  on finance.invoice_deliveries (organization_id, status)
  where status <> 'sent';

drop trigger if exists set_updated_at on finance.invoice_deliveries;
create trigger set_updated_at before update on finance.invoice_deliveries
  for each row execute function core.set_updated_at();

alter table finance.invoice_deliveries enable row level security;
alter table finance.invoice_deliveries force row level security;

drop policy if exists invoice_deliveries_select on finance.invoice_deliveries;
create policy invoice_deliveries_select on finance.invoice_deliveries
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop trigger if exists org_match_invoice_deliveries_invoice on finance.invoice_deliveries;
create trigger org_match_invoice_deliveries_invoice
  before insert or update of invoice_id, organization_id on finance.invoice_deliveries
  for each row execute function core.enforce_parent_org('invoice_id', 'finance.invoices');

drop trigger if exists org_match_invoice_deliveries_conversation on finance.invoice_deliveries;
create trigger org_match_invoice_deliveries_conversation
  before insert or update of conversation_id, organization_id on finance.invoice_deliveries
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');

drop trigger if exists freeze_org_invoice_deliveries on finance.invoice_deliveries;
create trigger freeze_org_invoice_deliveries
  before update of organization_id on finance.invoice_deliveries
  for each row execute function core.freeze_organization_id();

-- No delete grant anywhere: a delivery that was attempted is history.
grant select on finance.invoice_deliveries to authenticated;
grant select, insert, update on finance.invoice_deliveries to service_role;

-- ── claim ──────────────────────────────────────────────────────────────────
-- One attempt at a time per invoice (the invoice row is the lock), and a
-- channel already sent is never claimed again - the idempotency the spec asks
-- for. A failed or skipped channel IS re-claimable: that is the retry.
create or replace function finance.claim_invoice_delivery(p_invoice_id uuid, p_channel text)
returns table (outcome text, delivery_id uuid, attempts integer)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_invoice finance.invoices;
  v_row     finance.invoice_deliveries;
begin
  if p_channel not in ('whatsapp', 'email') then
    return query select 'bad_channel'::text, null::uuid, 0; return;
  end if;

  select * into v_invoice from finance.invoices where id = p_invoice_id for update;
  if v_invoice.id is null then
    return query select 'not_found'::text, null::uuid, 0; return;
  end if;
  -- A draft has not reached the client and a void never should.
  if v_invoice.status not in ('issued', 'partially_paid', 'overdue', 'paid') then
    return query select 'not_deliverable'::text, null::uuid, 0; return;
  end if;
  -- Nothing payable is not a bill to deliver here (the free-maintenance
  -- document has its own path).
  if v_invoice.total_minor <= 0 then
    return query select 'nothing_payable'::text, null::uuid, 0; return;
  end if;

  insert into finance.invoice_deliveries (organization_id, invoice_id, channel)
  values (v_invoice.organization_id, v_invoice.id, p_channel)
  on conflict (invoice_id, channel) do nothing;

  select * into v_row from finance.invoice_deliveries d
   where d.invoice_id = v_invoice.id and d.channel = p_channel for update;

  if v_row.status = 'sent' then
    return query select 'already_delivered'::text, v_row.id, v_row.attempts; return;
  end if;

  update finance.invoice_deliveries
     set status = 'pending', attempts = v_row.attempts + 1
   where id = v_row.id;

  return query select 'claimed'::text, v_row.id, v_row.attempts + 1;
end;
$$;
revoke all on function finance.claim_invoice_delivery(uuid, text) from public, anon, authenticated;
grant execute on function finance.claim_invoice_delivery(uuid, text) to service_role;

-- ── settle ─────────────────────────────────────────────────────────────────
-- The attempt's outcome, audited, with the legacy "last sent" record written
-- on success so the invoice list keeps showing when a bill went out.
create or replace function finance.settle_invoice_delivery(
  p_delivery_id     uuid,
  p_status          text,
  p_destination     text default null,
  p_conversation_id uuid default null,
  p_message_ref     text default null,
  p_error           text default null
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row     finance.invoice_deliveries;
  v_invoice finance.invoices;
begin
  if p_status not in ('sent', 'failed', 'skipped') then
    return 'bad_status';
  end if;

  select * into v_row from finance.invoice_deliveries where id = p_delivery_id for update;
  if v_row.id is null then return 'not_found'; end if;
  -- Sent is terminal: a late or replayed settle cannot undo it.
  if v_row.status = 'sent' then return 'already_delivered'; end if;

  update finance.invoice_deliveries
     set status = p_status,
         destination = coalesce(nullif(btrim(p_destination), ''), destination),
         conversation_id = coalesce(p_conversation_id, conversation_id),
         message_ref = coalesce(nullif(btrim(p_message_ref), ''), message_ref),
         last_error = case when p_status = 'sent' then null else left(nullif(btrim(coalesce(p_error, '')), ''), 600) end,
         delivered_at = case when p_status = 'sent' then now() else delivered_at end
   where id = v_row.id;

  select * into v_invoice from finance.invoices where id = v_row.invoice_id;

  perform core.record_audit(
    v_row.organization_id,
    'invoice.delivery_' || p_status,
    'invoice',
    v_row.invoice_id,
    null,
    jsonb_build_object(
      'delivery_id', v_row.id, 'channel', v_row.channel, 'attempt', v_row.attempts,
      'destination', p_destination, 'message_ref', p_message_ref, 'error', left(p_error, 300),
      'number', v_invoice.number
    )
  );

  if p_status = 'sent' then
    insert into finance.invoice_sends (organization_id, invoice_id, kind, channel, sent_by, automatic, conversation_id, message_ref, note)
    values (v_row.organization_id, v_row.invoice_id, 'sent', v_row.channel, null, true, p_conversation_id, p_message_ref,
            'Delivered automatically on issue');
    perform core.emit_event(
      v_row.organization_id, 'invoice.delivered', 'invoice', v_row.invoice_id,
      jsonb_build_object('channel', v_row.channel, 'deliveryId', v_row.id)
    );
  end if;

  return 'settled';
end;
$$;
revoke all on function finance.settle_invoice_delivery(uuid, text, text, uuid, text, text) from public, anon, authenticated;
grant execute on function finance.settle_invoice_delivery(uuid, text, text, uuid, text, text) to service_role;

-- ── a bill is not a quotation ──────────────────────────────────────────────
-- ADM-22 keeps every PRICE the agency quotes a human's decision, and
-- `crm.refuse_unread_price` enforces it on any message with no human author.
-- An invoice's amount is not a price anyone is quoting: it is the ledger's
-- figure on a document a person has already issued. Found by the first
-- automatic delivery, which was refused "an automated message may not state a
-- price" - and, reading why, the owner's automatic past-due reminders
-- (2026-09-29, "go automatically") have been refused by the same trigger since
-- they were built: they name the outstanding amount and carry no author.
--
-- So the two ledger-derived system messages are exempt, by the external_ref
-- only the runner's own code writes: `invoice-deliver:` and `invoice-reminder:`.
-- Everything else - the agent's replies, follow-ups, anything composed by a
-- model - is bound exactly as before.
create or replace function crm.refuse_unread_price()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
begin
  -- An agency message with a human behind it is exactly what ADM-22 wants:
  -- every price quoted per client, by a person. Only the unread path is bound.
  if new.author_type = 'user' and new.author_id is null
     and crm.states_a_price(new.body)
     -- ── EDIT (ADM-96, G-162): internal channels are exempt ────────────────
     -- The agency saying a number to ITSELF is how the number gets an owner.
     -- Only the two internal kinds - a project_group has clients in it and
     -- stays under the original rule.
     and not exists (
       select 1
         from crm.conversations c
        where c.id = new.conversation_id
          and c.kind in ('internal_direct', 'internal_group')
     )
     -- ── EDIT (Phase 2 Finance §4.5): a bill from the ledger is not a quote ─
     and coalesce(new.external_ref, '') !~ '^invoice-(deliver|reminder):' then
    raise exception
      'an automated message may not state a price (ADM-22); a human must author anything that quotes one'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;
