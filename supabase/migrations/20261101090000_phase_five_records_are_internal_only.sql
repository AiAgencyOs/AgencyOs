-- ═══════════════════════════════════════════════════════════════════════════
-- A portal client carries the same organization claim as staff (core.is_client() is a role, not a different tenant), so a read policy that checks
-- only the organization lets a client read it. The Phase 5 tables written in 20261031* (code reviews and their findings, build runs and
-- fingerprints, integration health, plans, routing decisions, flaky tests, derived documents, the Phase 6 intake...) are INTERNAL records: the
-- clients' view of the project is the portal, never these. Phase 6 spec: "Client must NOT see raw exploit details, private security evidence,
-- source branches, internal agent prompts, model/provider names, private Admin comments."
--
-- Every read policy below is tightened to `organization AND core.is_internal()`. (Client-facing facts - a shared build, an approval - live in
-- projects.deliverables, whose policy already distinguishes client from staff.)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare r record;
begin
  for r in select * from (values
    ('projects', 'phase_five',               'phase_five_read'),
    ('projects', 'development_baselines',    'development_baselines_read'),
    ('projects', 'code_reviews',             'code_reviews_read'),
    ('projects', 'build_feedback',           'build_feedback_read'),
    ('projects', 'integration_connections',  'integration_connections_read'),
    ('projects', 'phase_five_agent_state',   'phase_five_agent_state_read'),
    ('projects', 'phase_five_handoffs',      'phase_five_handoffs_read'),
    ('projects', 'development_plans',        'development_plans_read'),
    ('projects', 'build_runs',               'build_runs_read'),
    ('projects', 'task_test_evidence',       'task_test_evidence_read'),
    ('projects', 'routing_decisions',        'routing_decisions_read'),
    ('projects', 'technical_documents',      'technical_documents_read'),
    ('qa',       'flaky_tests',              'flaky_tests_read'),
    ('qa',       'test_run_cases',           'test_run_cases_read')
  ) as t(sch, tbl, pol) loop
    execute format('drop policy if exists %I on %I.%I', r.pol, r.sch, r.tbl);
    execute format($p$create policy %I on %I.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))$p$, r.pol, r.sch, r.tbl);
  end loop;
end $$;
