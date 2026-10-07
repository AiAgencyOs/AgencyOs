'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

import { phaseEightCWords } from './phase-eight-c-words';

/**
 * Actions for the maintenance plan lifecycle and the post-launch sweeps' acknowledgements (Phase 8 part C). Each calls ONE database door as the signed-in
 * person and shows the door's answer as written: the person's own identity is what the doors check (creator != approver, Admin-only decisions). Nothing here
 * creates an invoice, quotes a price, verifies a payment, sends anything to a client, or records a client's decision without a reference to evidence.
 */

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nothing = (v: string): string | null => (v === '' ? null : v);
const firstRow = (data: unknown): Record<string, unknown> | null => ((Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null) ?? null;
const num = (v: string): number | null => (v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const uuid = (formData: FormData, key: string): string | null => {
  const v = text(formData, key);
  return UUID.test(v) ? v : null;
};

type Rpc = { schema(name: string): { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> } };
const bad: FormState = { status: 'error', message: 'That record was not found.' };

async function door(fn: string, args: Record<string, unknown>, good: readonly string[], success: string, projectId: string): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'project.write') || !context.organizationId) return { status: 'error', message: 'You do not have permission to change this project.' };
  const supabase = (await createClient()) as unknown as Rpc;
  const { data, error } = await supabase.schema('projects').rpc(fn, args);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was changed.' };
  const outcome = String(firstRow(data)?.outcome ?? 'no answer');
  if (!good.includes(outcome)) return { status: 'error', message: phaseEightCWords(outcome) };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: success };
}

const project = (f: FormData) => uuid(f, 'projectId');

export async function createCatalogVersionAction(_p: FormState, f: FormData): Promise<FormState> {
  const projectId = project(f);
  if (!projectId) return bad;
  return door('create_maintenance_catalog_version', { p_name: text(f, 'name'), p_billing_model: text(f, 'billingModel'), p_included_hours: num(text(f, 'includedHours')), p_included_requests: num(text(f, 'includedRequests')),
    p_coverage: nothing(text(f, 'coverage')), p_excluded_work: nothing(text(f, 'excludedWork')), p_renewal_terms: nothing(text(f, 'renewalTerms')) }, ['created'], 'Version drafted. Another Admin publishes it.', projectId);
}
export async function addPriceLineAction(_p: FormState, f: FormData): Promise<FormState> {
  const projectId = project(f);
  const catalogId = uuid(f, 'catalogId');
  const amount = num(text(f, 'amountMinor'));
  if (!projectId || !catalogId || amount === null) return bad;
  return door('add_maintenance_price_line', { p_catalog_id: catalogId, p_label: text(f, 'label'), p_per: text(f, 'per'), p_amount_minor: amount, p_currency: text(f, 'currency') }, ['entered'], 'Price line entered as data. Nothing is billed from it.', projectId);
}
export async function publishCatalogVersionAction(_p: FormState, f: FormData): Promise<FormState> {
  const projectId = project(f);
  const catalogId = uuid(f, 'catalogId');
  if (!projectId || !catalogId) return bad;
  const retire = text(f, 'decision') === 'retire';
  return door(retire ? 'retire_maintenance_catalog_version' : 'publish_maintenance_catalog_version', { p_catalog_id: catalogId }, [retire ? 'retired' : 'published'], retire ? 'Version retired.' : 'Version published. It can no longer be edited.', projectId);
}
export async function openMaintenancePlanAction(_p: FormState, f: FormData): Promise<FormState> {
  const projectId = project(f);
  const catalogId = uuid(f, 'catalogId');
  if (!projectId || !catalogId) return bad;
  return door('open_maintenance_plan', { p_project_id: projectId, p_catalog_id: catalogId }, ['opened'], 'Plan opened as a draft. Record the client\'s decision next.', projectId);
}
export async function recordPlanAcceptanceAction(_p: FormState, f: FormData): Promise<FormState> {
  const projectId = project(f);
  const planId = uuid(f, 'planId');
  if (!projectId || !planId) return bad;
  return door('record_maintenance_plan_acceptance', { p_plan_id: planId, p_decision: text(f, 'decision'), p_proposal_id: uuid(f, 'proposalId'), p_channel: text(f, 'channel'), p_evidence_ref: text(f, 'evidenceRef'),
    p_client_contact: text(f, 'clientContact'), p_reason: nothing(text(f, 'reason')) }, ['accepted', 'declined'], 'The client\'s decision is recorded with its evidence reference.', projectId);
}
export async function activatePlanAction(_p: FormState, f: FormData): Promise<FormState> {
  const projectId = project(f);
  const planId = uuid(f, 'planId');
  if (!projectId || !planId) return bad;
  const reinstate = text(f, 'decision') === 'reinstate';
  return door(reinstate ? 'reinstate_maintenance_plan' : 'activate_maintenance_plan', { p_plan_id: planId }, [reinstate ? 'reinstated' : 'activated'], reinstate ? 'Plan reinstated.' : 'Plan activated on its paid first cycle.', projectId);
}
export async function recordUsageAction(_p: FormState, f: FormData): Promise<FormState> {
  const projectId = project(f);
  const planId = uuid(f, 'planId');
  const quantity = num(text(f, 'quantity'));
  if (!projectId || !planId || quantity === null) return bad;
  const [kind, id = ''] = text(f, 'against').split(':');
  return door('record_maintenance_usage', { p_plan_id: planId, p_kind: text(f, 'kind'), p_quantity: quantity, p_occurred_on: text(f, 'occurredOn'),
    p_work_item_id: kind === 'work' && UUID.test(id) ? id : null, p_ticket_id: kind === 'ticket' && UUID.test(id) ? id : null, p_note: nothing(text(f, 'note')) }, ['recorded'], 'Usage recorded.', projectId);
}
export async function reverseUsageAction(_p: FormState, f: FormData): Promise<FormState> {
  const projectId = project(f);
  const entryId = uuid(f, 'entryId');
  if (!projectId || !entryId) return bad;
  return door('reverse_maintenance_usage', { p_entry_id: entryId, p_reason: text(f, 'reason') }, ['reversed'], 'Entry reversed. The original stays on the record.', projectId);
}
export async function draftOverageAction(_p: FormState, f: FormData): Promise<FormState> {
  const projectId = project(f);
  const cycleId = uuid(f, 'cycleId');
  if (!projectId || !cycleId) return bad;
  return door('draft_maintenance_overage', { p_cycle_id: cycleId, p_kind: text(f, 'kind') }, ['drafted'], 'Overage drafted for a person to quote. Nothing is billed or sent.', projectId);
}
export async function proposeRenewalAction(_p: FormState, f: FormData): Promise<FormState> {
  const projectId = project(f);
  const planId = uuid(f, 'planId');
  const proposalId = uuid(f, 'proposalId');
  if (!projectId || !planId || !proposalId) return bad;
  return door('propose_maintenance_renewal', { p_plan_id: planId, p_new_ends_on: text(f, 'newEndsOn'), p_price_proposal_id: proposalId }, ['proposed'], 'Renewal proposed. Nothing is extended until the client accepts, it is paid and another Admin confirms.', projectId);
}
export async function recordRenewalDecisionAction(_p: FormState, f: FormData): Promise<FormState> {
  const projectId = project(f);
  const renewalId = uuid(f, 'renewalId');
  if (!projectId || !renewalId) return bad;
  return door('record_maintenance_renewal_decision', { p_renewal_id: renewalId, p_decision: text(f, 'decision'), p_channel: text(f, 'channel'), p_evidence_ref: text(f, 'evidenceRef'),
    p_client_contact: text(f, 'clientContact'), p_reason: nothing(text(f, 'reason')) }, ['accepted', 'declined', 'withdrawn'], 'The client\'s renewal decision is recorded with its evidence reference.', projectId);
}
export async function confirmRenewalAction(_p: FormState, f: FormData): Promise<FormState> {
  const projectId = project(f);
  const renewalId = uuid(f, 'renewalId');
  if (!projectId || !renewalId) return bad;
  return door('confirm_maintenance_renewal', { p_renewal_id: renewalId }, ['renewed'], 'Renewed for the paid cycle.', projectId);
}
export async function requestCancellationAction(_p: FormState, f: FormData): Promise<FormState> {
  const projectId = project(f);
  const planId = uuid(f, 'planId');
  if (!projectId || !planId) return bad;
  return door('request_maintenance_plan_cancellation', { p_plan_id: planId, p_reason_code: text(f, 'reasonCode'), p_reason: text(f, 'reason'), p_evidence_ref: nothing(text(f, 'evidenceRef')) }, ['requested'], 'Cancellation requested. Another Admin confirms it. No refund is decided here.', projectId);
}
export async function decideCancellationAction(_p: FormState, f: FormData): Promise<FormState> {
  const projectId = project(f);
  const id = uuid(f, 'cancellationId');
  if (!projectId || !id) return bad;
  return door('decide_maintenance_plan_cancellation', { p_cancellation_id: id, p_decision: text(f, 'decision') }, ['confirmed', 'withdrawn'], 'Recorded. If confirmed, the entitlement ended today.', projectId);
}
export async function recordDataSafetyAction(_p: FormState, f: FormData): Promise<FormState> {
  const projectId = project(f);
  const workItemId = uuid(f, 'workItemId');
  if (!projectId || !workItemId) return bad;
  return door('record_maintenance_data_safety', { p_work_item_id: workItemId, p_commit_ref: text(f, 'commitRef'), p_rollback_plan: text(f, 'rollbackPlan'), p_backup_evidence_ref: text(f, 'backupEvidenceRef'),
    p_destructive: f.get('destructive') === 'on' }, ['recorded'], 'Data-safety record saved for this exact commit.', projectId);
}
export async function acknowledgeSlaBreachAction(_p: FormState, f: FormData): Promise<FormState> {
  const projectId = project(f);
  const breachId = uuid(f, 'breachId');
  if (!projectId || !breachId) return bad;
  return door('acknowledge_maintenance_sla_breach', { p_breach_id: breachId, p_note: text(f, 'note') }, ['acknowledged'], 'Acknowledged.', projectId);
}
export async function setStallPolicyAction(_p: FormState, f: FormData): Promise<FormState> {
  const projectId = project(f);
  const hours = num(text(f, 'hours'));
  if (!projectId || hours === null) return bad;
  return door('set_maintenance_stall_policy', { p_stalled_after_hours: hours }, ['set'], 'Stall threshold set (versioned).', projectId);
}
