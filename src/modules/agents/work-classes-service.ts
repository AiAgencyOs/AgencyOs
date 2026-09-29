import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { setAgentWorkClassesSchema, type SetAgentWorkClassesInput } from './work-classes-schema';

/**
 * SCR-063 — the owner sets which work classes an agent may be handed.
 * Owner only twice: here (`hasRole(context, 'owner')` — the union, so a
 * secondary owner counts — plus `organization.settings`) and inside
 * `ai.set_agent_work_classes`, SECURITY DEFINER because `ai.agents` is not
 * tenant-writable. Audited as agent.work_classes_set.
 */
export async function setAgentWorkClasses(input: SetAgentWorkClassesInput): Promise<Result<{ workClasses: string[] }>> {
  const parsed = setAgentWorkClassesSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid work classes.');

  const context = await requireInternal();
  if (!hasRole(context, 'owner') || !can(context, 'organization.settings')) {
    return err('FORBIDDEN', 'Only the owner may change which work an agent may be given.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').rpc('set_agent_work_classes', {
    p_agent_key: parsed.data.agentKey,
    p_work_classes: parsed.data.workClasses,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setAgentWorkClasses', detail: error.message }));
    return err('INTERNAL', 'Could not change the agent’s work classes.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ workClasses: parsed.data.workClasses });
    case 'unchanged':
      return err('CONFLICT', 'Those are already the agent’s work classes.');
    case 'not_found':
      return err('NOT_FOUND', 'Agent not found in the registry.');
    case 'bad_work_class':
      return err('VALIDATION', 'A work class outside ADM-61’s eight.');
    default:
      return err('FORBIDDEN', 'Only the owner may change which work an agent may be given.');
  }
}
