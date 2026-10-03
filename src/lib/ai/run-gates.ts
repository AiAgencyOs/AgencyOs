import type { createAdminClient } from '@/lib/db/admin';

/**
 * The gates the runner asks BETWEEN steps — bucket F, stream F-F (SCR-065,
 * SCR-068, SCR-064).
 *
 * A job that has already been claimed is past the claim-time switches
 * (`core.claim_agent_job` refuses to hand out work for a paused
 * organisation). Three things can still change while it runs, and each is a
 * flag a person set that the runner must honour at its next step rather than
 * discover after the last one:
 *
 *   cancel   `core.cancel_running_job` stamped `cancel_requested_at` on the
 *            job — the runner stops, settles job and run as cancelled
 *            (`core.settle_cancelled_job`, audited) and reports it.
 *   pause    the owner engaged `agents_paused` — the runner stops, puts the
 *            job back in the queue for later, and closes the run as failed
 *            with the reason, since a run cannot be resumed mid-transcript.
 *   budget   the provider about to be called has reached its monthly cap
 *            (`ai.provider_budgets`) — refused BEFORE the call, recorded as
 *            a policy refusal of kind `provider_budget_exceeded`, raised as a
 *            critical alert, and the job parked: no retry changes a cap.
 *
 * Each is a throw, for the reason `AgentPolicyRefusal` is: the model-call
 * helpers are called from every workflow, and a workflow handed a result
 * would carry on. `runOneAgentJob` catches exactly these classes.
 *
 * Service role, so the tenant is a PARAMETER on every read and write.
 */

type Admin = ReturnType<typeof createAdminClient>;

export class JobCancelled extends Error {
  readonly jobId: string;
  readonly runId: string | null;
  readonly reason: string;
  constructor(args: { jobId: string; runId: string | null; reason: string }) {
    super(`cancelled while running: ${args.reason}`);
    this.name = 'JobCancelled';
    this.jobId = args.jobId;
    this.runId = args.runId;
    this.reason = args.reason;
  }
}

export class AgentsPaused extends Error {
  readonly jobId: string;
  readonly runId: string | null;
  constructor(args: { jobId: string; runId: string | null; reason: string }) {
    super(`agents are paused by the owner: ${args.reason}`);
    this.name = 'AgentsPaused';
    this.jobId = args.jobId;
    this.runId = args.runId;
  }
}

export class AgentBudgetRefusal extends Error {
  readonly agentKey: string;
  readonly provider: string;
  readonly runId: string | null;
  readonly capMinor: number;
  readonly spentMinor: number;
  constructor(args: { agentKey: string; provider: string; runId: string | null; capMinor: number; spentMinor: number; reason: string }) {
    super(args.reason);
    this.name = 'AgentBudgetRefusal';
    this.agentKey = args.agentKey;
    this.provider = args.provider;
    this.runId = args.runId;
    this.capMinor = args.capMinor;
    this.spentMinor = args.spentMinor;
  }
}

/** Pure: whether one more call may go to a provider that has spent `spentMinor` of `capMinor` this month. */
export function withinBudget(capMinor: number | null, spentMinor: number): boolean {
  if (capMinor === null) return true;
  return spentMinor < capMinor;
}

/**
 * The cancel flag and the pause switch, read together, once per step.
 * A read that fails is logged and treated as "no flag": a job must not die
 * because a gate was unreadable for a moment — the next step asks again.
 */
export async function checkRunGates(admin: Admin, args: { jobId: string; organizationId: string; runId: string | null }): Promise<void> {
  const [job, paused] = await Promise.all([
    admin.schema('core').from('jobs').select('cancel_requested_at, cancel_reason').eq('id', args.jobId).maybeSingle(),
    admin.schema('core').from('kill_switches').select('active, reason').eq('organization_id', args.organizationId).eq('switch', 'agents_paused').maybeSingle(),
  ]);

  if (job.error) {
    console.error(JSON.stringify({ level: 'warn', scope: 'checkRunGates', jobId: args.jobId, detail: job.error.message }));
  } else if (job.data?.cancel_requested_at) {
    throw new JobCancelled({ jobId: args.jobId, runId: args.runId, reason: job.data.cancel_reason ?? 'no reason recorded' });
  }

  if (paused.error) {
    console.error(JSON.stringify({ level: 'warn', scope: 'checkRunGates', jobId: args.jobId, detail: paused.error.message }));
  } else if (paused.data?.active) {
    throw new AgentsPaused({ jobId: args.jobId, runId: args.runId, reason: paused.data.reason ?? 'no reason recorded' });
  }
}

/**
 * The provider's monthly budget, asked BEFORE the call. A budget that cannot
 * be read fails CLOSED — an unreadable cap is not "no cap", exactly as an
 * unreadable policy is not "no policy" in `loadAgentPolicy`.
 */
export async function refuseIfOverBudget(
  admin: Admin,
  args: { organizationId: string; agentKey: string; provider: string; runId: string | null; model?: string | null },
): Promise<void> {
  // The model's own monthly cap, when the owner set one (SCR-064), is asked first.
  if (args.model) await refuseIfOverModelBudget(admin, { ...args, model: args.model });
  const budget = await admin
    .schema('ai')
    .from('provider_budgets')
    .select('monthly_cap_minor')
    .eq('organization_id', args.organizationId)
    .eq('provider', args.provider)
    .maybeSingle();
  if (budget.error) throw new Error(`provider budget could not be read: ${budget.error.message}`);
  if (!budget.data) return;

  const spent = await admin.schema('ai').rpc('provider_spend_this_month', {
    p_organization_id: args.organizationId,
    p_provider: args.provider,
  });
  if (spent.error) throw new Error(`provider spend could not be read: ${spent.error.message}`);

  const capMinor = Number(budget.data.monthly_cap_minor);
  const spentMinor = Number(spent.data ?? 0);
  if (withinBudget(capMinor, spentMinor)) return;

  const reason = `provider "${args.provider}" has reached its monthly budget: ₹${(spentMinor / 100).toFixed(2)} spent of ₹${(capMinor / 100).toFixed(2)}`;

  // Recorded like a policy refusal, then raised as an alert somebody must
  // acknowledge. Neither failing to record is fatal: the refusal has happened.
  const recorded = await admin.schema('ai').rpc('record_agent_policy_refusal', {
    p_organization_id: args.organizationId,
    p_agent_key: args.agentKey,
    p_kind: 'provider_budget_exceeded',
    p_reason: reason,
    ...(args.runId ? { p_run_id: args.runId } : {}),
  });
  if (recorded.error) {
    console.error(JSON.stringify({ level: 'error', scope: 'refuseIfOverBudget.record', detail: recorded.error.message }));
  }
  await raiseAlert(admin, {
    organizationId: args.organizationId,
    source: 'ai',
    severity: 'critical',
    summary: `AI provider ${args.provider} is over its monthly budget — agent runs on it are refused until the cap is raised or the month turns.`,
    fingerprint: `provider-budget:${args.provider}`,
  });

  throw new AgentBudgetRefusal({ agentKey: args.agentKey, provider: args.provider, runId: args.runId, capMinor, spentMinor, reason });
}

/**
 * A model's monthly budget (`ai.model_budgets`), with the same fail-closed
 * reading as the provider's: an unreadable cap is not "no cap".
 */
async function refuseIfOverModelBudget(
  admin: Admin,
  args: { organizationId: string; agentKey: string; provider: string; runId: string | null; model: string },
): Promise<void> {
  const budget = await admin.schema('ai').from('model_budgets').select('monthly_cap_minor').eq('organization_id', args.organizationId).eq('model_id', args.model).maybeSingle();
  if (budget.error) throw new Error(`model budget could not be read: ${budget.error.message}`);
  if (!budget.data) return;

  const spent = await admin.schema('ai').rpc('model_spend_this_month', { p_organization_id: args.organizationId, p_model_id: args.model });
  if (spent.error) throw new Error(`model spend could not be read: ${spent.error.message}`);

  const capMinor = Number(budget.data.monthly_cap_minor);
  const spentMinor = Number(spent.data ?? 0);
  if (withinBudget(capMinor, spentMinor)) return;

  const reason = `model "${args.model}" has reached its monthly budget: ₹${(spentMinor / 100).toFixed(2)} spent of ₹${(capMinor / 100).toFixed(2)}`;
  const recorded = await admin.schema('ai').rpc('record_agent_policy_refusal', {
    p_organization_id: args.organizationId,
    p_agent_key: args.agentKey,
    p_kind: 'model_budget_exceeded',
    p_reason: reason,
    ...(args.runId ? { p_run_id: args.runId } : {}),
  });
  if (recorded.error) {
    console.error(JSON.stringify({ level: 'error', scope: 'refuseIfOverModelBudget.record', detail: recorded.error.message }));
  }
  await raiseAlert(admin, {
    organizationId: args.organizationId,
    source: 'ai',
    severity: 'critical',
    summary: `AI model ${args.model} is over its monthly budget — agent runs on it are refused until the cap is raised or the month turns.`,
    fingerprint: `model-budget:${args.model}`,
  });

  throw new AgentBudgetRefusal({ agentKey: args.agentKey, provider: args.provider, runId: args.runId, capMinor, spentMinor, reason });
}

/** Raise (or bump) an alert for the organisation — SCR-067. Best effort, never fatal. */
export async function raiseAlert(
  admin: Admin,
  args: { organizationId: string; source: string; severity: 'info' | 'warning' | 'critical'; summary: string; fingerprint: string },
): Promise<void> {
  const { error } = await admin.schema('core').rpc('raise_alert', {
    p_organization_id: args.organizationId,
    p_source: args.source,
    p_severity: args.severity,
    p_summary: args.summary,
    p_fingerprint: args.fingerprint.slice(0, 200),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'raiseAlert', fingerprint: args.fingerprint, detail: error.message }));
  }
}
