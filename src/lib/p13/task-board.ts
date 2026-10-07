/**
 * P1-BLUEPRINT-022 (A16 Workflow Task Board): the nine board states the blueprint names, derived from the two durable queues that exist: `core.jobs`
 * (the runner) and `ai.handoffs` (agent to agent). The BACKEND state stays authoritative; this only names it, and a result being received is never
 * "closed" unless the source row says completed / succeeded (result received is not acceptance).
 *
 *   created      a handoff accepted but not yet running
 *   ready        queued and due
 *   in_progress  running
 *   waiting      waiting on input or an approval, or queued for a time that has not come
 *   blocked      refused by the receiver, or the job is parked after a permanent failure that a person must clear
 *   retrying     failed with retries left (attempts < max)
 *   failed       failed with none left (dead letter, failed_permanent)
 *   escalated    an open escalation names the job
 *   closed       completed, succeeded or cancelled
 */
export const BOARD_STATES = ['created', 'ready', 'in_progress', 'waiting', 'blocked', 'retrying', 'failed', 'escalated', 'closed'] as const;
export type BoardState = (typeof BOARD_STATES)[number];

export type BoardJob = { id: string; kind: string; status: string; priority: number; run_at: string; attempts: number; max_attempts: number; created_at: string; last_error: string | null };
export type BoardHandoff = { id: string; from_agent: string; to_agent: string; status: string; objective: string; created_at: string; sla_at: string | null };

export type BoardItem = {
  source: 'job' | 'handoff';
  id: string;
  label: string;
  agent: string | null;
  state: BoardState;
  stateReason: string;
  priority: number | null;
  createdAt: string;
  ageHours: number;
  stale: boolean;
  detail: string | null;
};

const HOURS = 3_600_000;

export function jobState(job: BoardJob, now: Date, escalatedJobIds: ReadonlySet<string>): { state: BoardState; reason: string } {
  const open = !['succeeded', 'cancelled'].includes(job.status);
  if (open && escalatedJobIds.has(job.id)) return { state: 'escalated', reason: 'an open escalation names this job' };
  switch (job.status) {
    case 'running':
      return { state: 'in_progress', reason: 'a worker holds it' };
    case 'queued':
      if (job.attempts > 0) return { state: 'retrying', reason: `attempt ${job.attempts + 1} of ${job.max_attempts}` };
      return new Date(job.run_at).getTime() > now.getTime() ? { state: 'waiting', reason: 'scheduled for later' } : { state: 'ready', reason: 'queued and due' };
    case 'failed':
      return job.attempts < job.max_attempts ? { state: 'retrying', reason: `failed, ${job.max_attempts - job.attempts} attempt(s) left` } : { state: 'failed', reason: 'out of attempts' };
    case 'dead':
      return { state: 'failed', reason: 'dead-lettered' };
    case 'succeeded':
      return { state: 'closed', reason: 'succeeded' };
    case 'cancelled':
      return { state: 'closed', reason: 'cancelled' };
    default:
      return { state: 'blocked', reason: `unrecognised status "${job.status}"` };
  }
}

export function handoffState(h: BoardHandoff): { state: BoardState; reason: string } {
  switch (h.status) {
    case 'queued':
      return { state: 'ready', reason: 'queued for the receiver' };
    case 'accepted':
      return { state: 'created', reason: 'accepted, not yet running' };
    case 'running':
      return { state: 'in_progress', reason: 'the receiver is working' };
    case 'needs_input':
      return { state: 'waiting', reason: 'waiting for input' };
    case 'awaiting_approval':
      return { state: 'waiting', reason: 'waiting for a human approval' };
    case 'rejected':
      return { state: 'blocked', reason: 'refused by the receiver' };
    case 'failed_retryable':
      return { state: 'retrying', reason: 'failed, may be retried' };
    case 'failed_permanent':
      return { state: 'failed', reason: 'failed for good' };
    case 'completed':
      return { state: 'closed', reason: 'completed and verified' };
    case 'cancelled':
      return { state: 'closed', reason: 'cancelled' };
    default:
      return { state: 'blocked', reason: `unrecognised status "${h.status}"` };
  }
}

/** A task is stale when it has been open (not closed, not failed for good) for longer than `staleAfterHours`. */
export function buildBoard(input: { jobs: readonly BoardJob[]; handoffs: readonly BoardHandoff[]; escalatedJobIds: ReadonlySet<string>; now: Date; staleAfterHours?: number }): BoardItem[] {
  const stale = input.staleAfterHours ?? 24;
  const items: BoardItem[] = [];
  const mk = (base: Omit<BoardItem, 'ageHours' | 'stale'>): BoardItem => {
    const age = Math.max(0, (input.now.getTime() - new Date(base.createdAt).getTime()) / HOURS);
    return { ...base, ageHours: Math.floor(age), stale: base.state !== 'closed' && base.state !== 'failed' && age >= stale };
  };
  for (const j of input.jobs) {
    const s = jobState(j, input.now, input.escalatedJobIds);
    items.push(mk({ source: 'job', id: j.id, label: j.kind, agent: null, state: s.state, stateReason: s.reason, priority: j.priority, createdAt: j.created_at, detail: j.last_error }));
  }
  for (const h of input.handoffs) {
    const s = handoffState(h);
    items.push(mk({ source: 'handoff', id: h.id, label: h.objective, agent: `${h.from_agent} to ${h.to_agent}`, state: s.state, stateReason: s.reason, priority: null, createdAt: h.created_at, detail: null }));
  }
  return items.sort((a, b) => b.ageHours - a.ageHours);
}

export function queueSummary(items: readonly BoardItem[]): Record<BoardState, number> & { stale: number } {
  const out = Object.fromEntries(BOARD_STATES.map((s) => [s, 0])) as Record<BoardState, number>;
  let stale = 0;
  for (const i of items) {
    out[i.state] += 1;
    if (i.stale) stale += 1;
  }
  return { ...out, stale };
}
