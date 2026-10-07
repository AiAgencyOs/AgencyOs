-- ═══════════════════════════════════════════════════════════════════════════
-- Round 4 (additive; no table is created, no column narrowed or renamed). Three buildable rows that need no outside account:
--
--   1. Phase 8A, Support: a HOW-TO ticket closes only when the person has CITED an APPROVED knowledge article for it
--      (projects.ticket_knowledge_citations, written by cite_knowledge_for_ticket). The old door accepted any free-text "evidence" as the source,
--      so "answer only from approved knowledge" was a hope. Now: no note -> answer_and_source_required (unchanged code), no citation ->
--      approved_knowledge_citation_required, a citation whose article has since been retired -> cited_knowledge_no_longer_approved.
--      The free-text evidence argument stays accepted (it is recorded on the ticket event) but no longer substitutes for the citation.
--      The patch is applied to the LIVE definition and raises if the expected text is missing.
--   2. Phase 8A, P8-GATE-008: the Customer Success handoff package carries the client's contact preferences (channel, avoided channels, language,
--      preferred contact, note) from projects.client_contact_preferences, or says plainly that none is recorded. Advice only: it is never a gate.
--   3. Phase 9, P9-AG-09: a finance agent run has a COMPLETION REPORT, DERIVED on read (nothing is stored): record ids, state, evidence refs,
--      the person's decision, the audit rows that name the proposals, and the blockers (a run with no output, proposals awaiting a decision).
--      Admin or Finance only.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function pg_temp.p5r_swap(p_src text, p_old text, p_new text, p_what text)
returns text language plpgsql as $$
begin
  if position(p_old in p_src) = 0 then raise exception 'p5r patch (%): expected text not found: %', p_what, left(p_old, 90); end if;
  return replace(p_src, p_old, p_new);
end $$;

-- ── 1. a how-to closes on an approved article's citation ────────────────────
do $$
declare v_def text := pg_get_functiondef('projects.advance_support_ticket(uuid, text, text, text, boolean)'::regprocedure);
begin
  v_def := pg_temp.p5r_swap(v_def,
    $o$if v_note is null or v_ev is null then return query select 'answer_and_source_required'::text; return; end if;$o$,
    $n$if v_note is null then return query select 'answer_and_source_required'::text; return; end if;
      if not exists (select 1 from projects.ticket_knowledge_citations kc where kc.ticket_id = v_t.id and kc.organization_id = v_org) then
        return query select 'approved_knowledge_citation_required'::text; return;
      end if;
      if not exists (select 1 from projects.ticket_knowledge_citations kc join projects.support_knowledge_articles ka on ka.id = kc.article_id
                      where kc.ticket_id = v_t.id and kc.organization_id = v_org and ka.status = 'approved') then
        return query select 'cited_knowledge_no_longer_approved'::text; return;
      end if;$n$, 'how-to close');
  execute v_def;
end $$;

-- ── 2. contact preferences in the handoff package ───────────────────────────
create or replace function projects.p5r_intake_preferences(p_client_account_id uuid, p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_p projects.client_contact_preferences;
begin
  select * into v_p from projects.client_contact_preferences cp where cp.client_account_id = p_client_account_id and cp.organization_id = p_organization_id;
  if v_p.id is null then
    return to_jsonb('none recorded: AgencyOS holds WhatsApp consent per contact (crm.communication_consent); no channel or language preference has been recorded for this client yet'::text);
  end if;
  return jsonb_build_object('preferredChannel', v_p.preferred_channel, 'avoidChannels', to_jsonb(v_p.avoid_channels), 'language', v_p.language,
    'preferredContactId', v_p.preferred_contact_id, 'note', v_p.note, 'source', v_p.source, 'recordedAt', v_p.set_at);
end $$;
revoke all on function projects.p5r_intake_preferences(uuid, uuid) from public, anon, authenticated, service_role;

do $$
declare v_def text := pg_get_functiondef('projects.p8_build_intake(uuid, uuid)'::regprocedure);
begin
  v_def := pg_temp.p5r_swap(v_def,
    $o$'preferences', 'none recorded: AgencyOS holds WhatsApp consent per contact (crm.communication_consent) and no other channel or language preference'$o$,
    $n$'preferences', projects.p5r_intake_preferences(v_project.client_account_id, p_organization_id)$n$, 'intake preferences');
  execute v_def;
end $$;

-- ── 3. a finance agent run has a completion report, derived ─────────────────
create or replace function finance.p5r_finance_agent_completion_report(p_request_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_kind text := finance.phase9_caller_kind(); v_org uuid := (select core.current_organization_id()); v_r finance.finance_agent_requests;
  v_props jsonb; v_blockers jsonb := '[]'::jsonb; v_n int; v_undecided int; v_state text; v_agent ai.agents;
begin
  if v_kind not in ('admin', 'finance') or v_org is null then return null; end if;
  select * into v_r from finance.finance_agent_requests r where r.id = p_request_id and r.organization_id = v_org;
  if v_r.id is null then return null; end if;
  select * into v_agent from ai.agents a where a.key = v_r.agent_key;
  select coalesce(jsonb_agg(jsonb_build_object(
      'proposalId', p.id, 'kind', p.kind, 'summary', p.summary, 'evidenceRefs', to_jsonb(p.evidence_refs), 'invoiceId', p.invoice_id, 'submissionId', p.submission_id,
      'decision', coalesce(d.decision, 'awaiting'), 'decidedBy', d.decided_by, 'decidedAt', d.decided_at, 'recordedOutcome', d.recorded_outcome, 'note', d.note,
      'auditActions', coalesce((select jsonb_agg(al.action order by al.id) from audit.audit_log al
                                 where al.organization_id = v_org and al.subject_type = 'finance_proposal' and al.subject_id = p.id), '[]'::jsonb)
    ) order by p.created_at, p.id), '[]'::jsonb),
    count(*)::int, count(*) filter (where d.id is null)::int
    into v_props, v_n, v_undecided
    from finance.finance_proposals p left join finance.finance_proposal_decisions d on d.proposal_id = p.id
    where p.request_id = v_r.id and p.organization_id = v_org;
  if v_n = 0 then v_blockers := v_blockers || jsonb_build_array('the run produced no proposal: nothing was recorded and nothing is waiting'); end if;
  if v_undecided > 0 then v_blockers := v_blockers || jsonb_build_array(v_undecided || ' proposal(s) await a person''s decision'); end if;
  v_state := case when v_n = 0 then 'no_output' when v_undecided > 0 then 'awaiting_decision' else 'decided' end;
  return jsonb_build_object('requestId', v_r.id, 'agentKey', v_r.agent_key, 'projectId', v_r.project_id, 'invoiceId', v_r.invoice_id,
    'requestedBy', v_r.requested_by, 'requestedAt', v_r.created_at, 'state', v_state, 'proposalCount', v_n, 'proposals', v_props, 'blockers', v_blockers,
    'policyRef', jsonb_build_object('agent', v_r.agent_key, 'autonomy', v_agent.autonomy_level, 'enabled', v_agent.enabled,
                                    'statement', 'A proposal is never a fact. Only a person''s decision on it, through the existing door, changes a record.'),
    'handoff', case when v_state = 'decided' then 'every proposal has a person''s decision' else 'not complete: see blockers' end);
end $$;
revoke all on function finance.p5r_finance_agent_completion_report(uuid) from public, anon, service_role;
grant execute on function finance.p5r_finance_agent_completion_report(uuid) to authenticated;

notify pgrst, 'reload schema';
