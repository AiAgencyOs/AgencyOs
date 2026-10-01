import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { addBrandRuleSchema, removeBrandRuleSchema, type AddBrandRuleInput, type RemoveBrandRuleInput } from './brand-kit-schema';

/** The brand rule doors. `project.write` here; `add_brand_rule` / `remove_brand_rule` re-check `can_manage_delivery()` and audit. */
function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

export async function addBrandRule(input: AddBrandRuleInput): Promise<Result<{ ruleId: string }>> {
  const parsed = addBrandRuleSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid rule.');
  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to change the brand kit.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('add_brand_rule', { p_project_id: parsed.data.projectId, p_title: parsed.data.title, p_rule: parsed.data.rule });
  if (error) {
    log('addBrandRule', error.message);
    return err('INTERNAL', 'Could not add the rule.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; rule_id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'added':
      return row.rule_id ? ok({ ruleId: row.rule_id }) : err('INTERNAL', 'Could not add the rule.');
    case 'empty':
      return err('VALIDATION', 'Name the rule and write it.');
    case 'too_long':
      return err('VALIDATION', 'A rule title is at most 120 characters and a rule 2000.');
    case 'not_found':
      return err('NOT_FOUND', 'Project not found.');
    default:
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may change the brand kit.');
  }
}

export async function removeBrandRule(input: RemoveBrandRuleInput): Promise<Result<{ removed: true }>> {
  const parsed = removeBrandRuleSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid rule.');
  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to change the brand kit.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('remove_brand_rule', { p_rule_id: parsed.data.ruleId });
  if (error) {
    log('removeBrandRule', error.message);
    return err('INTERNAL', 'Could not remove the rule.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'removed':
      return ok({ removed: true });
    case 'not_found':
      return err('NOT_FOUND', 'Rule not found.');
    default:
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may change the brand kit.');
  }
}
