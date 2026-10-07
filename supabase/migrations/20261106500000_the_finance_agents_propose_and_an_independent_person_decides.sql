-- ═══════════════════════════════════════════════════════════════════════════
-- The three Phase 9 finance agents PROPOSE; an independent person decides.
--
-- STUB-PROVEN ONLY: nothing here has run on a real model. What exists is the record a finance-agent run would leave and the doors around it:
--   * finance.finance_agent_requests  - who asked a finance agent to look at a project (and, for a reminder draft, one invoice). The requester is the
--                                       person who may NOT accept what comes back (creator != reviewer, enforced in the database).
--   * finance.finance_proposals       - a PROPOSED reconciliation finding / anomaly flag / reminder draft / close-readiness note / exception
--                                       classification. status is 'proposed' and only that; the row is append-only. A proposal is never a fact: it
--                                       verifies no payment, changes no amount, records no refund, decides no waiver, sends no message, closes nothing.
--   * finance.finance_proposal_decisions - the one decision a person makes on a proposal (accepted or rejected); append-only, one per proposal, so a
--                                       rejection is final.
--   * finance.record_finance_proposal - SERVICE ROLE ONLY, the one door a run writes through. It refuses: another organization, an agent that is not the
--                                       request's, a kind that is not that agent's, a secret value, evidence that does not exist in the organization (or
--                                       that belongs to another project), a finding or flag with no evidence, and for a reminder draft: an invoice with
--                                       nothing owed, an amount that is not the invoice's real outstanding balance, a claim that payment was received,
--                                       a promised discount / waiver / refund / deferral / payment plan, and anything shaped like an account number.
--   * finance.request_finance_agent_run / accept_finance_proposal / reject_finance_proposal - a Finance person or Admin. Accepting an exception
--                                       classification opens the exception through the EXISTING door as the same caller; accepting a reminder draft only
--                                       approves its wording (nothing is sent here), and refuses if the balance it quotes has changed.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists finance.finance_agent_requests (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  invoice_id       uuid references finance.invoices(id) on delete cascade,
  agent_key        text not null references ai.agents(key) on delete restrict check (agent_key in ('finance_reconciliation', 'finance_communication', 'finance_close')),
  requested_by     uuid not null references core.users(id) on delete restrict,
  created_at       timestamptz not null default clock_timestamp(),
  -- a reminder draft is about exactly one invoice
  check (agent_key <> 'finance_communication' or invoice_id is not null)
);

create table if not exists finance.finance_proposals (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references core.organizations(id) on delete cascade,
  request_id              uuid not null references finance.finance_agent_requests(id) on delete cascade,
  project_id              uuid not null references projects.projects(id) on delete cascade,
  invoice_id              uuid references finance.invoices(id) on delete cascade,
  submission_id           uuid references finance.payment_submissions(id) on delete cascade,
  agent_key               text not null references ai.agents(key) on delete restrict check (agent_key in ('finance_reconciliation', 'finance_communication', 'finance_close')),
  kind                    text not null check (kind in ('reconciliation_finding', 'anomaly_flag', 'reminder_draft', 'close_readiness_note', 'exception_classification')),
  summary                 text not null check (length(btrim(summary)) between 1 and 2000),
  detail                  text check (detail is null or length(detail) <= 4000),
  evidence_refs           text[] not null default '{}' check (cardinality(evidence_refs) <= 20),
  draft_body              text check (draft_body is null or length(btrim(draft_body)) between 1 and 2000),
  amount_minor            bigint check (amount_minor is null or amount_minor > 0),
  proposed_exception_kind text check (proposed_exception_kind is null or proposed_exception_kind in ('wrong_amount', 'wrong_account', 'unclear_proof', 'gateway_mismatch', 'overdue', 'overpayment', 'unmatched_payment', 'duplicate_payment', 'refund_dispute', 'chargeback', 'tax_correction', 'waiver_request', 'other')),
  requested_by            uuid not null references core.users(id) on delete restrict,
  status                  text not null default 'proposed' check (status = 'proposed'),
  created_at              timestamptz not null default clock_timestamp(),
  -- each agent writes only its own kinds
  check ((agent_key = 'finance_reconciliation' and kind in ('reconciliation_finding', 'anomaly_flag'))
      or (agent_key = 'finance_communication' and kind = 'reminder_draft')
      or (agent_key = 'finance_close' and kind in ('close_readiness_note', 'exception_classification'))),
  -- a finding, a flag and a classification cite evidence; a reminder draft is the invoice's own balance
  check (kind in ('reminder_draft', 'close_readiness_note') or cardinality(evidence_refs) > 0),
  check ((kind = 'reminder_draft') = (draft_body is not null and amount_minor is not null and invoice_id is not null)),
  check ((kind = 'exception_classification') = (proposed_exception_kind is not null))
);
create unique index if not exists finance_proposals_once on finance.finance_proposals (request_id, kind, md5(summary));
create index if not exists finance_proposals_project_idx on finance.finance_proposals (project_id, created_at desc);

create table if not exists finance.finance_proposal_decisions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  proposal_id      uuid not null unique references finance.finance_proposals(id) on delete cascade,
  decision         text not null check (decision in ('accepted', 'rejected')),
  decided_by       uuid not null references core.users(id) on delete restrict,
  note             text,
  recorded_outcome text not null,
  decided_at       timestamptz not null default clock_timestamp(),
  check (decision = 'accepted' or (note is not null and length(btrim(note)) > 0))
);

do $$
declare r record;
begin
  for r in select * from (values
    ('finance_agent_requests', 'project_id', 'projects.projects'), ('finance_agent_requests', 'invoice_id', 'finance.invoices'),
    ('finance_proposals', 'project_id', 'projects.projects'), ('finance_proposals', 'request_id', 'finance.finance_agent_requests'), ('finance_proposals', 'invoice_id', 'finance.invoices'), ('finance_proposals', 'submission_id', 'finance.payment_submissions'),
    ('finance_proposal_decisions', 'proposal_id', 'finance.finance_proposals')
  ) as t(tbl, col, parent) loop
    execute format('drop trigger if exists %I on finance.%I', 'org_match_' || r.tbl || '_' || r.col, r.tbl);
    execute format('create trigger %I before insert or update of %I, organization_id on finance.%I for each row execute function core.enforce_parent_org(%L, %L)', 'org_match_' || r.tbl || '_' || r.col, r.col, r.tbl, r.col, r.parent);
  end loop;
  for r in select unnest(array['finance_agent_requests', 'finance_proposals', 'finance_proposal_decisions']) as tbl loop
    execute format('alter table finance.%I enable row level security', r.tbl);
    execute format('drop policy if exists %I on finance.%I', r.tbl || '_select', r.tbl);
    execute format($p$create policy %I on finance.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and ((select core.is_admin()) or (select core.is_finance())))$p$, r.tbl || '_select', r.tbl);
    execute format('revoke all on finance.%I from public, anon', r.tbl);
    execute format('revoke insert, update, delete on finance.%I from authenticated', r.tbl);
    execute format('grant select on finance.%I to authenticated', r.tbl);
    execute format('grant all on finance.%I to service_role', r.tbl);
    execute format('drop trigger if exists %I on finance.%I', 'freeze_org_' || r.tbl, r.tbl);
    execute format('create trigger %I before update of organization_id on finance.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || r.tbl, r.tbl);
    -- a request, a proposal and a decision are history: never edited, never deleted
    execute format('drop trigger if exists %I on finance.%I', r.tbl || '_append_only', r.tbl);
    execute format('create trigger %I before update or delete on finance.%I for each row execute function finance.phase9_history_append_only()', r.tbl || '_append_only', r.tbl);
  end loop;
end $$;

-- ── a Finance person or Admin asks a finance agent to look at a project (and, for a reminder draft, one invoice) ──
create or replace function finance.request_finance_agent_run(p_agent_key text, p_project_id uuid, p_invoice_id uuid default null)
returns table (outcome text, request_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_kind text := finance.phase9_caller_kind(); v_actor uuid := (select auth.uid()); v_org uuid := (select core.current_organization_id()); v_inv finance.invoices; v_id uuid;
begin
  if v_kind not in ('admin', 'finance') then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_agent_key is null or p_agent_key not in ('finance_reconciliation', 'finance_communication', 'finance_close') then return query select 'bad_agent'::text, null::uuid; return; end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null) then return query select 'not_found'::text, null::uuid; return; end if;
  if p_invoice_id is not null then
    select * into v_inv from finance.invoices i where i.id = p_invoice_id and i.organization_id = v_org;
    if v_inv.id is null or v_inv.project_id is distinct from p_project_id then return query select 'not_found'::text, null::uuid; return; end if;
  end if;
  if p_agent_key = 'finance_communication' and p_invoice_id is null then return query select 'name_an_invoice'::text, null::uuid; return; end if;
  insert into finance.finance_agent_requests (organization_id, project_id, invoice_id, agent_key, requested_by) values (v_org, p_project_id, p_invoice_id, p_agent_key, v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'finance.agent_run_requested', 'finance_agent_request', v_id, null, jsonb_build_object('agent', p_agent_key, 'projectId', p_project_id, 'invoiceId', p_invoice_id));
  return query select 'requested'::text, v_id;
end $$;
revoke all on function finance.request_finance_agent_run(text, uuid, uuid) from public, anon;
grant execute on function finance.request_finance_agent_run(text, uuid, uuid) to authenticated;

-- ── the ONE door a finance-agent run writes through (service role only) ──
create or replace function finance.record_finance_proposal(
  p_request_id uuid, p_organization_id uuid, p_agent_key text, p_kind text, p_summary text, p_detail text, p_evidence_refs text[],
  p_submission_id uuid default null, p_draft_body text default null, p_amount_minor bigint default null, p_exception_kind text default null)
returns table (outcome text, proposal_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_req finance.finance_agent_requests; v_refs text[] := coalesce(p_evidence_refs, '{}'); v_ref text; v_type text; v_id uuid; v_text text; v_owed bigint; v_inv finance.invoices; v_ok boolean;
begin
  if (select auth.uid()) is not null or coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_req from finance.finance_agent_requests r where r.id = p_request_id;
  if v_req.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  -- the organization is the JOB's (the runner's), never one a payload names
  if v_req.organization_id is distinct from p_organization_id then return query select 'wrong_organization'::text, null::uuid; return; end if;
  if p_agent_key is distinct from v_req.agent_key then return query select 'wrong_agent'::text, null::uuid; return; end if;
  if p_kind is null or not ((p_agent_key = 'finance_reconciliation' and p_kind in ('reconciliation_finding', 'anomaly_flag'))
                         or (p_agent_key = 'finance_communication' and p_kind = 'reminder_draft')
                         or (p_agent_key = 'finance_close' and p_kind in ('close_readiness_note', 'exception_classification'))) then
    return query select 'kind_not_for_this_agent'::text, null::uuid; return;
  end if;
  if p_summary is null or length(btrim(p_summary)) = 0 or length(p_summary) > 2000 or length(coalesce(p_detail, '')) > 4000 or cardinality(v_refs) > 20 then return query select 'bad_input'::text, null::uuid; return; end if;
  if (p_kind = 'reminder_draft') <> (p_draft_body is not null and p_amount_minor is not null) then return query select 'bad_input'::text, null::uuid; return; end if;
  if (p_kind = 'exception_classification') <> (p_exception_kind is not null) then return query select 'bad_input'::text, null::uuid; return; end if;
  if p_kind not in ('reminder_draft', 'close_readiness_note') and cardinality(v_refs) = 0 then return query select 'evidence_required'::text, null::uuid; return; end if;

  v_text := p_summary || E'\n' || coalesce(p_detail, '') || E'\n' || coalesce(p_draft_body, '') || E'\n' || array_to_string(v_refs, E'\n');
  if finance.phase9_has_secret(v_text) then return query select 'secret_in_text'::text, null::uuid; return; end if;

  -- every cited record must exist in THIS organization and, where it has a project, in this request's project
  foreach v_ref in array v_refs loop
    v_type := split_part(v_ref, ':', 1);
    if v_ref !~ '^(invoice|submission|payment|exception|milestone|waiver):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return query select 'bad_evidence_ref'::text, null::uuid; return; end if;
    v_ok := case v_type
      when 'invoice' then exists (select 1 from finance.invoices x where x.id = split_part(v_ref, ':', 2)::uuid and x.organization_id = p_organization_id and x.project_id = v_req.project_id)
      when 'submission' then exists (select 1 from finance.payment_submissions x join finance.invoices i on i.id = x.invoice_id where x.id = split_part(v_ref, ':', 2)::uuid and x.organization_id = p_organization_id and i.project_id = v_req.project_id)
      when 'payment' then exists (select 1 from finance.payments x join finance.invoices i on i.id = x.invoice_id where x.id = split_part(v_ref, ':', 2)::uuid and x.organization_id = p_organization_id and i.project_id = v_req.project_id)
      when 'exception' then exists (select 1 from finance.finance_exceptions x where x.id = split_part(v_ref, ':', 2)::uuid and x.organization_id = p_organization_id and (x.project_id = v_req.project_id or x.invoice_id in (select i.id from finance.invoices i where i.project_id = v_req.project_id)))
      when 'milestone' then exists (select 1 from projects.milestones x where x.id = split_part(v_ref, ':', 2)::uuid and x.organization_id = p_organization_id and x.project_id = v_req.project_id)
      when 'waiver' then exists (select 1 from finance.waivers x where x.id = split_part(v_ref, ':', 2)::uuid and x.organization_id = p_organization_id and x.project_id = v_req.project_id)
      else false end;
    if not v_ok then return query select 'evidence_not_found'::text, null::uuid; return; end if;
  end loop;
  if p_submission_id is not null and not exists (select 1 from finance.payment_submissions s join finance.invoices i on i.id = s.invoice_id where s.id = p_submission_id and s.organization_id = p_organization_id and i.project_id = v_req.project_id) then
    return query select 'evidence_not_found'::text, null::uuid; return;
  end if;

  if p_kind = 'reminder_draft' then
    select * into v_inv from finance.invoices i where i.id = v_req.invoice_id and i.organization_id = p_organization_id;
    if v_inv.id is null or v_inv.status not in ('issued', 'partially_paid', 'overdue') then return query select 'invoice_not_collectible'::text, null::uuid; return; end if;
    v_owed := finance.invoice_outstanding_minor(v_inv.id);
    if v_owed <= 0 then return query select 'nothing_owed'::text, null::uuid; return; end if;
    -- the amount in a reminder is the invoice's real balance, computed by the database, never the model's figure
    if p_amount_minor is distinct from v_owed then return query select 'amount_is_not_the_balance'::text, null::uuid; return; end if;
    if p_draft_body ~* '(received your payment|payment (has been |was |is )?(received|verified|confirmed)|we have received|marked (as )?paid|thank you for (the|your) payment)' then return query select 'claims_payment_received'::text, null::uuid; return; end if;
    if p_draft_body ~* '(waive|waiver|write[- ]?off|discount|refund|defer|deferral|extension|extend the due|instal+ment|payment plan|forgive|concession)' then return query select 'promises_a_concession'::text, null::uuid; return; end if;
    if (p_draft_body ~ '[0-9]{9,}' or p_draft_body ~ '([0-9]{4}[ -]){3}[0-9]{2,4}') then return query select 'account_number_shaped_text'::text, null::uuid; return; end if;
  end if;

  insert into finance.finance_proposals (organization_id, request_id, project_id, invoice_id, submission_id, agent_key, kind, summary, detail, evidence_refs, draft_body, amount_minor, proposed_exception_kind, requested_by)
  values (v_req.organization_id, v_req.id, v_req.project_id, case when p_kind = 'reminder_draft' then v_req.invoice_id else null end, p_submission_id, p_agent_key, p_kind, btrim(p_summary), p_detail, v_refs,
          case when p_kind = 'reminder_draft' then btrim(p_draft_body) else null end, case when p_kind = 'reminder_draft' then p_amount_minor else null end, p_exception_kind, v_req.requested_by)
  on conflict (request_id, kind, (md5(summary))) do nothing returning id into v_id;
  if v_id is null then return query select 'already_proposed'::text, null::uuid; return; end if;
  return query select 'proposed'::text, v_id;
end $$;
revoke all on function finance.record_finance_proposal(uuid, uuid, text, text, text, text, text[], uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function finance.record_finance_proposal(uuid, uuid, text, text, text, text, text[], uuid, text, bigint, text) to service_role;

-- ── an INDEPENDENT person accepts: nothing happens to the money; an exception classification opens the exception through the existing door ──
create or replace function finance.accept_finance_proposal(p_proposal_id uuid, p_note text default null)
returns table (outcome text, recorded_outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_kind text := finance.phase9_caller_kind(); v_actor uuid := (select auth.uid()); v_org uuid := (select core.current_organization_id());
  v_p finance.finance_proposals; v_out text := 'accepted_as_note'; v_door text; v_owed bigint; v_status text;
begin
  if v_kind not in ('admin', 'finance') then return query select 'not_authorized'::text, null::text; return; end if;
  if p_note is not null and (length(p_note) > 1000 or finance.phase9_has_secret(p_note)) then return query select 'bad_input'::text, null::text; return; end if;
  select * into v_p from finance.finance_proposals f where f.id = p_proposal_id and f.organization_id = v_org for update;
  if v_p.id is null then return query select 'not_found'::text, null::text; return; end if;
  if exists (select 1 from finance.finance_proposal_decisions d where d.proposal_id = v_p.id) then return query select 'already_decided'::text, null::text; return; end if;
  -- creator != reviewer: whoever asked for the work does not accept it
  if v_p.requested_by = v_actor then return query select 'self_acceptance'::text, null::text; return; end if;

  if v_p.kind = 'reminder_draft' then
    select i.status into v_status from finance.invoices i where i.id = v_p.invoice_id;
    v_owed := finance.invoice_outstanding_minor(v_p.invoice_id);
    -- the draft quotes a balance; if it moved, the draft is stale and a person asks again
    if v_status not in ('issued', 'partially_paid', 'overdue') or v_owed is distinct from v_p.amount_minor then return query select 'stale_draft'::text, null::text; return; end if;
    v_out := 'draft_wording_approved_nothing_sent';
  elsif v_p.kind = 'exception_classification' then
    -- the EXISTING door, as the same caller: its own refusals (subject, tenancy, secrets) decide
    select r.outcome into v_door from finance.open_finance_exception(v_p.proposed_exception_kind, v_p.summary, v_p.project_id, v_p.invoice_id, v_p.submission_id,
           jsonb_build_object('proposalId', v_p.id, 'evidenceRefs', to_jsonb(v_p.evidence_refs))) r;
    if v_door not in ('opened', 'already_open') then return query select 'refused_by_exception_door'::text, v_door; return; end if;
    v_out := 'exception_' || v_door;
  end if;

  insert into finance.finance_proposal_decisions (organization_id, proposal_id, decision, decided_by, note, recorded_outcome) values (v_org, v_p.id, 'accepted', v_actor, nullif(btrim(coalesce(p_note, '')), ''), v_out);
  perform core.record_audit(v_org, 'finance.proposal_accepted', 'finance_proposal', v_p.id, null, jsonb_build_object('agent', v_p.agent_key, 'kind', v_p.kind, 'recorded', v_out));
  return query select 'accepted'::text, v_out;
end $$;
revoke all on function finance.accept_finance_proposal(uuid, text) from public, anon;
grant execute on function finance.accept_finance_proposal(uuid, text) to authenticated;

create or replace function finance.reject_finance_proposal(p_proposal_id uuid, p_note text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_kind text := finance.phase9_caller_kind(); v_actor uuid := (select auth.uid()); v_org uuid := (select core.current_organization_id()); v_p finance.finance_proposals;
begin
  if v_kind not in ('admin', 'finance') then return query select 'not_authorized'::text; return; end if;
  if p_note is null or length(btrim(p_note)) = 0 or length(p_note) > 1000 or finance.phase9_has_secret(p_note) then return query select 'reason_required'::text; return; end if;
  select * into v_p from finance.finance_proposals f where f.id = p_proposal_id and f.organization_id = v_org for update;
  if v_p.id is null then return query select 'not_found'::text; return; end if;
  if exists (select 1 from finance.finance_proposal_decisions d where d.proposal_id = v_p.id) then return query select 'already_decided'::text; return; end if;
  -- a requester cannot bury an unwelcome proposal either
  if v_p.requested_by = v_actor then return query select 'self_acceptance'::text; return; end if;
  insert into finance.finance_proposal_decisions (organization_id, proposal_id, decision, decided_by, note, recorded_outcome) values (v_org, v_p.id, 'rejected', v_actor, btrim(p_note), 'rejected');
  perform core.record_audit(v_org, 'finance.proposal_rejected', 'finance_proposal', v_p.id, null, jsonb_build_object('agent', v_p.agent_key, 'kind', v_p.kind));
  return query select 'rejected'::text;
end $$;
revoke all on function finance.reject_finance_proposal(uuid, text) from public, anon;
grant execute on function finance.reject_finance_proposal(uuid, text) to authenticated;

notify pgrst, 'reload schema';
