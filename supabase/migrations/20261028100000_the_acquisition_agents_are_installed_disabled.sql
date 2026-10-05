-- ═══════════════════════════════════════════════════════════════════════════
-- The acquisition agents are installed, DISABLED - ADM-112
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The owner asked (2026-10-05) for the agents the Lead Generation & Acquisition
-- Implementation Specification names: Ad Manager, Email Outreach, Social Media
-- and B2B Opportunity. ADM-82's roster of thirteen was closed, so this is a new
-- grant. Scheduler and Quotation Master are shared and already exist as the
-- meeting and quotation subtasks; the landing page belongs to the Ad Manager.
--
-- A definition is not an activation. Every row is `enabled = false`, as ADM-82's
-- own grant was. Two things stand between these agents and real work and both
-- are the owner's: a funded model key, and a decision under ADM-99 to dispatch
-- the draft-creating tools (today only the four read-only tools dispatch).
-- Nothing a person-facing engine does changes: no agent holds a tool that sends,
-- publishes, launches, deploys, prices, approves or pauses.

insert into ai.agents (key, display_name, description, autonomy_level, enabled,
                       default_model, default_effort, max_steps, max_cost_minor,
                       disabled_reason)
values
  ('ad_manager', 'Ad Manager',
   'Audits past ad results, drafts Meta and Google campaign versions and the Google landing page, and watches results against qualified leads. Launches nothing and changes no budget.',
   'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-112. Needs a funded model key and an ADM-99 decision to dispatch its draft-creating tools. Activation is a separate decision.'),

  ('email_outreach', 'Email Outreach',
   'Researches and scores prospects against the ICP, drafts personalised outreach from recorded facts and checks it. Sends nothing: a campaign sends through the governed path.',
   'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-112. Needs a funded model key and an ADM-99 decision to dispatch its draft-creating tools. Activation is a separate decision.'),

  ('social_media', 'Social Media',
   'Plans content from the strategy, drafts versions with an objective and runs the review. Publishes nothing: a version publishes only when approved exactly as written.',
   'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-112. Needs a funded model key and an ADM-99 decision to dispatch its draft-creating tools. Activation is a separate decision.'),

  ('marketplace_opportunity', 'B2B Opportunity',
   'Scores marketplace opportunities, rejects low fit and drafts tailored proposals from the real opportunity and approved agency evidence. Prices nothing and submits nothing.',
   'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-112. Needs a funded model key and an ADM-99 decision to dispatch its draft-creating tools. Activation is a separate decision.')
on conflict (key) do nothing;

insert into ai.agent_handoff_targets (from_agent, to_agent)
values
  ('ad_manager', 'sales'),
  ('ad_manager', 'quality_assurance'),
  ('email_outreach', 'sales'),
  ('email_outreach', 'quality_assurance'),
  ('social_media', 'sales'),
  ('social_media', 'quality_assurance'),
  ('marketplace_opportunity', 'sales'),
  ('marketplace_opportunity', 'quality_assurance')
on conflict (from_agent, to_agent) do nothing;

insert into ai.agent_verifiers (producer, verifier)
values
  ('ad_manager', 'quality_assurance'),
  ('email_outreach', 'quality_assurance'),
  ('social_media', 'quality_assurance'),
  ('marketplace_opportunity', 'quality_assurance')
on conflict (producer) do nothing;
