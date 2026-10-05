import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The engines' door into the governance layer (20261016100000). An engine that is about to cause an external side
 * effect asks `decideAction`; for anything governed it binds an approval to the exact content (`bindApproval`), and the
 * worker that finally acts goes through `beginExecution` - which re-reads the pause state and the approval at that
 * moment - then reports `finishExecution` and, once it has confirmed the result at the provider, `verifyExecution`.
 *
 * Every function here is a thin typed call; the rules live in the database where they cannot be bypassed.
 */

import { ACTION_TYPES, NEVER_AUTO_ACTIONS } from './policy-vocabulary';

export { ACTION_TYPES };
export type ActionType = (typeof ACTION_TYPES)[number];

/** The five actions the specification makes mandatory: no setting, screen or service can make them automatic. */
export const NEVER_AUTO: readonly ActionType[] = NEVER_AUTO_ACTIONS;

export const POLICY_MODES = ['auto', 'approval', 'block'] as const;

export type Decision = 'AUTO_APPROVE' | 'ADMIN_APPROVAL_REQUIRED' | 'BLOCK' | 'ESCALATE';
export type ArtifactType = 'social_content' | 'b2b_proposal' | 'ad_campaign' | 'acquisition_action';

const row = <T>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;

export async function decideAction(
  admin: Admin,
  input: { organizationId: string; action: ActionType; channel?: 'meta_ads' | 'google_ads'; amountMinor?: number; requestedCount?: number; correlationId?: string },
): Promise<{ decision: Decision; reason: string; requiredRole: string | null; policyVersion: string | null }> {
  const { data, error } = await admin.schema('crm').rpc('acquisition_decide', {
    p_organization_id: input.organizationId,
    p_action: input.action,
    p_channel: input.channel as never,
    p_amount_minor: input.amountMinor ?? 0,
    p_requested_count: input.requestedCount ?? 1,
    p_correlation_id: input.correlationId as never,
  });
  if (error) throw new Error(`decideAction failed: ${error.message}`);
  const r = row<{ decision?: string; reason?: string; required_role?: string | null; policy_version?: string | null }>(data);
  // A missing answer is a refusal, never a permission.
  return { decision: (r?.decision ?? 'BLOCK') as Decision, reason: r?.reason ?? 'no_answer', requiredRole: r?.required_role ?? null, policyVersion: r?.policy_version ?? null };
}

export type BindOutcome = 'requested' | 'already_pending' | 'content_changed' | 'invalid' | 'no_policy' | 'forbidden';

export async function bindApproval(
  admin: Admin,
  input: { organizationId: string; artifactType: ArtifactType; artifactId: string; version: number; contentHash: string; summary: string; amountMinor?: number; validHours?: number; correlationId?: string },
): Promise<{ outcome: BindOutcome; requestId: string | null }> {
  const { data, error } = await admin.schema('crm').rpc('bind_approval', {
    p_organization_id: input.organizationId,
    p_artifact_type: input.artifactType,
    p_artifact_id: input.artifactId,
    p_version: input.version,
    p_content_hash: input.contentHash,
    p_summary: input.summary,
    p_amount_minor: input.amountMinor as never,
    p_requested_by_type: 'system',
    p_requested_by_id: undefined as never,
    p_valid_hours: input.validHours,
    p_correlation_id: input.correlationId as never,
  });
  if (error) throw new Error(`bindApproval failed: ${error.message}`);
  const r = row<{ outcome?: string; request_id?: string | null }>(data);
  return { outcome: (r?.outcome ?? 'invalid') as BindOutcome, requestId: r?.request_id ?? null };
}

export async function checkApproval(
  admin: Admin,
  input: { requestId: string; artifactType: ArtifactType; artifactId: string; contentHash: string },
): Promise<{ covered: boolean; reason: string }> {
  const { data, error } = await admin.schema('crm').rpc('approval_check', {
    p_request: input.requestId, p_artifact_type: input.artifactType, p_artifact_id: input.artifactId, p_content_hash: input.contentHash,
  });
  if (error) throw new Error(`checkApproval failed: ${error.message}`);
  const r = row<{ covered?: boolean; reason?: string }>(data);
  return { covered: r?.covered === true, reason: r?.reason ?? 'no_answer' };
}

export type BeginOutcome = 'proceed' | 'blocked' | 'not_covered' | 'already_executed' | 'in_progress' | 'needs_reconciliation' | 'exhausted';

/**
 * The ONE door a governed side effect passes through. Only `proceed` permits acting; everything else says why not and the
 * caller must not act. Never cache the answer: it is the state at this instant.
 */
export async function beginExecution(
  admin: Admin,
  input: { organizationId: string; requestId: string; artifactType: ArtifactType; artifactId: string; contentHash: string; action: ActionType; channel?: 'meta_ads' | 'google_ads' | 'email' | 'social' | 'b2b'; correlationId?: string },
): Promise<{ outcome: BeginOutcome; reason: string; executionId: string | null }> {
  const { data, error } = await admin.schema('crm').rpc('begin_governed_execution', {
    p_organization_id: input.organizationId, p_request: input.requestId, p_artifact_type: input.artifactType, p_artifact_id: input.artifactId,
    p_content_hash: input.contentHash, p_action: input.action, p_channel: input.channel as never, p_correlation_id: input.correlationId as never,
  });
  if (error) throw new Error(`beginExecution failed: ${error.message}`);
  const r = row<{ outcome?: string; reason?: string; execution_id?: string | null }>(data);
  // Anything unrecognised is NOT proceed.
  return { outcome: (r?.outcome ?? 'blocked') as BeginOutcome, reason: r?.reason ?? 'no_answer', executionId: r?.execution_id ?? null };
}

export async function finishExecution(
  admin: Admin,
  input: { organizationId: string; executionId: string; status: 'executed' | 'failed' | 'unknown'; externalRef?: string; evidence?: Record<string, unknown> },
): Promise<string> {
  const { data, error } = await admin.schema('crm').rpc('finish_governed_execution', {
    p_organization_id: input.organizationId, p_execution: input.executionId, p_status: input.status,
    p_external_ref: input.externalRef as never, p_evidence: (input.evidence ?? {}) as never,
  });
  if (error) throw new Error(`finishExecution failed: ${error.message}`);
  return row<{ outcome?: string }>(data)?.outcome ?? 'invalid';
}

export async function verifyExecution(admin: Admin, input: { organizationId: string; executionId: string; evidence?: Record<string, unknown> }): Promise<string> {
  const { data, error } = await admin.schema('crm').rpc('verify_governed_execution', {
    p_organization_id: input.organizationId, p_execution: input.executionId, p_evidence: (input.evidence ?? {}) as never,
  });
  if (error) throw new Error(`verifyExecution failed: ${error.message}`);
  return row<{ outcome?: string }>(data)?.outcome ?? 'invalid';
}

export async function recordUsage(
  admin: Admin,
  input: { organizationId: string; channel: 'meta_ads' | 'email' | 'social' | 'google_ads' | 'b2b'; metric: 'action' | 'spend_minor' | 'connect'; amount: number; ref?: string; correlationId?: string },
): Promise<'recorded' | 'duplicate' | 'invalid'> {
  const { data, error } = await admin.schema('crm').rpc('record_acquisition_usage', {
    p_organization_id: input.organizationId, p_channel: input.channel, p_metric: input.metric, p_amount: input.amount,
    p_ref: input.ref as never, p_correlation_id: input.correlationId as never,
  });
  if (error) throw new Error(`recordUsage failed: ${error.message}`);
  return (row<{ outcome?: string }>(data)?.outcome ?? 'invalid') as 'recorded';
}
