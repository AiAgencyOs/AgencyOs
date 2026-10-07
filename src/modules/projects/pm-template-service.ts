import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { asRows, firstRow, looseSchema } from '@/lib/p13/loose-client';
import { err, ok, unreadable, type Result } from '@/lib/result';

import { pmTemplateProblem } from './pm-template-model';

/**
 * P2-PM-006 — the editor's side of the PM templates: read the versions, author a draft, submit it, and (Admin only) approve or reject. Every write is a
 * `projects.p1s_*` door; this file validates first so the form can say what is wrong, and reports what the database answered as written. `src/lib/db/types.ts`
 * is stale for these objects, so the calls go through the narrow loose view.
 */

export type PmTemplateVersion = {
  id: string;
  templateKey: string;
  language: string;
  version: number;
  status: 'draft' | 'pending_review' | 'approved' | 'rejected' | 'superseded';
  body: string;
  createdAt: string;
  submittedAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
};

export async function listPmTemplateVersions(): Promise<PmTemplateVersion[]> {
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'projects')
    .from('p1s_pm_template_versions')
    .select('id, template_key, language, version, status, body, created_at, submitted_at, decided_at, decision_note')
    .order('template_key')
    .order('language')
    .order('version', { ascending: false })
    .limit(500);
  if (error) unreadable('listPmTemplateVersions', error);
  return asRows(data).map((r) => ({
    id: String(r.id),
    templateKey: String(r.template_key),
    language: String(r.language),
    version: Number(r.version),
    status: String(r.status) as PmTemplateVersion['status'],
    body: String(r.body),
    createdAt: String(r.created_at),
    submittedAt: r.submitted_at ? String(r.submitted_at) : null,
    decidedAt: r.decided_at ? String(r.decided_at) : null,
    decisionNote: r.decision_note ? String(r.decision_note) : null,
  }));
}

const REFUSAL: Record<string, string> = {
  no_actor: 'You are not signed in.',
  not_authorized: 'You are not allowed to do that to a PM template.',
  under_review: 'This version is being reviewed. Withdraw it first, or wait for the decision.',
  not_found: 'That template version was not found.',
  not_a_draft: 'Only a draft can be changed this way.',
  not_pending: 'Only a version awaiting review can be decided or withdrawn.',
  reason_required: 'A rejection needs a reason.',
  invalid_decision: 'Choose approve or reject.',
};

function refusal(outcome: string): Result<never> {
  if (outcome.startsWith('invalid_body')) return err('VALIDATION', outcome.replace(/^invalid_body:\s*/, ''));
  const code = outcome === 'not_authorized' || outcome === 'no_actor' ? 'FORBIDDEN' : outcome === 'not_found' ? 'NOT_FOUND' : outcome === 'under_review' || outcome === 'not_pending' || outcome === 'not_a_draft' ? 'CONFLICT' : 'VALIDATION';
  return err(code, REFUSAL[outcome] ?? 'The database refused that.');
}

async function door(name: string, args: Record<string, unknown>): Promise<Result<Record<string, unknown> | string>> {
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'projects').rpc(name, args);
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: name, detail: error.message }));
    return err('INTERNAL', 'Could not complete that.');
  }
  if (typeof data === 'string') return ok(data);
  return ok(firstRow(data) ?? {});
}

export async function savePmTemplateDraft(input: { key: string; language: string; body: string }): Promise<Result<{ version: number }>> {
  const problem = pmTemplateProblem(input.key, input.language, input.body.trim());
  if (problem) return err('VALIDATION', problem);
  await requireInternal();
  const result = await door('p1s_save_pm_template_draft', { p_key: input.key, p_language: input.language, p_body: input.body.trim() });
  if (!result.ok) return result;
  const row = result.data as Record<string, unknown>;
  return row.outcome === 'saved' ? ok({ version: Number(row.version) || 0 }) : refusal(String(row.outcome ?? ''));
}

export async function submitPmTemplate(id: string): Promise<Result<null>> {
  await requireInternal();
  const result = await door('p1s_submit_pm_template', { p_id: id });
  if (!result.ok) return result;
  return result.data === 'submitted' ? ok(null) : refusal(String(result.data));
}

export async function withdrawPmTemplate(id: string): Promise<Result<null>> {
  await requireInternal();
  const result = await door('p1s_withdraw_pm_template', { p_id: id });
  if (!result.ok) return result;
  return result.data === 'withdrawn' ? ok(null) : refusal(String(result.data));
}

export async function discardPmTemplateDraft(id: string): Promise<Result<null>> {
  await requireInternal();
  const result = await door('p1s_discard_pm_template_draft', { p_id: id });
  if (!result.ok) return result;
  return result.data === 'discarded' ? ok(null) : refusal(String(result.data));
}

/** Admin only: approving makes the version the wording the PM sends; rejecting keeps it with the reason. */
export async function decidePmTemplate(id: string, decision: 'approve' | 'reject', note: string): Promise<Result<null>> {
  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return err('FORBIDDEN', 'Only an owner or ops admin can approve or reject a PM template.');
  const result = await door('p1s_decide_pm_template', { p_id: id, p_decision: decision, p_note: note.trim() || null });
  if (!result.ok) return result;
  const outcome = String((result.data as Record<string, unknown>).outcome ?? '');
  return outcome === 'approved' || outcome === 'rejected' ? ok(null) : refusal(outcome);
}
