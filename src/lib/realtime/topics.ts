/**
 * What a screen listens to.
 *
 * A screen names TOPICS — the business things it shows — and this table says
 * which tables carry them. The screen never names a table, so a table that
 * moves or splits is one edit here rather than one per page, and a test can
 * assert that every table named here is one the database actually publishes
 * (`tests/realtime-topics.test.ts` reads the migration).
 *
 * Only tables that CHANGE STATE A PERSON IS WATCHING are here. High-churn
 * bookkeeping (`core.cron_heartbeat` every minute, `audit.audit_log` on every
 * write) is deliberately not attached to the operational screens — a refresh
 * per heartbeat is the polling this transport exists to replace. The audit
 * log is its own topic, subscribed to only by the audit screen.
 */

export type TableRef = { schema: string; table: string };

export const TOPICS = {
  leads: ['crm.leads', 'crm.lead_activities', 'crm.qualification_coverage'],
  conversations: ['crm.conversations', 'crm.conversation_messages', 'crm.deferred_sends'],
  meetings: ['crm.meetings', 'crm.meeting_evidence'],
  followUps: ['crm.follow_up_sequences', 'crm.follow_up_sends'],
  requirements: ['crm.requirement_versions'],
  quotations: ['sales.proposals', 'sales.opportunities', 'sales.proposal_plan_sets'],
  clients: ['core.client_accounts', 'core.client_notes'],
  projects: ['projects.projects', 'projects.milestones', 'projects.change_requests'],
  tasks: ['projects.tasks', 'projects.modules', 'projects.features'],
  deliverables: ['projects.deliverables', 'projects.phase_three'],
  approvals: ['approvals.approval_requests'],
  finance: ['finance.invoices', 'finance.payments', 'finance.payment_submissions', 'finance.refunds'],
  jobs: ['core.jobs', 'core.outbox_events'],
  agents: ['ai.agent_runs', 'ai.agents', 'ai.cost_ledger'],
  qa: ['qa.defects', 'qa.test_runs', 'qa.test_plans'],
  audit: ['audit.audit_log'],
  team: ['core.memberships'],
  // SCR-067/068: the incident banner hears an alert raised or acknowledged and a switch thrown.
  alerts: ['core.alerts', 'core.kill_switches'],
} as const;

export type Topic = keyof typeof TOPICS;

export const ALL_TOPICS = Object.keys(TOPICS) as Topic[];

/** Every `schema.table` any topic names, once each, sorted — the publication's contents. */
export function allPublishedTables(): string[] {
  const set = new Set<string>();
  for (const tables of Object.values(TOPICS)) for (const t of tables) set.add(t);
  return [...set].sort();
}

/** The tables a set of topics subscribes to, deduplicated so one table is joined once per channel. */
export function tablesFor(topics: readonly Topic[]): TableRef[] {
  const seen = new Set<string>();
  const out: TableRef[] = [];
  for (const topic of topics) {
    for (const qualified of TOPICS[topic] ?? []) {
      if (seen.has(qualified)) continue;
      seen.add(qualified);
      const dot = qualified.indexOf('.');
      out.push({ schema: qualified.slice(0, dot), table: qualified.slice(dot + 1) });
    }
  }
  return out;
}

/** A stable channel name for a topic set, so two components on one page share the join. */
export function channelNameFor(topics: readonly Topic[]): string {
  return `live:${[...new Set(topics)].sort().join('+')}`;
}
