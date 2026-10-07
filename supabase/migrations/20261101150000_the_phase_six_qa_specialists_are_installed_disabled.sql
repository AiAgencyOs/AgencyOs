-- ═══════════════════════════════════════════════════════════════════════════
-- The Phase 6 QA specialists are installed, DISABLED - ADM-114
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 6's QA Orchestrator is `quality_assurance` (ADM-82's one verifier); no duplicate orchestrator is created. The nine specialists below produce
-- test evidence. A definition is not an activation: every row is enabled = false, none holds a tool, and none may verify, approve a candidate, record an
-- exception, verify a payment or deploy. Independence (creator != validator) is enforced in the database for every result they would record.
insert into ai.agents (key, display_name, description, autonomy_level, enabled, default_model, default_effort, max_steps, max_cost_minor, disabled_reason)
values
  ('functional_test', 'Functional Test Agent', 'Verifies features, business rules and acceptance criteria against the exact release candidate. Does not fix.', 'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-114. Needs a funded model key and a decision to dispatch its tools. Activation is a separate decision.'),
  ('ui_journey_test', 'UI / E2E Test Agent', 'Tests the approved UI and the critical user journeys end to end.', 'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-114. Needs a funded model key, a browser runner and a decision to dispatch its tools. Activation is a separate decision.'),
  ('api_integration_test', 'API / Integration Test Agent', 'Tests API contracts and integrations. Configured is not verified.', 'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-114. Needs a funded model key and provider sandboxes. Activation is a separate decision.'),
  ('database_test', 'Database Test Agent', 'Tests schema, constraints, RLS, tenant isolation, migrations and transactions.', 'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-114. Needs a funded model key and a disposable database. Activation is a separate decision.'),
  ('security_test', 'Security Test Agent', 'Independent security and permission validation.', 'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-114. Needs a funded model key and an isolated QA tenant. Activation is a separate decision.'),
  ('performance_test', 'Performance Test Agent', 'Measures against project-specific targets, recording method and environment.', 'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-114. Needs a funded model key and a load environment. Activation is a separate decision.'),
  ('compatibility_test', 'Compatibility / Device Test Agent', 'Tests the declared browser/device matrix; an unavailable target is BLOCKED.', 'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-114. Needs a funded model key and device/browser access. Activation is a separate decision.'),
  ('regression_test', 'Regression Test Agent', 'Targeted, expanded and full relevant regression and escaped-defect protection.', 'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-114. Needs a funded model key and a repository binding. Activation is a separate decision.'),
  ('release_readiness', 'Release / Production Readiness Agent', 'Freezes the exact candidate, evaluates gates and readiness, prepares the Phase 7 intake. Approves and deploys nothing.', 'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-114. Needs a funded model key. Activation is a separate decision.')
on conflict (key) do nothing;

insert into ai.agent_handoff_targets (from_agent, to_agent)
values
  ('quality_assurance', 'functional_test'), ('quality_assurance', 'ui_journey_test'), ('quality_assurance', 'api_integration_test'),
  ('quality_assurance', 'database_test'), ('quality_assurance', 'security_test'), ('quality_assurance', 'performance_test'),
  ('quality_assurance', 'compatibility_test'), ('quality_assurance', 'regression_test'), ('quality_assurance', 'release_readiness'),
  ('functional_test', 'quality_assurance'), ('ui_journey_test', 'quality_assurance'), ('api_integration_test', 'quality_assurance'),
  ('database_test', 'quality_assurance'), ('security_test', 'quality_assurance'), ('performance_test', 'quality_assurance'),
  ('compatibility_test', 'quality_assurance'), ('regression_test', 'quality_assurance'), ('release_readiness', 'quality_assurance')
on conflict (from_agent, to_agent) do nothing;

insert into ai.agent_verifiers (producer, verifier)
values
  ('functional_test', 'quality_assurance'), ('ui_journey_test', 'quality_assurance'), ('api_integration_test', 'quality_assurance'),
  ('database_test', 'quality_assurance'), ('security_test', 'quality_assurance'), ('performance_test', 'quality_assurance'),
  ('compatibility_test', 'quality_assurance'), ('regression_test', 'quality_assurance'), ('release_readiness', 'quality_assurance')
on conflict (producer) do nothing;

notify pgrst, 'reload schema';
