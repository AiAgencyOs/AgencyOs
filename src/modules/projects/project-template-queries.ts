import 'server-only';

import { ilikeAny } from '@/lib/db/search';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { milestonePercentTotal, templateItemsSchema, type TemplateItems } from './project-template-schema';

/**
 * Project templates — readers. Decision: reversed by the owner on
 * 2026-09-29. The list for Settings and the create-project picker, and one
 * template with its parsed items. A `template_items` blob that does not
 * parse is reported as such rather than silently emptied: the row is
 * listed with `valid: false` so the settings screen can show and delete it.
 */

export type ProjectTemplateSummary = {
  id: string;
  name: string;
  description: string | null;
  sourceProjectId: string | null;
  createdByName: string | null;
  createdAt: string;
  counts: { modules: number; features: number; milestones: number; scopeItems: number; onboarding: number; tasks: number };
  /** The milestone percentages' total; a plan is written only when this is 100. */
  milestonePercent: number;
  valid: boolean;
};

export type ProjectTemplateDetail = ProjectTemplateSummary & { items: TemplateItems };

function summarize(items: TemplateItems) {
  return {
    modules: items.modules.length,
    features: items.modules.reduce((n, m) => n + m.features.length, 0),
    milestones: items.milestones.length,
    scopeItems: items.scopeItems.length,
    onboarding: items.onboarding.length,
    tasks: items.tasks.length,
  };
}

const EMPTY = templateItemsSchema.parse({});

export async function listProjectTemplates(q?: string): Promise<ProjectTemplateSummary[]> {
  const supabase = await createClient();
  let query = supabase
    .schema('projects')
    .from('project_templates')
    .select('id, name, description, source_project_id, template_items, created_by, created_at')
    .order('created_at', { ascending: false });
  // Search within domain (bucket G-3): name or description, server-side.
  if (q) query = query.or(ilikeAny(['name', 'description'], q));
  const { data, error } = await query;
  if (error) unreadable('listProjectTemplates', error);

  const rows = data ?? [];
  const userIds = [...new Set(rows.map((r) => r.created_by).filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users, error: usersError } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', userIds);
    if (usersError) unreadable('listProjectTemplates.users', usersError);
    for (const u of users ?? []) names.set(u.id, u.full_name ?? u.email ?? 'Unknown');
  }

  return rows.map((r) => {
    const parsed = templateItemsSchema.safeParse(r.template_items);
    const items = parsed.success ? parsed.data : EMPTY;
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      sourceProjectId: r.source_project_id,
      createdByName: r.created_by ? (names.get(r.created_by) ?? null) : null,
      createdAt: r.created_at,
      counts: summarize(items),
      milestonePercent: milestonePercentTotal(items),
      valid: parsed.success,
    };
  });
}

export async function getProjectTemplate(templateId: string): Promise<ProjectTemplateDetail | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('project_templates')
    .select('id, name, description, source_project_id, template_items, created_by, created_at')
    .eq('id', templateId)
    .maybeSingle();
  if (error) unreadable('getProjectTemplate', error);
  if (!data) return null;

  const parsed = templateItemsSchema.safeParse(data.template_items);
  const items = parsed.success ? parsed.data : EMPTY;
  return {
    id: data.id,
    name: data.name,
    description: data.description,
    sourceProjectId: data.source_project_id,
    createdByName: null,
    createdAt: data.created_at,
    counts: summarize(items),
    milestonePercent: milestonePercentTotal(items),
    valid: parsed.success,
    items,
  };
}
