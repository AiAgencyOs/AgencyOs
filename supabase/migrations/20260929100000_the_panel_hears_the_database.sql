-- The panel hears the database.
--
-- Until now every admin screen learned about a change the way a newspaper
-- does: by asking again on a schedule (`AutoRefresh`, 15–30 seconds). This
-- migration is the other half of push: the tables whose state an operator
-- watches join the `supabase_realtime` publication, so a committed row change
-- reaches an open screen as a websocket message (Supabase Realtime,
-- postgres_changes) and the screen re-runs its OWN server reads.
--
-- Three things this does NOT change:
--
--   · Authority. A change notification is a signal, never data: the browser
--     discards the payload and refetches through the same RLS-scoped queries
--     that always rendered the page. Nothing is shown that the query would
--     not show.
--   · Isolation. Realtime evaluates each subscriber against the table's
--     SELECT policies with the subscriber's own JWT, so a tenant is told only
--     about rows it could already read. No policy is loosened here.
--   · The set of tables. `src/lib/realtime/topics.ts` is the list a screen
--     subscribes from, and a test asserts every table it names is one this
--     migration publishes — the two cannot drift apart silently.
--
-- Deliberately absent: `core.cron_heartbeat` (a write per minute) and the
-- `audit.audit_log` is present but attached only to the audit screen's topic
-- — a refresh per heartbeat would be the polling this replaces.
--
-- Idempotent: a table already in the publication is skipped; a hosted project
-- whose publication is FOR ALL TABLES needs nothing added and gets nothing.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
declare
  t text;
  tables constant text[] := array[
    'ai.agent_runs',
    'ai.agents',
    'ai.cost_ledger',
    'approvals.approval_requests',
    'audit.audit_log',
    'core.client_accounts',
    'core.client_notes',
    'core.jobs',
    'core.memberships',
    'core.outbox_events',
    'crm.conversation_messages',
    'crm.conversations',
    'crm.deferred_sends',
    'crm.follow_up_sends',
    'crm.follow_up_sequences',
    'crm.lead_activities',
    'crm.leads',
    'crm.meeting_evidence',
    'crm.meetings',
    'crm.qualification_coverage',
    'crm.requirement_versions',
    'finance.invoices',
    'finance.payment_submissions',
    'finance.payments',
    'finance.refunds',
    'projects.change_requests',
    'projects.deliverables',
    'projects.features',
    'projects.milestones',
    'projects.modules',
    'projects.phase_three',
    'projects.projects',
    'projects.tasks',
    'qa.defects',
    'qa.test_plans',
    'qa.test_runs',
    'sales.opportunities',
    'sales.proposal_plan_sets',
    'sales.proposals'
  ];
begin
  if (select puballtables from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publishes all tables; nothing to add';
    return;
  end if;

  foreach t in array tables loop
    if to_regclass(t) is null then
      raise exception 'realtime publication: table % does not exist', t;
    end if;
    if not exists (
      select 1
        from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname || '.' || tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %s', t);
    end if;
  end loop;
end $$;
