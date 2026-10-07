'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

import { DOCUMENT_WORDS, DOOR_OUTCOMES, WORDS } from './review-words';

/**
 * The human doors on what the agents and the test/integration doors produce: link a regression test and verify it on the fix build, make a task depend
 * on an integration (and release it), accept or reject a test case draft, promote or reject a documentation draft.
 *
 * The page gates by capability and the DATABASE decides again (can_write, can_manage_delivery, is_admin). A draft is a proposal: accepting a test case
 * draft records a decision and creates nothing; promoting a documentation draft goes through the same evidence rules as any document.
 */

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();

async function gate(capability: 'project.write' | 'project.sign_off'): Promise<FormState | null> {
  const context = await requireInternal();
  if (!can(context, capability) || !context.organizationId) return { status: 'error', message: 'You do not have permission to do this.' };
  return null;
}

async function door(
  capability: 'project.write' | 'project.sign_off',
  projectId: string,
  schema: 'qa' | 'projects',
  rpc: keyof typeof DOOR_OUTCOMES,
  args: Record<string, unknown>,
  words: Record<string, string> = {},
): Promise<FormState> {
  const refused = await gate(capability);
  if (refused) return refused;
  const supabase = await createClient();
  const { data, error } = await supabase.schema(schema).rpc(rpc as never, args as never);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | null;
  const outcome = String(row?.outcome ?? 'no answer');
  const say = (o: string) => words[o] ?? WORDS[o] ?? `Refused: ${o.replace(/_/g, ' ')}.`;
  if (!(DOOR_OUTCOMES[rpc].ok as readonly string[]).includes(outcome)) return { status: 'error', message: say(outcome) };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: say(outcome) };
}

/** Link a defect to the automated test that keeps it fixed. */
export async function linkRegressionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return door('project.write', text(formData, 'projectId'), 'qa', 'link_regression_test', {
    p_defect_id: text(formData, 'defectId'),
    p_test_case_name: text(formData, 'testCaseName'),
    p_defective_deliverable_id: text(formData, 'defectiveBuildId') || null,
  });
}

/** Verify a link: the named test must have PASSED in a run of the fix build. The database checks that, not this form. */
export async function verifyRegressionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return door('project.write', text(formData, 'projectId'), 'qa', 'verify_regression_link', {
    p_link_id: text(formData, 'linkId'),
    p_fix_deliverable_id: text(formData, 'fixBuildId'),
    p_test_run_id: text(formData, 'testRunId'),
  });
}

/** A task cannot work without an integration: while that integration is degraded or blocked, this task (and only the tasks that depend on it) is held. */
export async function dependOnIntegrationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return door('project.write', text(formData, 'projectId'), 'projects', 'depend_task_on_integration', {
    p_task_id: text(formData, 'taskId'),
    p_connection_id: text(formData, 'connectionId'),
  });
}

/** Remove a dependency; what it was holding is released. */
export async function releaseIntegrationDependencyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return door('project.write', text(formData, 'projectId'), 'projects', 'release_task_integration_dependency', {
    p_task_id: text(formData, 'taskId'),
    p_connection_id: text(formData, 'connectionId'),
  });
}

/** Accept or reject a test case draft. Accepting records the decision; it never creates a test, a run or a result. */
export async function reviewTestCaseDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return door('project.write', text(formData, 'projectId'), 'projects', 'review_test_case_draft', {
    p_draft_id: text(formData, 'draftId'),
    p_decision: text(formData, 'decision'),
    p_note: text(formData, 'note') || null,
  });
}

/** Promote or reject a documentation draft. Admin only; an implemented document must name its evidence. */
export async function reviewDocumentationDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return door(
    'project.sign_off',
    text(formData, 'projectId'),
    'projects',
    'review_documentation_draft',
    {
      p_document_id: text(formData, 'documentId'),
      p_decision: text(formData, 'decision'),
      p_status: text(formData, 'status') || null,
      p_evidence_ref: text(formData, 'evidenceRef') || null,
    },
    DOCUMENT_WORDS,
  );
}
