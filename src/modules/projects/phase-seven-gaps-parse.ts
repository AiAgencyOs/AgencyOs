/** Pure parsing of the Phase 7 derived reads: no I/O. */

type Row = Record<string, unknown>;
export const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export type ExceptionState = { state: 'handover_blocked' | 'client_action_required' | 'disputed'; reason: string; source: string };
export type LinkedFutureWork = { kind: string; refId: string; summary: string; route: string | null; source: string };
export type FollowUpTask = { kind: string; taskId: string; dueOn: string };
export type HealthSnapshot = { id: string; status: string; source: string; recordedAt: string; ageMinutes: number; monitoringSourceConfigured: false };
export type PhaseSevenGapsView = { exceptionStates: ExceptionState[]; futureWork: LinkedFutureWork[]; followUps: FollowUpTask[]; health: HealthSnapshot | null };

const STATES = new Set(['handover_blocked', 'client_action_required', 'disputed']);

export function parseExceptionStates(data: unknown): ExceptionState[] {
  return rows(data).filter((r) => STATES.has(String(r.state))).map((r) => ({ state: r.state as ExceptionState['state'], reason: String(r.reason ?? ''), source: String(r.source ?? '') }));
}
export function parseFutureWork(data: unknown): LinkedFutureWork[] {
  return rows(data).map((r) => ({ kind: String(r.kind), refId: String(r.ref_id), summary: String(r.summary ?? ''), route: str(r.route), source: String(r.source ?? '') }));
}
export function parseHealth(data: unknown): HealthSnapshot | null {
  const r = rows(data)[0];
  if (!r) return null;
  return { id: String(r.snapshot_id), status: String(r.status), source: String(r.source), recordedAt: String(r.recorded_at), ageMinutes: Number(r.age_minutes ?? 0), monitoringSourceConfigured: false };
}

