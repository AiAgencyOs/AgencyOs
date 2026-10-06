'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createAdminClient } from '@/lib/db/admin';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';
import { decideMaintenanceRoute, type MaintenanceArea, type MaintenanceKind, type MaintenancePriority, type SlaPolicy } from '@/modules/orchestrator/maintenance-route';

import { JOB_KIND, outcomeWords } from './maintenance-engineering';

/**
 * Admin actions for post-launch maintenance work (Phase 8 part B). Each one calls a database DOOR as the signed-in person and reports the door's answer
 * as written: the person's own identity is what the doors check (creator != approver, QA != author, Admin-only release and billing decisions). Nothing here
 * deploys, merges, writes to GitHub, sends a message to a client, creates an invoice, or verifies a payment. Agents are asked through a door that records
 * who asked, and only then is a job queued for the agent the DOOR named.
 */

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const firstRow = (data: unknown): Record<string, unknown> | null => ((Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null) ?? null;
const nothing = (v: string): string | null => (v === '' ? null : v);

async function gate(): Promise<{ organizationId: string; userId: string } | FormState> {
  const context = await requireInternal();
  if (!can(context, 'project.write') || !context.organizationId) return { status: 'error', message: 'You do not have permission to change this project.' };
  return { organizationId: context.organizationId, userId: context.userId };
}

type Rpc = { schema(name: string): { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> } };

/** Call one door as the person and turn its answer into form state. `good` outcomes are success; anything else is shown in words. */
async function callDoor(schema: 'projects' | 'finance', fn: string, args: Record<string, unknown>, good: readonly string[], success: string, projectId: string): Promise<FormState> {
  const supabase = (await createClient()) as unknown as Rpc;
  const { data, error } = await supabase.schema(schema).rpc(fn, args);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was changed.' };
  const row = firstRow(data);
  const outcome = String(row?.outcome ?? 'no answer');
  if (!good.includes(outcome)) {
    const open = row?.open_gates ? ` (open: ${String(row.open_gates).replace(/_/g, ' ')})` : '';
    return { status: 'error', message: `${outcomeWords(outcome)}${open}` };
  }
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: success };
}

const pid = (formData: FormData): string | null => {
  const projectId = text(formData, 'projectId');
  return UUID.test(projectId) ? projectId : null;
};
const bad: FormState = { status: 'error', message: 'That record was not found.' };

export async function openMaintenanceWorkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const g = await gate();
  if ('status' in g) return g;
  const projectId = pid(formData);
  const [authKind, authId = ''] = text(formData, 'authorization').split(':');
  if (!projectId || !UUID.test(authId) || !['ticketId', 'defectId', 'changeRequestId'].includes(authKind ?? '')) return { status: 'error', message: 'Choose the ticket, defect or approved change request this work answers to. Nothing is done as free scope.' };
  return callDoor('projects', 'open_maintenance_work', {
    p_project_id: projectId, p_kind: text(formData, 'kind'), p_area: text(formData, 'area'), p_title: text(formData, 'title'), p_description: nothing(text(formData, 'description')),
    p_ticket_id: authKind === 'ticketId' ? authId : null, p_defect_id: authKind === 'defectId' ? authId : null, p_change_request_id: authKind === 'changeRequestId' ? authId : null,
    p_emergency: formData.get('emergency') === 'on', p_sensitive: formData.get('sensitive') === 'on',
  }, ['opened', 'already_open'], 'Work opened. It is tied to what authorizes it, and it needs an exact commit, independent QA and its own Admin approval before it is released.', projectId);
}

export async function submitMaintenanceFixAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const g = await gate();
  if ('status' in g) return g;
  const projectId = pid(formData);
  const id = text(formData, 'workItemId');
  if (!projectId || !UUID.test(id)) return bad;
  return callDoor('projects', 'submit_maintenance_fix', { p_work_item_id: id, p_commit_ref: text(formData, 'commit').toLowerCase(), p_summary: text(formData, 'summary'), p_rollback_plan: text(formData, 'rollbackPlan'), p_rollback_owner: text(formData, 'rollbackOwner') },
    ['submitted'], 'Commit submitted. Earlier QA results no longer count: the change goes to independent QA again.', projectId);
}

export async function recordMaintenanceQaAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const g = await gate();
  if ('status' in g) return g;
  const projectId = pid(formData);
  const id = text(formData, 'workItemId');
  if (!projectId || !UUID.test(id)) return bad;
  return callDoor('projects', 'record_maintenance_qa_result', { p_work_item_id: id, p_category: text(formData, 'category'), p_status: text(formData, 'status'), p_commit_ref: text(formData, 'commit').toLowerCase(), p_evidence_ref: nothing(text(formData, 'evidence')), p_reason: nothing(text(formData, 'reason')), p_severity: text(formData, 'severity') || 'major' },
    ['recorded'], 'QA result recorded on that exact commit.', projectId);
}

export async function requestMaintenanceReleaseAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const g = await gate();
  if ('status' in g) return g;
  const projectId = pid(formData);
  const id = text(formData, 'workItemId');
  if (!projectId || !UUID.test(id)) return bad;
  return callDoor('projects', 'request_maintenance_release', { p_work_item_id: id }, ['requested', 'already_requested'], 'Release approval requested. An Admin who did not build or request it decides.', projectId);
}

export async function decideMaintenanceReleaseAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const g = await gate();
  if ('status' in g) return g;
  const projectId = pid(formData);
  const id = text(formData, 'workItemId');
  const decision = text(formData, 'decision');
  if (!projectId || !UUID.test(id) || (decision !== 'approve' && decision !== 'reject')) return bad;
  return callDoor('projects', 'decide_maintenance_release', { p_work_item_id: id, p_decision: decision, p_note: nothing(text(formData, 'note')) }, ['approved', 'rejected'],
    decision === 'approve' ? 'Approved for release on that exact commit. AgencyOS deploys nothing: the release itself is recorded below once it has happened.' : 'Returned to the developer.', projectId);
}

export async function recordMaintenanceReleaseAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const g = await gate();
  if ('status' in g) return g;
  const projectId = pid(formData);
  const id = text(formData, 'workItemId');
  if (!projectId || !UUID.test(id)) return bad;
  return callDoor('projects', 'record_maintenance_release', { p_work_item_id: id, p_deployment_ref: text(formData, 'deploymentRef'), p_smoke_evidence_ref: text(formData, 'smokeEvidence') }, ['released'], 'Release recorded under your name, with the deployment reference and smoke evidence you gave.', projectId);
}

export async function cancelMaintenanceWorkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const g = await gate();
  if ('status' in g) return g;
  const projectId = pid(formData);
  const id = text(formData, 'workItemId');
  if (!projectId || !UUID.test(id)) return bad;
  return callDoor('projects', 'cancel_maintenance_work', { p_work_item_id: id, p_reason: text(formData, 'reason') }, ['cancelled'], 'Work cancelled.', projectId);
}

export async function setMaintenanceSlaPolicyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const g = await gate();
  if ('status' in g) return g;
  const projectId = pid(formData);
  if (!projectId) return bad;
  const atRisk = text(formData, 'atRiskPercent');
  return callDoor('projects', 'set_maintenance_sla_policy', { p_priority: text(formData, 'priority'), p_response_hours: Number(text(formData, 'responseHours')), p_resolution_hours: Number(text(formData, 'resolutionHours')), p_at_risk_percent: atRisk === '' ? null : Number(atRisk) },
    ['set'], 'SLA policy saved as a new version. Earlier versions stay on the record.', projectId);
}

/** Ask the Bug Fix or Regression agent: the DOOR records who asked and names the agent; only then is a job queued. */
export async function askMaintenanceAgentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const g = await gate();
  if ('status' in g) return g;
  const projectId = pid(formData);
  const id = text(formData, 'workItemId');
  const agent = text(formData, 'agent');
  if (!projectId || !UUID.test(id) || (agent !== 'bug_fix' && agent !== 'regression_test')) return bad;
  const supabase = (await createClient()) as unknown as Rpc;
  const { data, error } = await supabase.schema('projects').rpc('request_maintenance_agent_run', { p_work_item_id: id, p_agent_key: agent });
  if (error) return { status: 'error', message: 'The database did not answer; nothing was requested.' };
  const row = firstRow(data);
  const outcome = String(row?.outcome ?? 'no answer');
  if (outcome !== 'requested') return { status: 'error', message: outcomeWords(outcome) };
  const requestId = String(row?.request_id ?? '');
  if (!UUID.test(requestId)) return { status: 'error', message: 'The database returned no request; nothing was queued.' };
  const { error: insertError } = await createAdminClient().schema('core').from('jobs').insert({ organization_id: g.organizationId, kind: agent === 'bug_fix' ? JOB_KIND.bug_fix : JOB_KIND.regression_test, payload: { requestId, projectId }, dedupe_key: `${JOB_KIND[agent]}:${requestId}` });
  if (insertError && insertError.code !== '23505') return { status: 'error', message: 'The request was recorded but could not be queued.' };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: 'Asked. The agent only proposes; a different person accepts or rejects what it proposes.' };
}

export async function decideMaintenanceProposalAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const g = await gate();
  if ('status' in g) return g;
  const projectId = pid(formData);
  const id = text(formData, 'proposalId');
  const decision = text(formData, 'decision');
  if (!projectId || !UUID.test(id) || (decision !== 'accepted' && decision !== 'rejected')) return bad;
  return callDoor('projects', 'decide_maintenance_agent_proposal', { p_proposal_id: id, p_decision: decision, p_note: nothing(text(formData, 'note')) }, ['accepted', 'rejected'], decision === 'accepted' ? 'Accepted as a plan. It recorded no result and changed no state.' : 'Rejected. That is final.', projectId);
}

/**
 * Record the Orchestrator's routing decision for one item. The decision is pure TypeScript over stored facts; the record is written through the
 * service-only door with the JOB-side organization (this person's), after the person has been checked. It routes; it approves and releases nothing.
 */
export async function routeMaintenanceWorkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const g = await gate();
  if ('status' in g) return g;
  const projectId = pid(formData);
  const id = text(formData, 'workItemId');
  if (!projectId || !UUID.test(id)) return bad;
  const supabase = await createClient();
  const rpc = supabase as unknown as Rpc;
  const item = await (supabase.schema('projects') as unknown as { from(t: string): { select(c: string): { eq(c: string, v: string): { eq(c: string, v: string): { maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: { message: string } | null }> } } } } })
    .from('maintenance_work_items').select('id, kind, area, status, emergency, sensitive, commit_ref, defect_id, created_at').eq('id', id).eq('project_id', projectId).maybeSingle();
  if (item.error || !item.data) return { status: 'error', message: 'The work item could not be read; nothing was routed.' };
  const gates = await rpc.schema('projects').rpc('evaluate_maintenance_gates', { p_work_item_id: id });
  if (gates.error) return { status: 'error', message: 'The gates could not be read; nothing was routed.' };
  const failing = (Array.isArray(gates.data) ? (gates.data as { gate: string; passed: boolean }[]) : []).filter((x) => !x.passed).map((x) => x.gate);

  const admin = createAdminClient() as unknown as { schema(n: string): { from(t: string): { select(c: string): { eq(c: string, v: unknown): PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }> & { in(c: string, v: unknown[]): PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }> } } } } };
  const agents = await admin.schema('ai').from('agents').select('key, enabled').eq('enabled', true);
  if (agents.error) return { status: 'error', message: 'The agent list could not be read; nothing was routed.' };
  const pol = await admin.schema('projects').from('maintenance_sla_policies').select('priority, version, response_hours, resolution_hours, at_risk_percent').eq('organization_id', g.organizationId);
  if (pol.error) return { status: 'error', message: 'The SLA policies could not be read; nothing was routed.' };
  const policies = new Map<MaintenancePriority, SlaPolicy>();
  for (const p of [...(pol.data ?? [])].sort((a, b) => Number(b.version) - Number(a.version))) {
    const k = String(p.priority) as MaintenancePriority;
    if (!policies.has(k)) policies.set(k, { version: Number(p.version), responseHours: Number(p.response_hours), resolutionHours: Number(p.resolution_hours), atRiskPercent: p.at_risk_percent === null ? null : Number(p.at_risk_percent) });
  }
  let sLevel: number | null = null;
  const defectId = typeof item.data.defect_id === 'string' ? item.data.defect_id : null;
  if (defectId) {
    const d = await admin.schema('qa').from('defects').select('id, s_level').eq('id', defectId);
    if (d.error) return { status: 'error', message: 'The defect could not be read; nothing was routed.' };
    sLevel = d.data?.[0]?.s_level === undefined || d.data?.[0]?.s_level === null ? null : Number(d.data?.[0]?.s_level);
  }
  const route = decideMaintenanceRoute({
    item: { id, kind: String(item.data.kind) as MaintenanceKind, area: String(item.data.area) as MaintenanceArea, status: String(item.data.status), emergency: item.data.emergency === true, sensitive: item.data.sensitive === true, commitRef: typeof item.data.commit_ref === 'string' ? item.data.commit_ref : null, hasDefect: defectId !== null, defectSLevel: sLevel, raisedAt: String(item.data.created_at) },
    enabled: new Map((agents.data ?? []).map((a) => [String(a.key), true] as const)), failingGates: failing, policies, now: new Date(),
  });
  const { data, error } = await (admin as unknown as Rpc).schema('projects').rpc('record_maintenance_routing', {
    p_organization_id: g.organizationId, p_work_item_id: id, p_decision_key: route.decisionKey, p_outcome: route.outcome, p_priority: route.priority, p_to_agent: route.toAgent, p_reason: route.reason,
    p_candidates: route.candidates, p_sla: route.sla, p_requires_security_review: route.requiresSecurityReview, p_independent_qa: route.independentQa, p_policy_version: route.policyVersion, p_correlation_id: null, p_decided_by: g.userId,
  });
  if (error) return { status: 'error', message: 'The decision could not be recorded.' };
  const outcome = String(firstRow(data)?.outcome ?? 'no answer');
  if (outcome !== 'recorded' && outcome !== 'already_recorded') return { status: 'error', message: outcomeWords(outcome) };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: `Routing recorded: ${route.outcome} (${route.priority}). ${route.reason}` };
}

// ── Finance: proposals only; the existing doors decide ──

export async function askFinanceAgentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const g = await gate();
  if ('status' in g) return g;
  const projectId = pid(formData);
  const [kind, subjectId = ''] = text(formData, 'subject').split(':');
  if (!projectId || !UUID.test(subjectId) || !['maintenance_invoice', 'change_request_invoice', 'payment_reminder'].includes(kind ?? '')) return { status: 'error', message: 'Choose what to prepare a proposal for.' };
  const supabase = (await createClient()) as unknown as Rpc;
  const { data, error } = await supabase.schema('finance').rpc('request_maintenance_billing', { p_kind: kind, p_plan_id: kind === 'maintenance_invoice' ? subjectId : null, p_change_request_id: kind === 'change_request_invoice' ? subjectId : null, p_invoice_id: kind === 'payment_reminder' ? subjectId : null });
  if (error) return { status: 'error', message: 'The database did not answer; nothing was requested.' };
  const row = firstRow(data);
  const outcome = String(row?.outcome ?? 'no answer');
  if (outcome !== 'requested') return { status: 'error', message: outcomeWords(outcome) };
  const requestId = String(row?.request_id ?? '');
  if (!UUID.test(requestId)) return { status: 'error', message: 'The database returned no request; nothing was queued.' };
  const { error: insertError } = await createAdminClient().schema('core').from('jobs').insert({ organization_id: g.organizationId, kind: JOB_KIND.finance, payload: { requestId, projectId }, dedupe_key: `${JOB_KIND.finance}:${requestId}` });
  if (insertError && insertError.code !== '23505') return { status: 'error', message: 'The request was recorded but could not be queued.' };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: 'Asked. The agent prepares a draft; it creates no invoice, sends nothing and verifies no payment.' };
}

export async function decideBillingProposalAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const g = await gate();
  if ('status' in g) return g;
  const projectId = pid(formData);
  const id = text(formData, 'proposalId');
  const decision = text(formData, 'decision');
  const invoiceId = text(formData, 'invoiceId');
  if (!projectId || !UUID.test(id) || (decision !== 'accepted' && decision !== 'rejected') || (invoiceId !== '' && !UUID.test(invoiceId))) return bad;
  return callDoor('finance', 'decide_maintenance_billing_proposal', { p_proposal_id: id, p_decision: decision, p_note: nothing(text(formData, 'note')), p_invoice_id: nothing(invoiceId) }, ['accepted', 'rejected'],
    decision === 'accepted' ? 'Accepted. Make the invoice through the invoice composer or the change request door; nothing was created here.' : 'Rejected.', projectId);
}

export async function linkMaintenanceInvoiceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const g = await gate();
  if ('status' in g) return g;
  const projectId = pid(formData);
  const planId = text(formData, 'planId');
  const invoiceId = text(formData, 'invoiceId');
  if (!projectId || !UUID.test(planId) || !UUID.test(invoiceId)) return bad;
  return callDoor('finance', 'link_maintenance_invoice', { p_plan_id: planId, p_invoice_id: invoiceId, p_purpose: text(formData, 'purpose'), p_cycle_start: text(formData, 'cycleStart'), p_cycle_end: text(formData, 'cycleEnd') }, ['linked', 'already_linked'],
    'Invoice linked to the plan cycle. The plan will not activate until that invoice is paid on verified money, or the owner approves an exception.', projectId);
}
