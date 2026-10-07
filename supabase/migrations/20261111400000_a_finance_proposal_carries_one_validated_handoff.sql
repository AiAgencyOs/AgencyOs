-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 9B - part 4: ONE structured handoff payload on a finance proposal, stored as validated jsonb.
--
-- The plan (section 9) asks for a single handoff document: organization, client, project, task, version, milestone, invoice, expected amount, state,
-- references, policy, approvals, evidence, priority, blockers, correlation and retry. The TypeScript type is src/modules/finance/phase-nine-handoff.ts; this
-- is its database twin and the one that binds:
--
--   * finance.finance_proposals.handoff        - jsonb, null for proposals recorded before this change (the legacy door call still works).
--   * finance.phase9b_handoff_shape_ok(jsonb)  - the SHAPE, as a CHECK: an object, every key present, schemaVersion 1, a known priority, arrays where
--                                                arrays belong, moneyAuthority 'none', independent review required.
--   * finance.record_finance_proposal          - gains p_handoff. When one is given the door RE-READS the rows and refuses a payload that disagrees with
--                                                them (organization, project, request, agent, kind, requester, client account, invoice, milestone, evidence
--                                                references, and an expected amount that is not the database's own balance): the payload is a claim, the
--                                                rows are the authority. It also refuses while the agent is paused (migration 20261111300000), so a run that
--                                                was already in flight when an Admin paused automation cannot write.
-- Everything else in the door is exactly as 20261106500000 defined it.
-- ═══════════════════════════════════════════════════════════════════════════

alter table finance.finance_proposals add column if not exists handoff jsonb;

create or replace function finance.phase9b_handoff_shape_ok(p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select p is null or (
    jsonb_typeof(p) = 'object'
    and p ?& array['schemaVersion', 'organizationId', 'clientAccountId', 'projectId', 'requestId', 'agentKey', 'kind', 'milestoneId', 'invoiceId', 'expectedAmountMinor', 'currency',
                   'financialState', 'evidenceRefs', 'policy', 'approvals', 'priority', 'blockers', 'correlationId', 'retry']
    and p ->> 'schemaVersion' = '1'
    and p ->> 'agentKey' in ('finance_reconciliation', 'finance_communication', 'finance_close')
    and p ->> 'kind' in ('reconciliation_finding', 'anomaly_flag', 'reminder_draft', 'close_readiness_note', 'exception_classification')
    and p ->> 'priority' in ('low', 'normal', 'high')
    and jsonb_typeof(p -> 'evidenceRefs') = 'array'
    and jsonb_typeof(p -> 'blockers') = 'array'
    and jsonb_typeof(p -> 'policy') = 'object' and p -> 'policy' ->> 'moneyAuthority' = 'none'
    and jsonb_typeof(p -> 'approvals') = 'object' and p -> 'approvals' ->> 'independentReviewRequired' = 'true'
    and jsonb_typeof(p -> 'retry') = 'object' and jsonb_typeof(p -> 'retry' -> 'attempt') = 'number'
    and jsonb_typeof(p -> 'correlationId') in ('string', 'null')
  )
$$;
revoke all on function finance.phase9b_handoff_shape_ok(jsonb) from public, anon;
grant execute on function finance.phase9b_handoff_shape_ok(jsonb) to authenticated, service_role;

alter table finance.finance_proposals drop constraint if exists finance_proposals_handoff_shape;
alter table finance.finance_proposals add constraint finance_proposals_handoff_shape check (finance.phase9b_handoff_shape_ok(handoff));

-- the old 11-argument signature is replaced, not overloaded
drop function if exists finance.record_finance_proposal(uuid, uuid, text, text, text, text, text[], uuid, text, bigint, text);

create or replace function finance.record_finance_proposal(
  p_request_id uuid, p_organization_id uuid, p_agent_key text, p_kind text, p_summary text, p_detail text, p_evidence_refs text[],
  p_submission_id uuid default null, p_draft_body text default null, p_amount_minor bigint default null, p_exception_kind text default null, p_handoff jsonb default null)
returns table (outcome text, proposal_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_req finance.finance_agent_requests; v_refs text[] := coalesce(p_evidence_refs, '{}'); v_ref text; v_type text; v_id uuid; v_text text; v_owed bigint; v_inv finance.invoices; v_ok boolean;
  v_client uuid; v_hand_inv uuid; v_hand_ms uuid; v_hand_amt bigint;
begin
  if (select auth.uid()) is not null or coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_req from finance.finance_agent_requests r where r.id = p_request_id;
  if v_req.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  -- the organization is the JOB's (the runner's), never one a payload names
  if v_req.organization_id is distinct from p_organization_id then return query select 'wrong_organization'::text, null::uuid; return; end if;
  if p_agent_key is distinct from v_req.agent_key then return query select 'wrong_agent'::text, null::uuid; return; end if;
  -- an Admin paused this agent (or all finance automation): nothing is written, even by a run that started before the pause
  if exists (select 1 from finance.finance_automation_controls c where c.organization_id = v_req.organization_id and c.paused and c.agent_key in ('all', v_req.agent_key)) then
    return query select 'automation_paused'::text, null::uuid; return;
  end if;
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

  -- the handoff payload (optional for a legacy caller): its shape, then every claim in it against the rows
  if p_handoff is not null then
    if not finance.phase9b_handoff_shape_ok(p_handoff) or finance.phase9_has_secret(p_handoff::text) then return query select 'bad_handoff'::text, null::uuid; return; end if;
    if p_handoff ->> 'organizationId' is distinct from v_req.organization_id::text or p_handoff ->> 'projectId' is distinct from v_req.project_id::text
       or p_handoff ->> 'requestId' is distinct from v_req.id::text or p_handoff ->> 'agentKey' is distinct from v_req.agent_key or p_handoff ->> 'kind' is distinct from p_kind
       or p_handoff -> 'approvals' ->> 'requestedBy' is distinct from v_req.requested_by::text then
      return query select 'handoff_disagrees_with_the_request'::text, null::uuid; return;
    end if;
    -- the cited evidence in the handoff is exactly the proposal's evidence
    if coalesce((select array_agg(e order by e) from jsonb_array_elements_text(p_handoff -> 'evidenceRefs') e), '{}'::text[]) is distinct from (select coalesce(array_agg(x order by x), '{}'::text[]) from unnest(v_refs) x) then
      return query select 'handoff_disagrees_with_the_request'::text, null::uuid; return;
    end if;
    if jsonb_typeof(p_handoff -> 'clientAccountId') = 'string' then
      select p.client_account_id into v_client from projects.projects p where p.id = v_req.project_id;
      if (p_handoff ->> 'clientAccountId') is distinct from v_client::text then return query select 'handoff_disagrees_with_the_request'::text, null::uuid; return; end if;
    end if;
    if jsonb_typeof(p_handoff -> 'milestoneId') = 'string' then
      v_hand_ms := (p_handoff ->> 'milestoneId')::uuid;
      if not exists (select 1 from projects.milestones m where m.id = v_hand_ms and m.organization_id = v_req.organization_id and m.project_id = v_req.project_id) then return query select 'handoff_disagrees_with_the_request'::text, null::uuid; return; end if;
    end if;
    if jsonb_typeof(p_handoff -> 'invoiceId') = 'string' then
      v_hand_inv := (p_handoff ->> 'invoiceId')::uuid;
      if not exists (select 1 from finance.invoices i where i.id = v_hand_inv and i.organization_id = v_req.organization_id and i.project_id = v_req.project_id)
         or (v_req.invoice_id is not null and v_hand_inv is distinct from v_req.invoice_id) then
        return query select 'handoff_disagrees_with_the_request'::text, null::uuid; return;
      end if;
    end if;
    if jsonb_typeof(p_handoff -> 'expectedAmountMinor') = 'number' then
      -- an expected amount is the database's own balance of an invoice the handoff names; never a figure the payload brings
      v_hand_amt := (p_handoff ->> 'expectedAmountMinor')::bigint;
      if v_hand_inv is null or v_hand_amt is distinct from finance.invoice_outstanding_minor(v_hand_inv) then return query select 'handoff_amount_is_not_the_balance'::text, null::uuid; return; end if;
    end if;
    if p_kind = 'reminder_draft' and v_hand_inv is distinct from v_req.invoice_id then return query select 'handoff_disagrees_with_the_request'::text, null::uuid; return; end if;
  end if;

  insert into finance.finance_proposals (organization_id, request_id, project_id, invoice_id, submission_id, agent_key, kind, summary, detail, evidence_refs, draft_body, amount_minor, proposed_exception_kind, requested_by, handoff)
  values (v_req.organization_id, v_req.id, v_req.project_id, case when p_kind = 'reminder_draft' then v_req.invoice_id else null end, p_submission_id, p_agent_key, p_kind, btrim(p_summary), p_detail, v_refs,
          case when p_kind = 'reminder_draft' then btrim(p_draft_body) else null end, case when p_kind = 'reminder_draft' then p_amount_minor else null end, p_exception_kind, v_req.requested_by, p_handoff)
  on conflict (request_id, kind, (md5(summary))) do nothing returning id into v_id;
  if v_id is null then return query select 'already_proposed'::text, null::uuid; return; end if;
  return query select 'proposed'::text, v_id;
end $$;
revoke all on function finance.record_finance_proposal(uuid, uuid, text, text, text, text, text[], uuid, text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function finance.record_finance_proposal(uuid, uuid, text, text, text, text, text[], uuid, text, bigint, text, jsonb) to service_role;

notify pgrst, 'reload schema';
