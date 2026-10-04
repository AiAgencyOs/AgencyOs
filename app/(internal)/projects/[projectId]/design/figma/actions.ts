'use server';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createAdminClient } from '@/lib/db/admin';
import { createClient } from '@/lib/db/server';
import { clientEnv } from '@/lib/env';
import type { FormState } from '@/modules/identity/types';
import { FIGMA_CODE_TTL_SECONDS, signFigmaCode } from '@/modules/projects/figma-export-token';
import { figmaSigningKey } from '@/modules/projects/figma-route';

/**
 * Create the code the Admin pastes into the Figma plugin. A person with write access to the project only; the code names this
 * project and organization, expires in 24 hours and can only read the finalized screens and report what the plugin built. It is
 * shown once in the message and kept nowhere. Issuing one is audited.
 */
export async function createFigmaCodeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'project.write')) return { status: 'error', message: 'Only someone who can edit this project may create a plugin code.' };
  const projectId = String(formData.get('projectId') ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) return { status: 'error', message: 'That project was not recognised.' };
  const organizationId = context.organizationId;
  if (!organizationId) return { status: 'error', message: 'No organization is selected.' };
  const key = figmaSigningKey();
  if (!key) return { status: 'error', message: 'This deployment has no signing key (VAULT_ENCRYPTION_KEY), so a plugin code cannot be issued.' };

  const admin = createAdminClient();
  const project = await admin.schema('projects').from('projects').select('id, organization_id').eq('id', projectId).eq('organization_id', organizationId).maybeSingle();
  if (!project.data) return { status: 'error', message: 'That project was not found.' };

  const code = signFigmaCode({ organizationId, projectId }, key, Math.floor(Date.now() / 1000));
  // Issuing a code is audited under the person who asked. Only that it happened - never the code itself.
  await (await createClient()).schema('core').rpc('record_audit', { p_organization_id: organizationId, p_action: 'figma_plugin.code_created', p_subject_type: 'project', p_subject_id: projectId, p_after: { ttl_hours: FIGMA_CODE_TTL_SECONDS / 3600 } });
  const base = (clientEnv.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '');
  return {
    status: 'success',
    message: JSON.stringify({ code, projectId, address: base, hours: FIGMA_CODE_TTL_SECONDS / 3600 }),
  };
}
