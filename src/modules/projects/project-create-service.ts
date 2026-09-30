import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { createProjectManuallySchema, type CreateProjectManuallyInput } from './project-create-schema';

/**
 * Raises a project by hand — SCR-004.
 *
 * Gated on `project.write`, the same capability `createProject` (the
 * conversion door in service.ts) and every other project write already
 * use; RLS on `projects.projects` decides again underneath. The client
 * account is checked to be readable first so a typo'd or foreign id is a
 * sentence rather than a foreign-key error, and so a row can never be
 * raised against an account the caller cannot see.
 *
 * Starts in `planning`, exactly as a converted project does: onboarding is
 * an explicit move a person makes once kickoff actually begins.
 */
export async function createProjectManually(
  input: CreateProjectManuallyInput,
): Promise<Result<{ projectId: string }>> {
  const parsed = createProjectManuallySchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid project.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to create projects.');
  }
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();

  const { data: account, error: accountError } = await supabase
    .schema('core')
    .from('client_accounts')
    .select('id, currency')
    .eq('id', parsed.data.clientAccountId)
    .maybeSingle();

  if (accountError) {
    console.error(JSON.stringify({ level: 'error', scope: 'createProjectManually', detail: accountError.message }));
    return err('INTERNAL', 'Could not read the client account.');
  }
  if (!account) return err('NOT_FOUND', 'Client account not found.');

  const { data, error } = await supabase
    .schema('projects')
    .from('projects')
    .insert({
      organization_id: context.organizationId,
      client_account_id: account.id,
      name: parsed.data.name,
      status: 'planning',
      currency: parsed.data.currency,
      budget_minor: parsed.data.budgetMinor ?? null,
      starts_on: parsed.data.startsOn ?? null,
      ends_on: parsed.data.endsOn ?? null,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error(JSON.stringify({ level: 'error', scope: 'createProjectManually', detail: error?.message }));
    return err('INTERNAL', 'Could not create the project.');
  }

  return ok({ projectId: data.id });
}
