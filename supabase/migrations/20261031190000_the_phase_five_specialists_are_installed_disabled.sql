-- ═══════════════════════════════════════════════════════════════════════════
-- The Phase 5 development specialists are installed, DISABLED - ADM-113
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The owner's Phase 5 specification names eleven development capabilities. ADM-82's roster was closed, so - as with ADM-112 - this is a new
-- grant, and like every grant here a definition is not an activation. Every row is enabled = false. Nothing here holds a tool that merges,
-- deploys, approves or verifies; `quality_assurance` stays the only agent that may declare anyone's work complete (the verifiers below all
-- name it), and `security_review` REVIEWS - it records findings on the exact commit - without verification authority.

insert into ai.agents (key, display_name, description, autonomy_level, enabled,
                       default_model, default_effort, max_steps, max_cost_minor,
                       disabled_reason)
values
  ('frontend_developer', 'Frontend Developer',
   'Implements the exact client-approved UI version and prototype: screens, states, forms, accessibility. No silent redesign.',
   'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-113. Needs a funded model key, a repository binding and a decision to dispatch its tools. Activation is a separate decision.'),
  ('backend_developer', 'Backend / API Developer',
   'Implements authoritative business logic, APIs and server actions that trace to approved requirements. Never redefines scope.',
   'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-113. Needs a funded model key, a repository binding and a decision to dispatch its tools. Activation is a separate decision.'),
  ('database_developer', 'Database Developer',
   'Writes schema, constraints, RLS and migrations. Never rewrites migration history, never weakens RLS to make a feature work.',
   'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-113. Needs a funded model key, a repository binding and a decision to dispatch its tools. Activation is a separate decision.'),
  ('mobile_developer', 'Mobile Developer',
   'Implements the approved mobile UI on Flutter, Android and iOS. NOT_REQUIRED for a web-only project; never fabricates a device test.',
   'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-113. Needs a funded model key, a repository binding and a decision to dispatch its tools. Activation is a separate decision.'),
  ('integration', 'Integration Agent',
   'Connects approved external services through canonical adapters. CONFIGURED is not VERIFIED; a mock success is not a real integration.',
   'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-113. Needs a funded model key, provider credentials and a decision to dispatch its tools. Activation is a separate decision.'),
  ('devops_build', 'DevOps / Build Agent',
   'Runs the development build system: environment checks, builds, artifacts with source traceability. No production deployment in Phase 5.',
   'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-113. Needs a funded model key, CI access and a decision to dispatch its tools. Activation is a separate decision.'),
  ('test_automation', 'Test Automation Agent',
   'Writes and runs unit, API, database, integration and E2E tests and records machine-readable results. Automated green is not independent QA pass.',
   'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-113. Needs a funded model key, a repository binding and a decision to dispatch its tools. Activation is a separate decision.'),
  ('security_review', 'Security & Code Review Agent',
   'Reviews the exact commit independently of whoever wrote it: auth, RLS, tenancy, secrets, injection. Records findings; verification authority stays with QA.',
   'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-113. Needs a funded model key and a repository binding. Activation is a separate decision.'),
  ('bug_fix', 'Bug Fix Agent',
   'Reproduces a defect, finds the root cause and makes the minimal fix. Produces FIX_READY only; QA verifies. Never closes its own defect.',
   'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-113. Needs a funded model key, a repository binding and a decision to dispatch its tools. Activation is a separate decision.'),
  ('refactor_performance', 'Refactoring & Performance Agent',
   'Conditional: only for approved technical debt or a measured performance problem; baseline first, before-and-after measurement, no functional change.',
   'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-113. Conditional by design (NOT_REQUIRED unless an approved need exists). Activation is a separate decision.'),
  ('documentation', 'Documentation Agent',
   'Keeps implementation-derived documentation current and builds the Phase 6 QA intake. Documents what exists; never what is planned, never a secret.',
   'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-113. Needs a funded model key. Activation is a separate decision.')
on conflict (key) do nothing;

insert into ai.agent_handoff_targets (from_agent, to_agent)
values
  ('frontend_developer', 'quality_assurance'), ('frontend_developer', 'security_review'),
  ('backend_developer', 'quality_assurance'), ('backend_developer', 'security_review'),
  ('database_developer', 'quality_assurance'), ('database_developer', 'security_review'),
  ('mobile_developer', 'quality_assurance'), ('mobile_developer', 'security_review'),
  ('integration', 'quality_assurance'), ('integration', 'security_review'),
  ('devops_build', 'quality_assurance'),
  ('test_automation', 'quality_assurance'),
  ('security_review', 'quality_assurance'),
  ('bug_fix', 'quality_assurance'), ('bug_fix', 'security_review'),
  ('refactor_performance', 'quality_assurance'), ('refactor_performance', 'security_review'),
  ('documentation', 'quality_assurance')
on conflict (from_agent, to_agent) do nothing;

insert into ai.agent_verifiers (producer, verifier)
values
  ('frontend_developer', 'quality_assurance'),
  ('backend_developer', 'quality_assurance'),
  ('database_developer', 'quality_assurance'),
  ('mobile_developer', 'quality_assurance'),
  ('integration', 'quality_assurance'),
  ('devops_build', 'quality_assurance'),
  ('test_automation', 'quality_assurance'),
  ('security_review', 'quality_assurance'),
  ('bug_fix', 'quality_assurance'),
  ('refactor_performance', 'quality_assurance'),
  ('documentation', 'quality_assurance')
on conflict (producer) do nothing;

notify pgrst, 'reload schema';
