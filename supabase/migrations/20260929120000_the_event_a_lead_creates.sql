-- ═══════════════════════════════════════════════════════════════════════════
-- The event a lead creates — Audit 1.2/1.3 (docs/AGENCYOS_BUSINESS_PHASE_1_4_
-- AUDIT.json), Implementation Plan Phase 1 items 1 and 3.
--
-- Two gaps, one shared cause: nothing has ever emitted a fact when a lead
-- row was created. `crm.ingest_whatsapp_message` (the only wired inbound
-- channel today) inserts the row and stops — no routing, no identity check,
-- nothing downstream to react to.
--
-- Emitted by trigger rather than by editing the ingest function, for the
-- same reason `20260821270000_the_events_the_documents_name.sql` gives:
-- "a trigger also covers every path that moves the row rather than the one
-- that exists today." A manual "new lead" action, a future web-form/email
-- ingest route, and an import commit all insert into crm.leads directly —
-- a single AFTER INSERT trigger reaches every one of them without a second
-- emitter to keep in step.
--
-- `merged_into_lead_id`/`merged_at` rows (20260921130000) are UPDATEs, not
-- INSERTs, so a merge never re-fires this — the loser lead already had its
-- own creation event long ago, and a merge is not a new lead being created.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('lead.created', 'A crm.leads row was inserted, from any ingest path.', null)
on conflict (type) do nothing;

create or replace function crm.emit_lead_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform core.emit_event(
    new.organization_id,
    'lead.created',
    'lead',
    new.id,
    jsonb_build_object('contactId', new.contact_id, 'source', new.source)
  );
  return new;
end;
$$;

comment on function crm.emit_lead_created() is
  'Emits lead.created for every path that inserts crm.leads — Audit 1.2/1.3. SECURITY DEFINER so an insert under RLS (a signed-in staff member creating a lead by hand) can still reach core.emit_event, which is SECURITY INVOKER and would otherwise need INSERT on core.outbox_events granted to every caller of this trigger rather than to the function that owns the decision.';

drop trigger if exists lead_created on crm.leads;
create trigger lead_created
  after insert on crm.leads
  for each row execute function crm.emit_lead_created();
