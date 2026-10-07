import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import { looseSchema } from '@/lib/p13/loose-client';

import type { PmLanguage } from './pm-messages';
import { pmTemplateProblem, renderPmTemplate, type PmTemplateKey } from './pm-template-model';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * P2-PM-006 — what a PM sender says: the wording an Admin APPROVED for this organization, template and language, else the wording in code (`fallback`,
 * which every caller computes with the function it has always called). The read is the service-role door `projects.p1s_pm_template_approved`; only an
 * approved row is ever returned.
 *
 * Fails toward the wording in code, and says so in the log: a template that cannot be read, no longer passes the rules, or lacks a value for one of its
 * placeholders must not stop a payment confirmation reaching a client, and the code wording is the baseline the owner has always approved. The send is
 * never made with a half-filled or unvalidated override.
 */
export async function resolvePmText(
  admin: Admin,
  input: { organizationId: string; key: PmTemplateKey; language: PmLanguage; vars: Readonly<Record<string, string>>; fallback: string },
): Promise<string> {
  const { data, error } = await looseSchema(admin as never, 'projects').rpc('p1s_pm_template_approved', {
    p_organization_id: input.organizationId,
    p_key: input.key,
    p_language: input.language,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'resolvePmText', template: input.key, detail: error.message }));
    return input.fallback;
  }
  const row = (Array.isArray(data) ? data[0] : data) as { body?: unknown } | null | undefined;
  if (!row || typeof row.body !== 'string') return input.fallback;
  if (pmTemplateProblem(input.key, input.language, row.body) !== null) {
    console.error(JSON.stringify({ level: 'error', scope: 'resolvePmText', template: input.key, detail: 'the approved template no longer passes the rules; the code wording is used' }));
    return input.fallback;
  }
  return renderPmTemplate(row.body, input.vars) ?? input.fallback;
}
