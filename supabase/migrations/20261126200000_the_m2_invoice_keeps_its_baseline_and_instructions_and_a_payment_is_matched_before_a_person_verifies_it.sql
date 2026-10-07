-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 Finance Agent (traceability rows P4-FIN-005, 008, 016, 017, 020, 030, 038, 042, 043, 044, 054, 057, 058, 062, 078, 079, 083, 091 (consumer side), 093, 097).
--
--   * a milestone and the invoice made from it keep the COMMERCIAL BASELINE they were priced against (active scope version + budget), and an invoice whose baseline is
--     no longer the active scope reads `stale`. No baseline / no budget / no billing data opens a Finance clarification (a finance exception) instead of a silent skip.
--   * an invoice keeps a PAYMENT INSTRUCTION SNAPSHOT written when it is issued (masked); a later account change is visible as drift and never rewrites history.
--   * finance.p4q_match_payment_submission computes and PERSISTS a deterministic match result and a recommendation MATCH / REVIEW / REJECT / EXCEPTION. It never verifies:
--     verification stays the owner-only door, so the Finance agent still cannot mark a payment received.
--   * a receipt has a rendered document and a delivery row of its own that retries independently.
--   * reminders have stages (upcoming, due_today, overdue, escalation) with a schedule row each; escalation opens an overdue finance exception.
--   * finance.p4q_m2_overview: the M2 line (percentage, amount, trigger, status, due, balance, gate) for the Admin.
--   * an M2 invoice cannot be created for a project whose Phase 4 is not complete (the consumer-side guard; the producer already waited).
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.milestones add column if not exists commercial_baseline_ref jsonb check (commercial_baseline_ref is null or jsonb_typeof(commercial_baseline_ref) = 'object');
alter table finance.invoices   add column if not exists commercial_baseline_ref jsonb check (commercial_baseline_ref is null or jsonb_typeof(commercial_baseline_ref) = 'object');
alter table core.organizations add column if not exists invoice_reminder_upcoming_days int not null default 3 check (invoice_reminder_upcoming_days between 1 and 30);
alter table core.organizations add column if not exists invoice_reminder_escalation_days int not null default 14 check (invoice_reminder_escalation_days between 1 and 90);

insert into core.event_types (type, description, canonical) values
  ('payment.p4q_match_prepared', 'A deterministic match result and recommendation was prepared for a payment submission. A person still verifies; nothing was marked paid.', true),
  ('invoice.p4q_reminder_escalated', 'An invoice is overdue past the escalation threshold; an overdue finance exception was opened for a person.', true)
on conflict (type) do nothing;

-- the invoice carries its milestone's baseline from the moment it exists
create or replace function finance.p4q_copy_baseline_to_invoice()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.commercial_baseline_ref is null and new.milestone_id is not null then
    select m.commercial_baseline_ref into new.commercial_baseline_ref from projects.milestones m where m.id = new.milestone_id;
  end if;
  return new;
end $$;
revoke all on function finance.p4q_copy_baseline_to_invoice() from public, anon, authenticated, service_role;
drop trigger if exists p4q_copy_baseline_to_invoice on finance.invoices;
create trigger p4q_copy_baseline_to_invoice before insert on finance.invoices for each row execute function finance.p4q_copy_baseline_to_invoice();

-- the consumer-side Phase-4 guard: an M2 invoice exists only once Phase 4 is complete (projects without a Phase 4 workspace are unaffected)
create or replace function finance.p4q_m2_needs_phase_four_complete()
returns trigger language plpgsql set search_path = '' as $$
declare v_pos int; v_state text;
begin
  if new.milestone_id is null or new.kind is distinct from 'milestone' then return new; end if;
  select m.position into v_pos from projects.milestones m where m.id = new.milestone_id;
  if v_pos is distinct from 2 then return new; end if;
  select f.state into v_state from projects.phase_four f where f.project_id = new.project_id;
  if v_state is not null and v_state <> 'completed' then
    raise exception 'the M2 invoice is created only after Phase 4 is complete (it is %)', v_state using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
revoke all on function finance.p4q_m2_needs_phase_four_complete() from public, anon, authenticated, service_role;
drop trigger if exists p4q_m2_needs_phase_four_complete on finance.invoices;
create trigger p4q_m2_needs_phase_four_complete before insert on finance.invoices for each row execute function finance.p4q_m2_needs_phase_four_complete();

-- ── commercial baseline ────────────────────────────────────────────────────
create or replace function finance.p4q_bind_commercial_baseline(p_project_id uuid)
returns table (outcome text, detail text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_p     projects.projects;
  v_sv    projects.scope_versions;
  v_ref   jsonb;
  v_n     int;
  v_ex    text;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text, null::text; return; end if;
  select * into v_p from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_p.id is null then return query select 'not_found'::text, null::text; return; end if;
  if v_actor is not null and (v_p.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then return query select 'forbidden'::text, null::text; return; end if;
  select sv.* into v_sv from projects.scope_versions sv where sv.project_id = p_project_id and sv.status = 'active';
  if v_sv.id is null or v_p.budget_minor is null or v_p.budget_minor <= 0 then
    -- never guess a baseline: a person is asked
    select c.outcome into v_ex from finance.p4q_open_billing_clarification(p_project_id, case when v_sv.id is null then array['active_scope_version'] else array['budget'] end) c;
    return query select 'clarification_opened'::text, v_ex; return;
  end if;
  v_ref := jsonb_build_object('scopeVersionId', v_sv.id, 'scopeVersion', v_sv.version, 'budgetMinor', v_p.budget_minor, 'boundAt', clock_timestamp());
  update projects.milestones m set commercial_baseline_ref = v_ref where m.project_id = p_project_id and m.commercial_baseline_ref is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then return query select 'already_bound'::text, null::text; return; end if;
  perform core.record_audit(v_p.organization_id, 'finance.p4q_baseline_bound', 'project', p_project_id, null, jsonb_build_object('scopeVersionId', v_sv.id, 'milestones', v_n));
  return query select 'bound'::text, v_n::text;
end $$;
revoke all on function finance.p4q_bind_commercial_baseline(uuid) from public, anon;
grant execute on function finance.p4q_bind_commercial_baseline(uuid) to authenticated, service_role;

create or replace function finance.p4q_invoice_baseline_status(p_invoice_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_i finance.invoices; v_active uuid;
begin
  select i.* into v_i from finance.invoices i where i.id = p_invoice_id and (i.organization_id = (select core.current_organization_id()) or (select auth.role()) = 'service_role');
  if v_i.id is null then return null; end if;
  if v_i.commercial_baseline_ref is null then return 'unbound'; end if;
  select sv.id into v_active from projects.scope_versions sv where sv.project_id = v_i.project_id and sv.status = 'active';
  return case when (v_i.commercial_baseline_ref ->> 'scopeVersionId')::uuid is distinct from v_active then 'stale' else 'bound' end;
end $$;
revoke all on function finance.p4q_invoice_baseline_status(uuid) from public, anon;
grant execute on function finance.p4q_invoice_baseline_status(uuid) to authenticated, service_role;

-- billing data missing or ambiguous: a clarification, never a guess (the billing-readiness failure used to be a permanent job failure and nothing else)
create or replace function finance.p4q_open_billing_clarification(p_project_id uuid, p_missing text[])
returns table (outcome text, exception_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_p projects.projects;
  v_o text; v_id uuid;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text, null::uuid; return; end if;
  select * into v_p from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_p.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_actor is not null and (v_p.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then return query select 'forbidden'::text, null::uuid; return; end if;
  if coalesce(cardinality(p_missing), 0) = 0 then return query select 'name_what_is_missing'::text, null::uuid; return; end if;
  select id into v_id from finance.finance_exceptions x where x.project_id = p_project_id and x.state = 'open' and x.kind = 'other' and x.evidence ->> 'p4q' = 'billing_clarification';
  if v_id is not null then return query select 'already_open'::text, v_id; return; end if;
  select e.outcome, e.exception_id into v_o, v_id from finance.open_finance_exception('other',
    'Billing data is missing or unclear (' || array_to_string(p_missing, ', ') || '): Finance does not guess a billing profile, GST mode or tax rate. A person confirms it with the client.',
    p_project_id, null, null, jsonb_build_object('p4q', 'billing_clarification', 'missing', to_jsonb(p_missing))) e;
  return query select v_o, v_id;
end $$;
revoke all on function finance.p4q_open_billing_clarification(uuid, text[]) from public, anon;
grant execute on function finance.p4q_open_billing_clarification(uuid, text[]) to authenticated, service_role;

-- ── payment instruction snapshot ───────────────────────────────────────────
create table if not exists finance.p4q_payment_instruction_snapshots (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  invoice_id       uuid not null unique references finance.invoices(id) on delete restrict,
  accounts         jsonb not null check (jsonb_typeof(accounts) = 'array'),
  taken_at         timestamptz not null default clock_timestamp()
);
comment on table finance.p4q_payment_instruction_snapshots is 'PaymentInstructionSnapshot: the receiving accounts (masked) that were active when the invoice was issued. History is never rewritten by a later account change.';

create or replace function finance.p4q_mask_instructions(p_instructions jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(k, case when jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '[0-9]{6,}' then to_jsonb('••••' || right(regexp_replace(v #>> '{}', '\D', '', 'g'), 4)) else v end), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(p_instructions) = 'object' then p_instructions else '{}'::jsonb end) e(k, v)
$$;
revoke all on function finance.p4q_mask_instructions(jsonb) from public, anon;
grant execute on function finance.p4q_mask_instructions(jsonb) to authenticated, service_role;

create or replace function finance.p4q_snapshot_instructions_at_issue()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'issued' and old.status is distinct from 'issued' then
    perform set_config('projects.p4q_door', 'on', true);
    insert into finance.p4q_payment_instruction_snapshots (organization_id, invoice_id, accounts)
    select new.organization_id, new.id, coalesce(jsonb_agg(jsonb_build_object('accountId', a.id, 'kind', a.kind, 'label', a.label, 'instructions', finance.p4q_mask_instructions(a.instructions), 'accountUpdatedAt', a.updated_at) order by a.created_at), '[]'::jsonb)
      from finance.payment_accounts a
     where a.organization_id = new.organization_id and a.status = 'active' and a.effective_from <= now() and (a.effective_to is null or a.effective_to > now())
    on conflict (invoice_id) do nothing;
  end if;
  return new;
end $$;
revoke all on function finance.p4q_snapshot_instructions_at_issue() from public, anon, authenticated, service_role;
drop trigger if exists p4q_snapshot_instructions_at_issue on finance.invoices;
create trigger p4q_snapshot_instructions_at_issue after update of status on finance.invoices for each row execute function finance.p4q_snapshot_instructions_at_issue();

create or replace function finance.p4q_invoice_payment_snapshot(p_invoice_id uuid)
returns table (account_id uuid, kind text, label text, instructions jsonb, changed_since_issue boolean, no_longer_active boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  return query
  select (s ->> 'accountId')::uuid, s ->> 'kind', s ->> 'label', s -> 'instructions',
         coalesce(a.updated_at > (s ->> 'accountUpdatedAt')::timestamptz, true),
         coalesce(a.status <> 'active' or (a.effective_to is not null and a.effective_to <= now()), true)
    from finance.p4q_payment_instruction_snapshots sn
    cross join lateral jsonb_array_elements(sn.accounts) s
    left join finance.payment_accounts a on a.id = (s ->> 'accountId')::uuid
   where sn.invoice_id = p_invoice_id and sn.organization_id = v_org;
end $$;
revoke all on function finance.p4q_invoice_payment_snapshot(uuid) from public, anon, service_role;
grant execute on function finance.p4q_invoice_payment_snapshot(uuid) to authenticated;

-- ── match results ──────────────────────────────────────────────────────────
create table if not exists finance.p4q_payment_match_results (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  submission_id    uuid not null references finance.payment_submissions(id) on delete restrict,
  invoice_id       uuid not null references finance.invoices(id) on delete restrict,
  match_class      text not null check (match_class in ('exact', 'under', 'over', 'unmatched', 'duplicate', 'currency_mismatch', 'wrong_account')),
  recommendation   text not null check (recommendation in ('MATCH', 'REVIEW', 'REJECT', 'EXCEPTION')),
  reasons          text[] not null,
  expected_minor   bigint not null,
  submitted_minor  bigint not null,
  inputs_hash      text not null,
  computed_by      uuid references core.users(id) on delete set null,
  computed_at      timestamptz not null default clock_timestamp(),
  unique (submission_id, inputs_hash)
);
comment on table finance.p4q_payment_match_results is 'PaymentMatchResult: a deterministic, persisted classification of a payment submission against its invoice and the active accounts, with a recommendation. It is advice to a person. Nothing here marks anything paid.';

create or replace function finance.p4q_match_payment_submission(p_submission_id uuid)
returns table (outcome text, match_class text, recommendation text, result_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_s     finance.payment_submissions;
  v_i     finance.invoices;
  v_out   bigint;
  v_class text; v_rec text; v_reasons text[] := '{}';
  v_dup   boolean; v_acct_ok boolean; v_hash text; v_id uuid;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text, null::text, null::text, null::uuid; return; end if;
  select * into v_s from finance.payment_submissions s where s.id = p_submission_id;
  if v_s.id is null then return query select 'not_found'::text, null::text, null::text, null::uuid; return; end if;
  if v_actor is not null and (v_s.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then return query select 'forbidden'::text, null::text, null::text, null::uuid; return; end if;
  select * into v_i from finance.invoices i where i.id = v_s.invoice_id;
  v_out := finance.invoice_outstanding_minor(v_i.id);
  v_dup := v_s.status = 'duplicate' or (v_s.reference is not null and exists (select 1 from finance.payment_submissions o where o.organization_id = v_s.organization_id and o.id <> v_s.id and o.status not in ('rejected', 'duplicate') and upper(btrim(o.reference)) = upper(btrim(v_s.reference)) and o.created_at <= v_s.created_at));
  -- the receiving account must be one of the accounts shown on the invoice (its snapshot) or, with no snapshot, an active one
  v_acct_ok := case
    when v_s.account_id is null then false
    when exists (select 1 from finance.p4q_payment_instruction_snapshots sn where sn.invoice_id = v_i.id) then exists (select 1 from finance.p4q_payment_instruction_snapshots sn, jsonb_array_elements(sn.accounts) a where sn.invoice_id = v_i.id and (a ->> 'accountId')::uuid = v_s.account_id)
    else exists (select 1 from finance.payment_accounts a where a.id = v_s.account_id and a.status = 'active') end;

  if v_s.currency is distinct from v_i.currency then v_class := 'currency_mismatch'; v_rec := 'REJECT'; v_reasons := array['currency differs from the invoice'];
  elsif v_dup then v_class := 'duplicate'; v_rec := 'REJECT'; v_reasons := array['the same transaction reference was already submitted'];
  elsif not v_acct_ok then v_class := 'wrong_account'; v_rec := 'EXCEPTION'; v_reasons := array['the money went to an account that was not on the invoice'];
  elsif v_s.amount_minor > v_out then v_class := 'over'; v_rec := 'EXCEPTION'; v_reasons := array['the amount exceeds what is outstanding: an overpayment needs a person'];
  elsif v_s.amount_minor < v_out then v_class := 'under'; v_rec := 'REVIEW'; v_reasons := array['the amount is less than what is outstanding: a partial payment needs a person'];
  elsif v_s.reference is null or length(btrim(v_s.reference)) = 0 then v_class := 'unmatched'; v_rec := 'REVIEW'; v_reasons := array['the amount matches but there is no transaction reference to match against the bank'];
  else v_class := 'exact'; v_rec := 'MATCH'; v_reasons := array['amount, currency, account and reference are consistent; a person still verifies against the bank'];
  end if;
  v_hash := md5(concat_ws('|', v_s.id, v_s.amount_minor, v_s.currency, v_s.reference, v_s.account_id, v_out, v_dup, v_acct_ok, v_i.currency));
  select r.id into v_id from finance.p4q_payment_match_results r where r.submission_id = v_s.id and r.inputs_hash = v_hash;
  if v_id is not null then return query select 'unchanged'::text, v_class, v_rec, v_id; return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  insert into finance.p4q_payment_match_results (organization_id, submission_id, invoice_id, match_class, recommendation, reasons, expected_minor, submitted_minor, inputs_hash, computed_by)
  values (v_s.organization_id, v_s.id, v_i.id, v_class, v_rec, v_reasons, v_out, v_s.amount_minor, v_hash, v_actor) returning id into v_id;
  perform core.emit_event(v_s.organization_id, 'payment.p4q_match_prepared', 'payment_submission', v_s.id, jsonb_build_object('invoiceId', v_i.id, 'recommendation', v_rec, 'matchClass', v_class));
  return query select 'prepared'::text, v_class, v_rec, v_id;
end $$;
revoke all on function finance.p4q_match_payment_submission(uuid) from public, anon;
grant execute on function finance.p4q_match_payment_submission(uuid) to authenticated, service_role;

-- ── receipts: a document and a delivery of their own ──────────────────────
create table if not exists finance.p4q_receipt_deliveries (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  receipt_id       uuid not null references finance.receipts(id) on delete restrict,
  channel          text not null check (channel in ('whatsapp', 'email', 'portal', 'manual')),
  state            text not null default 'pending' check (state in ('pending', 'sent', 'delivered', 'failed', 'unknown')),
  evidence         text check (evidence is null or (length(btrim(evidence)) between 3 and 500 and not finance.phase9_has_secret(evidence))),
  attempts         integer not null default 0 check (attempts >= 0),
  updated_at       timestamptz not null default clock_timestamp(),
  unique (receipt_id, channel),
  constraint p4q_receipt_sent_has_evidence check (state not in ('sent', 'delivered') or evidence is not null)
);
comment on table finance.p4q_receipt_deliveries is 'Receipt delivery state, recorded apart from the payment and retried on its own. sent/delivered need evidence; an uncertain send is unknown.';

create or replace function finance.p4q_receipt_document(p_receipt_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id());
  v jsonb;
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return null; end if;
  select jsonb_build_object(
      'receiptNumber', r.number, 'issuedAt', r.issued_at, 'amountMinor', r.amount_minor, 'currency', r.currency,
      'invoiceNumber', i.number, 'milestone', m.name, 'milestonePosition', m.position,
      'client', ca.name,
      'method', ps.method, 'transactionReference', ps.reference, 'paidAt', ps.paid_at,
      'receivingAccount', case when a.id is null then null else jsonb_build_object('kind', a.kind, 'label', a.label, 'instructions', finance.p4q_mask_instructions(a.instructions)) end)
    into v
    from finance.receipts r
    join finance.invoices i on i.id = r.invoice_id
    left join projects.milestones m on m.id = i.milestone_id
    left join core.client_accounts ca on ca.id = i.client_account_id
    left join finance.payment_submissions ps on ps.payment_id = r.payment_id
    left join finance.payment_accounts a on a.id = ps.account_id
   where r.id = p_receipt_id and r.organization_id = v_org;
  return v;
end $$;
revoke all on function finance.p4q_receipt_document(uuid) from public, anon, service_role;
grant execute on function finance.p4q_receipt_document(uuid) to authenticated;

create or replace function finance.p4q_record_receipt_delivery(p_receipt_id uuid, p_channel text, p_state text, p_evidence text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_r finance.receipts; v_d finance.p4q_receipt_deliveries;
  v_ev text := nullif(btrim(coalesce(p_evidence, '')), '');
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text; return; end if;
  select * into v_r from finance.receipts r where r.id = p_receipt_id;
  if v_r.id is null then return query select 'not_found'::text; return; end if;
  if v_actor is not null and (v_r.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then return query select 'forbidden'::text; return; end if;
  if p_channel not in ('whatsapp', 'email', 'portal', 'manual') or p_state not in ('pending', 'sent', 'delivered', 'failed', 'unknown') then return query select 'bad_input'::text; return; end if;
  if p_state in ('sent', 'delivered', 'failed', 'unknown') and v_ev is null then return query select 'evidence_required'::text; return; end if;
  if v_ev is not null and finance.phase9_has_secret(v_ev) then return query select 'secret_in_text'::text; return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  select * into v_d from finance.p4q_receipt_deliveries d where d.receipt_id = p_receipt_id and d.channel = p_channel for update;
  if v_d.id is null then
    if p_state not in ('pending', 'sent', 'failed', 'unknown') then return query select 'bad_transition'::text; return; end if;
    insert into finance.p4q_receipt_deliveries (organization_id, receipt_id, channel, state, evidence, attempts) values (v_r.organization_id, p_receipt_id, p_channel, p_state, v_ev, case when p_state = 'pending' then 0 else 1 end);
    return query select 'recorded'::text; return;
  end if;
  if v_d.state = p_state then return query select 'unchanged'::text; return; end if;
  if not ((v_d.state = 'pending' and p_state in ('sent', 'failed', 'unknown')) or (v_d.state = 'failed' and p_state = 'pending') or (v_d.state = 'unknown' and p_state in ('sent', 'failed', 'delivered')) or (v_d.state = 'sent' and p_state in ('delivered', 'unknown'))) then
    return query select 'bad_transition'::text; return;
  end if;
  update finance.p4q_receipt_deliveries set state = p_state, evidence = coalesce(v_ev, evidence), attempts = attempts + case when p_state in ('sent', 'failed', 'unknown') then 1 else 0 end, updated_at = clock_timestamp() where id = v_d.id;
  return query select 'recorded'::text;
end $$;
revoke all on function finance.p4q_record_receipt_delivery(uuid, text, text, text) from public, anon;
grant execute on function finance.p4q_record_receipt_delivery(uuid, text, text, text) to authenticated, service_role;

-- ── reminders with stages ──────────────────────────────────────────────────
create table if not exists finance.p4q_reminders (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  invoice_id       uuid not null references finance.invoices(id) on delete restrict,
  stage            text not null check (stage in ('upcoming', 'due_today', 'overdue', 'escalation')),
  scheduled_for    timestamptz not null,
  state            text not null default 'scheduled' check (state in ('scheduled', 'sent', 'failed')),
  attempts         integer not null default 0 check (attempts >= 0),
  note             text,
  updated_at       timestamptz not null default clock_timestamp(),
  unique (invoice_id, stage)
);
comment on table finance.p4q_reminders is 'PaymentReminder: one row per invoice and stage (upcoming, due_today, overdue, escalation) with scheduled / sent / failed and the attempts it took.';

create or replace function finance.p4q_invoice_reminder_stage(p_invoice_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_i finance.invoices; v_o core.organizations; v_days numeric;
begin
  select i.* into v_i from finance.invoices i where i.id = p_invoice_id and (i.organization_id = (select core.current_organization_id()) or (select auth.role()) = 'service_role');
  if v_i.id is null or v_i.due_at is null or v_i.status not in ('issued', 'partially_paid', 'overdue') then return null; end if;
  select * into v_o from core.organizations o where o.id = v_i.organization_id;
  if not v_o.invoice_reminders_enabled then return null; end if;
  v_days := extract(epoch from (now() - v_i.due_at)) / 86400.0;
  return case
    when v_days >= v_o.invoice_reminder_escalation_days then 'escalation'
    when now()::date > v_i.due_at::date then 'overdue'
    when now()::date = v_i.due_at::date then 'due_today'
    when v_i.due_at <= now() + make_interval(days => v_o.invoice_reminder_upcoming_days) then 'upcoming'
    else null end;
end $$;
revoke all on function finance.p4q_invoice_reminder_stage(uuid) from public, anon;
grant execute on function finance.p4q_invoice_reminder_stage(uuid) to authenticated, service_role;

create or replace function finance.p4q_schedule_reminders(p_limit int default 100)
returns table (invoice_id uuid, stage text, scheduled boolean)
language plpgsql security definer set search_path = '' as $$
declare r record; v_stage text; v_n int; v_o text;
begin
  if (select auth.role()) is distinct from 'service_role' then return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  for r in select i.id, i.organization_id, i.project_id, i.number from finance.invoices i join core.organizations o on o.id = i.organization_id
            where o.invoice_reminders_enabled and i.status in ('issued', 'partially_paid', 'overdue') and i.due_at is not null order by i.due_at limit greatest(1, least(coalesce(p_limit, 100), 500)) loop
    v_stage := finance.p4q_invoice_reminder_stage(r.id);
    continue when v_stage is null;
    insert into finance.p4q_reminders (organization_id, invoice_id, stage, scheduled_for) values (r.organization_id, r.id, v_stage, now()) on conflict on constraint p4q_reminders_invoice_id_stage_key do nothing;
    get diagnostics v_n = row_count;
    if v_n = 1 and v_stage = 'escalation' then
      select e.outcome into v_o from finance.open_finance_exception('overdue', 'Invoice ' || r.number || ' is overdue past the escalation threshold; a person decides how to chase it.', r.project_id, r.id) e;
      perform core.emit_event(r.organization_id, 'invoice.p4q_reminder_escalated', 'invoice', r.id, jsonb_build_object('stage', 'escalation'));
    end if;
    invoice_id := r.id; stage := v_stage; scheduled := v_n = 1; return next;
  end loop;
end $$;
revoke all on function finance.p4q_schedule_reminders(int) from public, anon, authenticated;
grant execute on function finance.p4q_schedule_reminders(int) to service_role;

create or replace function finance.p4q_mark_reminder(p_reminder_id uuid, p_state text, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_r finance.p4q_reminders;
begin
  if (select auth.role()) is distinct from 'service_role' then return query select 'not_authorized'::text; return; end if;
  select * into v_r from finance.p4q_reminders where id = p_reminder_id for update;
  if v_r.id is null then return query select 'not_found'::text; return; end if;
  if p_state not in ('sent', 'failed', 'scheduled') then return query select 'bad_state'::text; return; end if;
  if v_r.state = 'sent' then return query select 'already_sent'::text; return; end if;
  if p_state = 'failed' and nullif(btrim(coalesce(p_note, '')), '') is null then return query select 'note_required'::text; return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  update finance.p4q_reminders set state = p_state, note = p_note, attempts = attempts + case when p_state in ('sent', 'failed') then 1 else 0 end, updated_at = clock_timestamp() where id = v_r.id;
  return query select 'updated'::text;
end $$;
revoke all on function finance.p4q_mark_reminder(uuid, text, text) from public, anon, authenticated;
grant execute on function finance.p4q_mark_reminder(uuid, text, text) to service_role;

create or replace function finance.p4q_reminder_overview(p_project_id uuid)
returns table (invoice_number text, stage text, state text, attempts integer, scheduled_for timestamptz, note text)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  return query select i.number, r.stage, r.state, r.attempts, r.scheduled_for, r.note
    from finance.p4q_reminders r join finance.invoices i on i.id = r.invoice_id
   where i.project_id = p_project_id and r.organization_id = v_org order by r.scheduled_for desc, r.stage;
end $$;
revoke all on function finance.p4q_reminder_overview(uuid) from public, anon, service_role;
grant execute on function finance.p4q_reminder_overview(uuid) to authenticated;

-- ── the M2 line for the Admin ──────────────────────────────────────────────
create or replace function finance.p4q_m2_overview(p_project_id uuid)
returns table (milestone_id uuid, payment_percent numeric, amount_minor bigint, trigger_state text, invoice_status text, due_at timestamptz, balance_minor bigint, gate text, baseline text)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org) then return; end if;
  return query
  select m.id, m.payment_percent::numeric, m.amount_minor::bigint,
         case when f.state is null then 'phase_four_not_started' when f.state = 'completed' then 'phase_four_complete' else 'waiting_phase_four' end,
         i.status, i.due_at,
         case when i.id is null then m.amount_minor::bigint else finance.invoice_outstanding_minor(i.id) end,
         case when coalesce((select projects.m2_verified_paid(p_project_id)), false) then 'verified' when i.id is null then 'not_ready' when i.status = 'void' then 'not_ready' else 'invoice_issued' end,
         case when i.id is null then (case when m.commercial_baseline_ref is null then 'unbound' else 'bound' end) else finance.p4q_invoice_baseline_status(i.id) end
    from projects.milestones m
    left join projects.phase_four f on f.project_id = m.project_id
    left join lateral (select x.* from finance.invoices x where x.milestone_id = m.id and x.status <> 'void' order by x.created_at desc limit 1) i on true
   where m.project_id = p_project_id and m.organization_id = v_org and m.position = 2;
end $$;
revoke all on function finance.p4q_m2_overview(uuid) from public, anon, service_role;
grant execute on function finance.p4q_m2_overview(uuid) to authenticated;

-- ── hardening of the new finance tables (internal read, door-only write, tenancy guards) ──
do $$ declare t text; r record; begin
  foreach t in array array['p4q_payment_instruction_snapshots', 'p4q_payment_match_results', 'p4q_receipt_deliveries', 'p4q_reminders'] loop
    perform projects.p7_harden('finance', t);
    execute format('drop trigger if exists %I on finance.%I', t || '_door_only', t);
    execute format('create trigger %I before insert or update or delete on finance.%I for each row execute function projects.p4q_door_only()', t || '_door_only', t);
  end loop;
  execute 'drop trigger if exists p4q_snap_parent_invoice on finance.p4q_payment_instruction_snapshots';
  execute $c$create trigger p4q_snap_parent_invoice before insert or update of invoice_id on finance.p4q_payment_instruction_snapshots for each row execute function core.enforce_parent_org('invoice_id', 'finance.invoices')$c$;
  execute 'drop trigger if exists p4q_match_parent_submission on finance.p4q_payment_match_results';
  execute $c$create trigger p4q_match_parent_submission before insert or update of submission_id on finance.p4q_payment_match_results for each row execute function core.enforce_parent_org('submission_id', 'finance.payment_submissions')$c$;
  execute 'drop trigger if exists p4q_match_parent_invoice on finance.p4q_payment_match_results';
  execute $c$create trigger p4q_match_parent_invoice before insert or update of invoice_id on finance.p4q_payment_match_results for each row execute function core.enforce_parent_org('invoice_id', 'finance.invoices')$c$;
  execute 'drop trigger if exists p4q_rcpt_parent_receipt on finance.p4q_receipt_deliveries';
  execute $c$create trigger p4q_rcpt_parent_receipt before insert or update of receipt_id on finance.p4q_receipt_deliveries for each row execute function core.enforce_parent_org('receipt_id', 'finance.receipts')$c$;
  execute 'drop trigger if exists p4q_rem_parent_invoice on finance.p4q_reminders';
  execute $c$create trigger p4q_rem_parent_invoice before insert or update of invoice_id on finance.p4q_reminders for each row execute function core.enforce_parent_org('invoice_id', 'finance.invoices')$c$;
end $$;

notify pgrst, 'reload schema';
