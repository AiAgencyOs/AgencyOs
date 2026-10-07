import type { createAdminClient } from '@/lib/db/admin';
import type { HandlerResult } from '@/modules/crm/handlers';

/**
 * P1-COORD-020 / P1-ORCH-014: a task past its deadline, or one whose receiving agent was switched off (or is no longer a declared target of the sender), is
 * escalated to a person by `ai.p1r_sweep_handoff_escalations`. A runner door: it refuses a signed-in caller. The sweep never changes the work, only raises the
 * escalation with its cause and recommendation. No maximum wait is passed (the owner decides it), so nothing is ever marked expired from here.
 * A failed read is a retryable failure, never "nothing to escalate".
 */
type Admin = ReturnType<typeof createAdminClient>;
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

const row = (v: unknown): Record<string, unknown> => (Array.isArray(v) ? ((v[0] as Record<string, unknown>) ?? {}) : ((v as Record<string, unknown>) ?? {}));
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

export async function sweepHandoffEscalations(admin: Admin, organizationId: string): Promise<HandlerResult> {
  const { data, error } = await (admin.schema('ai' as never) as unknown as { rpc: Rpc }).rpc('p1r_sweep_handoff_escalations', { p_organization_id: organizationId });
  if (error) return { status: 'failed', permanent: false, detail: `could not sweep handoff escalations: ${error.message}` };
  const r = row(data);
  const timedOut = n(r.timed_out);
  const conflicts = n(r.permission_conflicts);
  return {
    status: 'succeeded',
    outcome: timedOut + conflicts > 0 ? 'escalated' : 'nothing_to_escalate',
    detail: `${timedOut} task(s) escalated for timeout, ${conflicts} for a permission conflict`,
  };
}
