-- ═══════════════════════════════════════════════════════════════════════════
-- The Phase 7 agents are installed, DISABLED (P704, P705, P706).
-- Phase 7 reuses the PM (`project_manager`), the Orchestrator (`orchestrator`), Finance (`finance`), the Handover agent (`handover`) and Customer Success
-- (`customer_success`); no duplicate is created. Three roles named by the specification do not exist yet and are defined here:
--   deployment_agent   executes the exact approved candidate. It cannot approve its own deployment, declare ProductionValidated, edit source in production or expose a secret.
--   release_qa         the QA / Release specialist: independent post-deployment smoke and live verification. It cannot deploy, fix code or approve exceptions.
--   incident_recovery  production incident, rollback and recovery coordination. It cannot hide a failure, close an incident without validation, or apply unreviewed code.
-- A definition is not an activation: every row is enabled = false and holds no tool. The real deployment executor needs production credentials (an owner binding);
-- until then a deployment door records an honest blocker. Independence (the validator is not the deployer) is enforced in the database, not by these definitions.
-- ═══════════════════════════════════════════════════════════════════════════
insert into ai.agents (key, display_name, description, autonomy_level, enabled, default_model, default_effort, max_steps, max_cost_minor, disabled_reason)
values
  ('deployment_agent', 'Deployment Agent', 'Deploys the exact Admin-approved Phase 6 candidate to production with validated configuration, migrations and rollback controls. Never approves its own deployment and never declares ProductionValidated.', 'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Phase 7 specification P704. Needs production credentials (an owner binding), a funded model key and a deployment executor. Activation is a separate decision.'),
  ('release_qa', 'QA / Release Agent', 'Independently validates the exact deployed candidate in production: smoke, live critical flows, monitoring and rollback verification. A deployment claim is not production validation.', 'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Phase 7 specification P705. Needs production read access, safe test accounts and a funded model key. Activation is a separate decision.'),
  ('incident_recovery', 'Production Incident and Recovery Agent', 'Coordinates production incidents, controlled rollback and recovery for the exact release. Completion stays paused until recovery is verified.', 'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Phase 7 specification P706. Needs production access under an owner binding and a funded model key. Activation is a separate decision.')
on conflict (key) do nothing;

insert into ai.agent_handoff_targets (from_agent, to_agent)
values
  ('deployment_agent', 'quality_assurance'), ('release_qa', 'quality_assurance'), ('incident_recovery', 'quality_assurance')
on conflict (from_agent, to_agent) do nothing;

insert into ai.agent_verifiers (producer, verifier)
values
  ('deployment_agent', 'quality_assurance'), ('release_qa', 'quality_assurance'), ('incident_recovery', 'quality_assurance')
on conflict (producer) do nothing;

notify pgrst, 'reload schema';
