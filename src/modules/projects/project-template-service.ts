import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { Json } from '@/lib/db/types';
import { err, ok, type Result } from '@/lib/result';

import { createProjectManually } from './project-create-service';
import {
  cloneProjectTemplateSchema,
  type CloneProjectTemplateInput,
  createProjectFromTemplateSchema,
  createProjectTemplateFromProjectSchema,
  deleteProjectTemplateSchema,
  milestonePercentTotal,
  templateItemsSchema,
  type CreateProjectFromTemplateInput,
  type CreateProjectTemplateFromProjectInput,
  type DeleteProjectTemplateInput,
  type TemplateItems,
} from './project-template-schema';
import { addScopeItem, configurePaymentPlan, createFeature, createModule, createTask, openScopeVersion } from './service';

/**
 * Project templates. Decision: reversed by the owner on 2026-09-29.
 *
 * `createProjectTemplateFromProject` reads a project's modules, features,
 * milestones (as percentages), the scope items of its latest baseline,
 * its onboarding checklist and its task titles — every read under the
 * caller's own RLS — and writes them as one jsonb snapshot. Gated on
 * `project.write`, the roles `project_templates_insert` names again.
 *
 * `createProjectFromTemplate` raises the project through the by-hand door
 * (`createProjectManually`, so every rule that door has applies) and then
 * writes the snapshot back through the SAME doors a person would use:
 * createModule / createFeature / createTask, configurePaymentPlan (the
 * plan RPC, which refuses a plan that is not exactly 100%), and
 * openScopeVersion + addScopeItem. Nothing here inserts into a table a
 * door already governs. Onboarding is the exception in the other
 * direction: `seed_onboarding` fills a new project from the organization's
 * baseline on start, and a template's checklist would fight it, so the
 * snapshot's onboarding items are recorded but NOT written — the result
 * says so. Partial failure is reported item by item rather than hidden:
 * the project exists, and the caller reads what did not land.
 *
 * `deleteProjectTemplate` is an administrative act (`organization.settings`,
 * and `project_templates_delete` RLS says `core.is_admin()` again).
 */

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

export async function createProjectTemplateFromProject(
  input: CreateProjectTemplateFromProjectInput,
): Promise<Result<{ templateId: string; counts: Record<string, number> }>> {
  const parsed = createProjectTemplateFromProjectSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid template.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to save a template.');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const projectId = parsed.data.projectId;

  const { data: project, error: projectError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .is('deleted_at', null)
    .maybeSingle();
  if (projectError) {
    log('createProjectTemplateFromProject.project', projectError.message);
    return err('INTERNAL', 'Could not read the project.');
  }
  if (!project) return err('NOT_FOUND', 'Project not found.');

  const [modulesRes, featuresRes, milestonesRes, versionsRes, onboardingRes, tasksRes] = await Promise.all([
    supabase.schema('projects').from('modules').select('id, name, description, position').eq('project_id', projectId).order('position').order('created_at'),
    supabase.schema('projects').from('features').select('id, module_id, name, description, position').eq('project_id', projectId).order('position').order('created_at'),
    supabase.schema('projects').from('milestones').select('name, description, payment_percent, position').eq('project_id', projectId).order('position'),
    supabase.schema('projects').from('scope_versions').select('id, version').eq('project_id', projectId).order('version', { ascending: false }).limit(1),
    supabase.schema('projects').from('onboarding_items').select('key, label, position').eq('project_id', projectId).order('position'),
    supabase.schema('projects').from('tasks').select('title, description, module_id, created_at').eq('project_id', projectId).is('archived_at', null).neq('status', 'cancelled').order('created_at'),
  ]);
  for (const [scope, res] of [
    ['modules', modulesRes],
    ['features', featuresRes],
    ['milestones', milestonesRes],
    ['scopeVersions', versionsRes],
    ['onboarding', onboardingRes],
    ['tasks', tasksRes],
  ] as const) {
    if (res.error) {
      log(`createProjectTemplateFromProject.${scope}`, res.error.message);
      return err('INTERNAL', `Could not read the project's ${scope}.`);
    }
  }

  let scopeItems: TemplateItems['scopeItems'] = [];
  const latestVersion = versionsRes.data?.[0];
  if (latestVersion) {
    const { data: items, error } = await supabase
      .schema('projects')
      .from('scope_items')
      .select('title, detail, inclusion, acceptance_criteria, position')
      .eq('scope_version_id', latestVersion.id)
      .order('position');
    if (error) {
      log('createProjectTemplateFromProject.scopeItems', error.message);
      return err('INTERNAL', "Could not read the project's scope items.");
    }
    scopeItems = (items ?? []).map((i) => ({ title: i.title, detail: i.detail, inclusion: i.inclusion, acceptanceCriteria: i.acceptance_criteria }));
  }

  const moduleName = new Map((modulesRes.data ?? []).map((m) => [m.id, m.name]));
  const items: TemplateItems = {
    modules: (modulesRes.data ?? []).map((m) => ({
      name: m.name,
      description: m.description,
      features: (featuresRes.data ?? []).filter((f) => f.module_id === m.id).map((f) => ({ name: f.name, description: f.description })),
    })),
    milestones: (milestonesRes.data ?? []).map((m) => ({ name: m.name, percent: Number(m.payment_percent ?? 0), description: m.description })),
    scopeItems,
    onboarding: (onboardingRes.data ?? []).map((o) => ({ key: o.key, label: o.label, position: o.position })),
    tasks: (tasksRes.data ?? []).map((t) => ({ title: t.title, moduleName: t.module_id ? (moduleName.get(t.module_id) ?? null) : null, description: t.description })),
  };
  const validated = templateItemsSchema.safeParse(items);
  if (!validated.success) return err('VALIDATION', `The project's structure could not be snapshotted: ${validated.error.issues[0]?.message ?? 'invalid'}.`);

  const { data, error } = await supabase
    .schema('projects')
    .from('project_templates')
    .insert({
      organization_id: context.organizationId,
      name: parsed.data.name,
      description: parsed.data.description || null,
      source_project_id: projectId,
      template_items: validated.data as unknown as Json,
      created_by: context.userId,
    })
    .select('id')
    .single();
  if (error || !data) {
    log('createProjectTemplateFromProject.insert', error?.message);
    if (error?.code === '23505') return err('CONFLICT', 'A template with that name already exists.');
    return err('INTERNAL', 'Could not save the template.');
  }

  return ok({
    templateId: data.id,
    counts: {
      modules: items.modules.length,
      features: items.modules.reduce((n, m) => n + m.features.length, 0),
      milestones: items.milestones.length,
      scopeItems: items.scopeItems.length,
      onboarding: items.onboarding.length,
      tasks: items.tasks.length,
    },
  });
}

export type FromTemplateOutcome = {
  projectId: string;
  written: { modules: number; features: number; tasks: number; scopeItems: number; milestones: number };
  /** Every item that did not land, with the door's own refusal. */
  skipped: string[];
};

export async function createProjectFromTemplate(input: CreateProjectFromTemplateInput): Promise<Result<FromTemplateOutcome>> {
  const parsed = createProjectFromTemplateSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid project.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to create projects.');

  const supabase = await createClient();
  const { data: template, error: templateError } = await supabase
    .schema('projects')
    .from('project_templates')
    .select('id, name, template_items')
    .eq('id', parsed.data.templateId)
    .maybeSingle();
  if (templateError) {
    log('createProjectFromTemplate.template', templateError.message);
    return err('INTERNAL', 'Could not read the template.');
  }
  if (!template) return err('NOT_FOUND', 'Template not found.');
  const items = templateItemsSchema.safeParse(template.template_items);
  if (!items.success) return err('VALIDATION', 'This template’s contents are not readable. Delete it and save the project again.');

  const created = await createProjectManually({
    clientAccountId: parsed.data.clientAccountId,
    name: parsed.data.name,
    currency: parsed.data.currency,
    ...(parsed.data.startsOn ? { startsOn: parsed.data.startsOn } : {}),
    ...(parsed.data.endsOn ? { endsOn: parsed.data.endsOn } : {}),
    ...(parsed.data.budgetMinor !== undefined ? { budgetMinor: parsed.data.budgetMinor } : {}),
  });
  if (!created.ok) return created;
  const projectId = created.data.projectId;

  const skipped: string[] = [];
  const written = { modules: 0, features: 0, tasks: 0, scopeItems: 0, milestones: 0 };
  const moduleIdByName = new Map<string, string>();

  for (const m of items.data.modules) {
    const r = await createModule({ projectId, name: m.name, ...(m.description ? { description: m.description } : {}) });
    if (!r.ok) {
      skipped.push(`Module “${m.name}”: ${r.error.message}`);
      continue;
    }
    written.modules += 1;
    moduleIdByName.set(m.name, r.data.moduleId);
    for (const f of m.features) {
      const fr = await createFeature({ projectId, moduleId: r.data.moduleId, name: f.name, ...(f.description ? { description: f.description } : {}) });
      if (!fr.ok) skipped.push(`Feature “${f.name}”: ${fr.error.message}`);
      else written.features += 1;
    }
  }

  for (const t of items.data.tasks) {
    const moduleId = t.moduleName ? moduleIdByName.get(t.moduleName) : undefined;
    const r = await createTask({ projectId, title: t.title, ...(moduleId ? { moduleId } : {}), ...(t.description ? { description: t.description } : {}) });
    if (!r.ok) skipped.push(`Task “${t.title}”: ${r.error.message}`);
    else written.tasks += 1;
  }

  if (items.data.milestones.length > 0) {
    const total = milestonePercentTotal(items.data);
    if (total === 100) {
      const r = await configurePaymentPlan({ projectId, items: items.data.milestones.map((m) => ({ name: m.name, percent: m.percent })) });
      if (!r.ok) skipped.push(`Payment plan: ${r.error.message}`);
      else written.milestones = items.data.milestones.length;
    } else {
      skipped.push(`Payment plan: the template's milestones add up to ${total}%, not 100%, so no plan was written — configure one on the Plan tab.`);
    }
  }

  if (items.data.scopeItems.length > 0) {
    const opened = await openScopeVersion({ projectId });
    if (!opened.ok) skipped.push(`Scope: ${opened.error.message}`);
    else {
      for (const s of items.data.scopeItems) {
        const r = await addScopeItem({
          scopeVersionId: opened.data.scopeVersionId,
          title: s.title,
          inclusion: s.inclusion as never,
          ...(s.detail ? { detail: s.detail } : {}),
          ...(s.acceptanceCriteria ? { acceptanceCriteria: s.acceptanceCriteria } : {}),
        });
        if (!r.ok) skipped.push(`Scope item “${s.title}”: ${r.error.message}`);
        else written.scopeItems += 1;
      }
    }
  }

  if (items.data.onboarding.length > 0) {
    skipped.push(`Onboarding checklist (${items.data.onboarding.length} items) is recorded on the template but not written: a project's checklist is seeded from the organization's baseline when it starts.`);
  }

  return ok({ projectId, written, skipped });
}

export async function deleteProjectTemplate(input: DeleteProjectTemplateInput): Promise<Result<{ deleted: true }>> {
  const parsed = deleteProjectTemplateSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid template.');

  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return err('FORBIDDEN', 'You do not have permission to delete templates.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').from('project_templates').delete().eq('id', parsed.data.templateId).select('id');
  if (error) {
    log('deleteProjectTemplate', error.message);
    return err('INTERNAL', 'Could not delete the template.');
  }
  if (!data || data.length === 0) return err('NOT_FOUND', 'Template not found.');
  return ok({ deleted: true });
}

/**
 * SCR-027 "Clone template": a copy under a new name, through
 * `projects.clone_project_template` (security definer, the same role check the
 * rest of the delivery doors use, audited `project_template.cloned`).
 */
export async function cloneProjectTemplate(input: CloneProjectTemplateInput): Promise<Result<{ templateId: string }>> {
  const parsed = cloneProjectTemplateSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid template.');
  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to clone a template.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('clone_project_template', { p_template_id: parsed.data.templateId, p_name: parsed.data.name });
  if (error) {
    log('cloneProjectTemplate', error.message);
    return err('INTERNAL', 'Could not clone the template.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; template_id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'cloned':
      return row.template_id ? ok({ templateId: row.template_id }) : err('INTERNAL', 'Could not clone the template.');
    case 'name_taken':
      return err('CONFLICT', 'A template with that name already exists. Choose another name for the copy.');
    case 'invalid_name':
      return err('VALIDATION', 'Give the copy a name.');
    case 'not_found':
      return err('NOT_FOUND', 'Template not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not clone a template.');
    default:
      return err('INTERNAL', 'Could not clone the template.');
  }
}
