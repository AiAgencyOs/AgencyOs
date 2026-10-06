import { AGENT_DEFINITIONS, definitionFor, mayHandOff, registryRevision } from '@/modules/agents/registry';

/**
 * Phase 8 post-launch routing: the Orchestrator's decision for a maintenance work item, as PURE functions.
 *
 * The Orchestrator ROUTES. It approves nothing, verifies nothing, releases nothing and changes no scope; it picks the specialist that can take the work
 * NOW, says why every other one was not chosen, and names who must independently check it (a builder is never its own QA). "Held" is an honest
 * outcome: every development specialist is installed disabled, so today a routable item is HELD with the reason stated rather than handed to an
 * agent that cannot run.
 *
 * PRIORITY is a class derived from facts (emergency, defect severity, kind, sensitivity), not a promise. SLA HOURS are never invented here: they come
 * from an Admin-set policy (`projects.maintenance_sla_policies`); with none, the SLA is reported as UNKNOWN and nothing is called "breached".
 */

export type MaintenancePriority = 'p0' | 'p1' | 'p2' | 'p3';
export type MaintenanceKind = 'hotfix' | 'patch' | 'enhancement';
export type MaintenanceArea = 'frontend' | 'backend' | 'database' | 'mobile' | 'integration' | 'devops' | 'dependency';

export type SlaPolicy = { version: number; responseHours: number; resolutionHours: number; atRiskPercent: number | null };
export type SlaState =
  | { state: 'unknown'; reason: string }
  | { state: 'ok' | 'at_risk' | 'breached'; policyVersion: number; resolutionDueAt: string; hoursRemaining: number };

export type MaintenanceItemFacts = {
  id: string;
  kind: MaintenanceKind;
  area: MaintenanceArea;
  status: string;
  emergency: boolean;
  sensitive: boolean;
  commitRef: string | null;
  hasDefect: boolean;
  /** S0..S4 of the linked defect, when there is one. */
  defectSLevel: number | null;
  raisedAt: string;
};

export type RouteCandidate = { agent: string; eligible: boolean; rejected: string | null };

export type MaintenanceRoute = {
  outcome: 'routed' | 'held' | 'refused' | 'escalated';
  code: string;
  priority: MaintenancePriority;
  toAgent: string | null;
  reason: string;
  candidates: RouteCandidate[];
  sla: SlaState;
  requiresSecurityReview: boolean;
  /** Who may independently check the work. Never the agent that builds it. */
  independentQa: string[];
  policyVersion: string;
  decisionKey: string;
};

const AREA_AGENT: Record<MaintenanceArea, string> = {
  frontend: 'frontend_developer',
  backend: 'backend_developer',
  database: 'database_developer',
  mobile: 'mobile_developer',
  integration: 'integration',
  devops: 'devops_build',
  dependency: 'backend_developer',
};

/** A class, not a commitment. An emergency is an Admin-authorized hotfix; a severe or sensitive hotfix is next; a patch or other hotfix next; an enhancement last. */
export function classifyMaintenancePriority(i: Pick<MaintenanceItemFacts, 'kind' | 'emergency' | 'sensitive' | 'defectSLevel'>): MaintenancePriority {
  if (i.emergency) return 'p0';
  if (i.kind === 'hotfix' && ((i.defectSLevel !== null && i.defectSLevel <= 1) || i.sensitive)) return 'p1';
  if (i.kind === 'hotfix' || i.kind === 'patch') return 'p2';
  return 'p3';
}

export function slaStateFor(input: { priority: MaintenancePriority; raisedAt: string; now: Date; policy: SlaPolicy | undefined }): SlaState {
  const { policy } = input;
  if (!policy) return { state: 'unknown', reason: 'no SLA policy is set for this priority: nothing is called late' };
  const raised = Date.parse(input.raisedAt);
  if (Number.isNaN(raised)) return { state: 'unknown', reason: 'the work item has no usable raised time' };
  const dueMs = raised + policy.resolutionHours * 3_600_000;
  const remaining = (dueMs - input.now.getTime()) / 3_600_000;
  const elapsedPercent = ((input.now.getTime() - raised) / (policy.resolutionHours * 3_600_000)) * 100;
  const state = remaining <= 0 ? 'breached' : policy.atRiskPercent !== null && elapsedPercent >= policy.atRiskPercent ? 'at_risk' : 'ok';
  return { state, policyVersion: policy.version, resolutionDueAt: new Date(dueMs).toISOString(), hoursRemaining: Math.round(remaining * 100) / 100 };
}

/** Which gates, by name, leave the work not yet routable: its authorization is not (or no longer) valid. */
const AUTHORIZATION_GATES = new Set(['bound_record', 'scope_authorized']);

export function decideMaintenanceRoute(input: {
  item: MaintenanceItemFacts;
  /** `ai.agents.enabled` by key. */
  enabled: ReadonlyMap<string, boolean>;
  /** Names of the gates that do not pass now (from projects.evaluate_maintenance_gates). */
  failingGates: readonly string[];
  policies: ReadonlyMap<MaintenancePriority, SlaPolicy>;
  now: Date;
}): MaintenanceRoute {
  const { item } = input;
  const priority = classifyMaintenancePriority(item);
  const sla = slaStateFor({ priority, raisedAt: item.raisedAt, now: input.now, policy: input.policies.get(priority) });
  const wanted = item.hasDefect && item.kind !== 'enhancement' ? 'bug_fix' : AREA_AGENT[item.area];
  const candidates: RouteCandidate[] = AGENT_DEFINITIONS.filter((d) => d.layer === 'development').map((d) => {
    if (d.key !== wanted) return { agent: d.key, eligible: false, rejected: 'a different specialist carries this work' };
    if (!mayHandOff('orchestrator', d.key)) return { agent: d.key, eligible: false, rejected: 'no declared route from the Orchestrator' };
    if (input.enabled.get(d.key) !== true) return { agent: d.key, eligible: false, rejected: 'installed but not enabled' };
    return { agent: d.key, eligible: true, rejected: null };
  });
  const requiresSecurityReview = item.sensitive;
  // the builder is never the checker; QA is the independent verifier and the Orchestrator never judges completion
  const independentQa = ['quality_assurance', 'regression_test', ...(requiresSecurityReview ? ['security_review', 'security_test'] : [])].filter((a) => a !== wanted);
  const base = {
    priority, sla, candidates, requiresSecurityReview, independentQa,
    policyVersion: `registry-${registryRevision()}`,
    decisionKey: `${item.id}:${item.status}:${item.commitRef ?? 'nocommit'}:${priority}`,
  };

  if (item.status === 'released' || item.status === 'cancelled') {
    return { ...base, outcome: 'refused', code: 'closed', toAgent: null, reason: `the work item is ${item.status}: nothing is routed` };
  }
  const def = definitionFor(wanted);
  if (!def || def.layer !== 'development') return { ...base, outcome: 'refused', code: 'no_capability', toAgent: null, reason: `${wanted} is not a development specialist` };
  if (!mayHandOff('orchestrator', wanted)) return { ...base, outcome: 'refused', code: 'no_route', toAgent: null, reason: `the Orchestrator has no declared route to ${wanted}` };

  const open = input.failingGates.filter((g) => AUTHORIZATION_GATES.has(g));
  // work whose authorization is not valid goes back to the commercial decision; it is not started
  if (open.length > 0) {
    const reason = `the authorization for this work is not valid yet (${open.join(', ')}): it returns to the change request or the ticket's owner before any engineering starts`;
    return escalateIfLate({ ...base, outcome: 'held', code: 'authorization_open', toAgent: wanted, reason });
  }
  if (input.enabled.get(wanted) !== true) {
    return escalateIfLate({ ...base, outcome: 'held', code: 'agent_disabled', toAgent: wanted, reason: `${wanted} is installed but not enabled; the work waits rather than pretending to run` });
  }
  return { ...base, outcome: 'routed', code: 'routed', toAgent: wanted, reason: `${wanted} carries ${item.kind} work in the ${item.area} area${item.hasDefect ? ' tied to a defect' : ''}` };
}

/** A held item that is past its SLA, or an emergency that is held at all, goes to a person with the reason: it is never left waiting silently. */
function escalateIfLate(route: MaintenanceRoute): MaintenanceRoute {
  if (route.sla.state === 'breached' || route.priority === 'p0') {
    return { ...route, outcome: 'escalated', code: `${route.code}_escalated`, reason: `${route.reason}. Escalated to an Admin: ${route.priority === 'p0' ? 'an emergency cannot wait on this' : 'the SLA is breached'}` };
  }
  return route;
}

const ORDER: Record<MaintenancePriority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };
const SLA_ORDER: Record<string, number> = { breached: 0, at_risk: 1, ok: 2, unknown: 3 };

/** The working queue: priority first, then the SLA state, then the one due soonest, then the oldest. Deterministic. */
export function rankMaintenanceQueue<T extends { id: string; priority: MaintenancePriority; sla: SlaState; raisedAt: string }>(items: readonly T[]): T[] {
  const due = (s: SlaState) => (s.state === 'unknown' ? Number.POSITIVE_INFINITY : Date.parse(s.resolutionDueAt));
  return [...items].sort(
    (a, b) =>
      ORDER[a.priority] - ORDER[b.priority] ||
      (SLA_ORDER[a.sla.state] ?? 9) - (SLA_ORDER[b.sla.state] ?? 9) ||
      due(a.sla) - due(b.sla) ||
      Date.parse(a.raisedAt) - Date.parse(b.raisedAt) ||
      a.id.localeCompare(b.id),
  );
}
