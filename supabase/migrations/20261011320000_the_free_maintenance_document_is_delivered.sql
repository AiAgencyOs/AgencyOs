-- The free-maintenance document is delivered too.
--
-- Finance §9: after Phase 7, a project whose maintenance was included free gets
-- a ₹0 document sent by email and the project WhatsApp group - with NO payment
-- collection and NO Admin verification. The delivery door refused anything with
-- nothing payable, which is right for a bill and wrong for this; the exception
-- is the plan the document records, so a stray zero-rupee invoice is still
-- refused. Carried forward from claim_invoice_delivery's live body with that one
-- change.

CREATE OR REPLACE FUNCTION finance.claim_invoice_delivery(p_invoice_id uuid, p_channel text)
 RETURNS TABLE(outcome text, delivery_id uuid, attempts integer)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  -- Nothing payable is not a bill to deliver - EXCEPT the free-maintenance
  -- document (Finance §9), which is a ₹0 invoice on purpose and is sent to the
  -- client by both channels like any other. It is recognised by the plan it
  -- records, never by its amount alone.
  if v_invoice.total_minor <= 0 and v_invoice.maintenance_plan_id is null then
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
$function$;
