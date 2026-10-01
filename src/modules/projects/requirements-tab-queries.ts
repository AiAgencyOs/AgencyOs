import 'server-only';

import { readRequirementLinks, type RequirementLink } from '@/lib/admin/requirement-links';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { priorityOf } from './requirement-plan-schema';
import { numberRows, splitCriteria, statusOf, type FeatureStatus, type RequirementRow, type ScopeInclusion } from './requirements-tab';

/**
 * The project Requirements tab's reads: the scope items of the active and
 * the draft version, each with the module / delivery state of the feature it
 * is planned under, the screens that cite it, the test cases planned against
 * it, the plan deliverables built for it and its comment count. Every
 * relation is one batched read, never one per row.
 */
export async function readProjectRequirements(projectId: string): Promise<{ rows: RequirementRow[]; openChangeRequests: number; activeVersion: number | null; draftVersion: number | null }> {
  const supabase = await createClient();

  const { data: versions, error: versionsError } = await supabase
    .schema('projects')
    .from('scope_versions')
    .select('id, version, status, requirement_version_id')
    .eq('project_id', projectId)
    .in('status', ['active', 'draft']);
  if (versionsError) unreadable('readProjectRequirements.versions', versionsError);

  const changeRequests = await supabase
    .schema('projects')
    .from('change_requests')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .in('status', ['submitted', 'analysing', 'classified', 'pending_approval']);
  if (changeRequests.error) unreadable('readProjectRequirements.changeRequests', changeRequests.error);
  const openChangeRequests = changeRequests.count ?? 0;

  const live = versions ?? [];
  const active = live.find((v) => v.status === 'active') ?? null;
  const draft = live.find((v) => v.status === 'draft') ?? null;
  if (live.length === 0) return { rows: [], openChangeRequests, activeVersion: null, draftVersion: null };

  const { data: items, error: itemsError } = await supabase
    .schema('projects')
    .from('scope_items')
    .select('id, scope_version_id, feature_id, title, detail, inclusion, acceptance_criteria, position, created_at')
    .in('scope_version_id', live.map((v) => v.id))
    .order('position', { ascending: true });
  if (itemsError) unreadable('readProjectRequirements.items', itemsError);
  const scopeItems = items ?? [];
  if (scopeItems.length === 0) return { rows: [], openChangeRequests, activeVersion: active?.version ?? null, draftVersion: draft?.version ?? null };

  const itemIds = scopeItems.map((i) => i.id);
  const featureIds = [...new Set(scopeItems.map((i) => i.feature_id).filter((id): id is string => id !== null))];

  const requirementVersionIds = [...new Set(live.map((v) => v.requirement_version_id).filter((id): id is string => id !== null))];
  const [features, screenLinks, testCases, deliverables, comments, plans, fileLinks, clarificationRows, proposalRows] = await Promise.all([
    featureIds.length > 0 ? supabase.schema('projects').from('features').select('id, status, module_id').in('id', featureIds) : Promise.resolve({ data: [], error: null }),
    supabase.schema('projects').from('screen_scope_items').select('scope_item_id, screen_id').in('scope_item_id', itemIds),
    supabase.schema('qa').from('test_plan_items').select('scope_item_id').in('scope_item_id', itemIds),
    supabase.schema('projects').from('plan_deliverables').select('scope_item_id, name, status').in('scope_item_id', itemIds),
    supabase.schema('projects').from('scope_item_comments').select('scope_item_id').in('scope_item_id', itemIds),
    supabase.schema('projects').from('scope_item_plans').select('scope_item_id, priority, assignee_id').in('scope_item_id', itemIds),
    supabase.schema('projects').from('scope_item_files').select('scope_item_id, file_id, created_at').in('scope_item_id', itemIds).order('created_at', { ascending: true }),
    supabase
      .schema('projects')
      .from('requirement_clarifications')
      .select('id, scope_item_id, question, impact, status, raised_by, raised_at, answer, answered_at')
      .in('scope_item_id', itemIds)
      .order('raised_at', { ascending: false }),
    requirementVersionIds.length > 0
      ? supabase.schema('sales').from('proposals').select('id, title, version, status, requirement_version_id').in('requirement_version_id', requirementVersionIds).order('version', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (clarificationRows.error) unreadable('readProjectRequirements.clarifications', clarificationRows.error);
  if (proposalRows.error) unreadable('readProjectRequirements.proposals', proposalRows.error);
  if (features.error) unreadable('readProjectRequirements.features', features.error);
  if (screenLinks.error) unreadable('readProjectRequirements.screenLinks', screenLinks.error);
  if (testCases.error) unreadable('readProjectRequirements.testCases', testCases.error);
  if (deliverables.error) unreadable('readProjectRequirements.deliverables', deliverables.error);
  if (comments.error) unreadable('readProjectRequirements.comments', comments.error);
  if (plans.error) unreadable('readProjectRequirements.plans', plans.error);
  if (fileLinks.error) unreadable('readProjectRequirements.fileLinks', fileLinks.error);

  const raiserIds = [...new Set((clarificationRows.data ?? []).map((c) => c.raised_by).filter((id): id is string => id !== null))];
  const tasksRes = featureIds.length > 0 ? await supabase.schema('projects').from('tasks').select('id, title, status, feature_id').in('feature_id', featureIds).order('created_at', { ascending: true }).limit(500) : { data: [], error: null };
  if (tasksRes.error) unreadable('readProjectRequirements.tasks', tasksRes.error);
  const raiserRes = raiserIds.length > 0 ? await supabase.schema('core').from('users').select('id, full_name, email').in('id', raiserIds) : { data: [], error: null };
  if (raiserRes.error) unreadable('readProjectRequirements.raisers', raiserRes.error);
  const raiserName = new Map((raiserRes.data ?? []).map((u) => [u.id, u.full_name || u.email]));
  const moduleIds = [...new Set((features.data ?? []).map((f) => f.module_id))];
  const screenIds = [...new Set((screenLinks.data ?? []).map((s) => s.screen_id))];
  const assigneeIds = [...new Set((plans.data ?? []).map((p) => p.assignee_id).filter((id): id is string => id !== null))];
  const fileIds = [...new Set((fileLinks.data ?? []).map((l) => l.file_id))];
  const [modules, screens, people, linkedFiles] = await Promise.all([
    moduleIds.length > 0 ? supabase.schema('projects').from('modules').select('id, name').in('id', moduleIds) : Promise.resolve({ data: [], error: null }),
    screenIds.length > 0 ? supabase.schema('projects').from('screens').select('id, name').in('id', screenIds) : Promise.resolve({ data: [], error: null }),
    assigneeIds.length > 0 ? supabase.schema('core').from('users').select('id, full_name, email').in('id', assigneeIds) : Promise.resolve({ data: [], error: null }),
    fileIds.length > 0 ? supabase.schema('projects').from('project_files').select('id, title, url, deleted_at').in('id', fileIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (modules.error) unreadable('readProjectRequirements.modules', modules.error);
  if (screens.error) unreadable('readProjectRequirements.screens', screens.error);
  if (people.error) unreadable('readProjectRequirements.people', people.error);
  if (linkedFiles.error) unreadable('readProjectRequirements.linkedFiles', linkedFiles.error);
  const personName = new Map((people.data ?? []).map((u) => [u.id, u.full_name || u.email]));
  const planById = new Map((plans.data ?? []).map((p) => [p.scope_item_id, p]));
  const fileById = new Map((linkedFiles.data ?? []).filter((f) => f.deleted_at === null).map((f) => [f.id, f]));

  const moduleName = new Map((modules.data ?? []).map((m) => [m.id, m.name]));
  const featureById = new Map((features.data ?? []).map((f) => [f.id, { status: f.status as FeatureStatus, module: moduleName.get(f.module_id) ?? null }]));
  const screenName = new Map((screens.data ?? []).map((s) => [s.id, s.name]));
  const versionById = new Map(live.map((v) => [v.id, v]));

  const count = <T extends { scope_item_id: string }>(list: readonly T[] | null) => {
    const m = new Map<string, number>();
    for (const r of list ?? []) m.set(r.scope_item_id, (m.get(r.scope_item_id) ?? 0) + 1);
    return m;
  };
  const testCount = count(testCases.data);
  const commentCount = count(comments.data);

  const numbered = numberRows(
    scopeItems.map((i) => ({ ...i, versionStatus: (versionById.get(i.scope_version_id)?.status === 'draft' ? 'draft' : 'active') as 'active' | 'draft' })),
  );
  const rows: RequirementRow[] = numbered.map((i) => {
    const feature = i.feature_id ? featureById.get(i.feature_id) : undefined;
    const inclusion = i.inclusion as ScopeInclusion;
    return {
      id: i.id,
      code: i.code,
      title: i.title,
      detail: i.detail,
      criteria: splitCriteria(i.acceptance_criteria),
      inclusion,
      versionStatus: i.versionStatus,
      version: versionById.get(i.scope_version_id)?.version ?? 0,
      status: statusOf(i.versionStatus, inclusion),
      module: feature?.module ?? null,
      delivery: feature?.status ?? null,
      createdAt: i.created_at,
      screens: (screenLinks.data ?? []).filter((s) => s.scope_item_id === i.id).map((s) => ({ id: s.screen_id, name: screenName.get(s.screen_id) ?? 'Screen' })),
      testCases: testCount.get(i.id) ?? 0,
      deliverables: (deliverables.data ?? []).filter((d) => d.scope_item_id === i.id).map((d) => ({ name: d.name, status: d.status })),
      comments: commentCount.get(i.id) ?? 0,
      priority: priorityOf(planById.get(i.id)?.priority),
      assignee: planById.get(i.id)?.assignee_id ? { userId: planById.get(i.id)?.assignee_id as string, name: personName.get(planById.get(i.id)?.assignee_id as string) ?? 'Former member' } : null,
      files: (fileLinks.data ?? []).filter((l) => l.scope_item_id === i.id && fileById.has(l.file_id)).map((l) => ({ fileId: l.file_id, title: fileById.get(l.file_id)?.title ?? 'File', url: fileById.get(l.file_id)?.url ?? null })),
      featureId: i.feature_id,
      tasks: i.feature_id ? (tasksRes.data ?? []).filter((t) => t.feature_id === i.feature_id).map((t) => ({ id: t.id, title: t.title, status: t.status })) : [],
      quotations: (proposalRows.data ?? [])
        .filter((p) => p.requirement_version_id !== null && p.requirement_version_id === versionById.get(i.scope_version_id)?.requirement_version_id)
        .map((p) => ({ id: p.id, title: p.title, version: p.version, status: p.status })),
      clarifications: (clarificationRows.data ?? [])
        .filter((c) => c.scope_item_id === i.id)
        .map((c) => ({
          id: c.id,
          question: c.question,
          impact: c.impact,
          status: (c.status === 'answered' ? 'answered' : 'open') as 'open' | 'answered',
          raisedAt: c.raised_at,
          raisedByName: c.raised_by ? (raiserName.get(c.raised_by) ?? 'Former member') : null,
          answer: c.answer,
          answeredAt: c.answered_at,
        })),
    };
  });
  return { rows, openChangeRequests, activeVersion: active?.version ?? null, draftVersion: draft?.version ?? null };
}

export type RequirementComment = { id: string; authorName: string; body: string; createdAt: string };

export async function readRequirementComments(scopeItemId: string): Promise<RequirementComment[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('scope_item_comments')
    .select('id, author_id, body, created_at')
    .eq('scope_item_id', scopeItemId)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) unreadable('readRequirementComments', error);
  const rows = data ?? [];
  const authorIds = [...new Set(rows.map((r) => r.author_id).filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (authorIds.length > 0) {
    const people = await supabase.schema('core').from('memberships').select('user_id, users:user_id(full_name, email)').in('user_id', authorIds);
    if (people.error) unreadable('readRequirementComments.authors', people.error);
    for (const m of (people.data ?? []) as Record<string, unknown>[]) {
      const u = (m.users ?? {}) as { full_name?: string | null; email?: string | null };
      names.set(m.user_id as string, u.full_name ?? u.email ?? 'someone without a name on file');
    }
  }
  return rows.map((r) => ({ id: r.id, authorName: r.author_id ? (names.get(r.author_id) ?? 'Former member') : 'Former member', body: r.body, createdAt: r.created_at }));
}

/** The files a requirement can have attached: the project's own, latest versions, not in the trash. */
export async function readAttachableFiles(projectId: string): Promise<{ id: string; title: string }[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('project_files')
    .select('id, title')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .is('parent_file_id', null)
    .order('title', { ascending: true })
    .limit(300);
  if (error) unreadable('readAttachableFiles', error);
  return data ?? [];
}

export type ScopeSourceSet = {
  scopeVersion: number;
  scopeStatus: string;
  requirementVersion: number;
  requirementStatus: string;
  leadId: string | null;
  leadTitle: string | null;
  links: RequirementLink[];
};

/**
 * SCR-029 — the requirement set a project's scope descends from: the version
 * the lead's conversation produced (`scope_versions.requirement_version_id`),
 * the lead it belongs to and the links a person declared from it to
 * quotations, designs and tasks. This is what makes the lead tab and the
 * project list one set: the project page says where it came from and the lead
 * page links back here.
 */
export async function readScopeSourceSet(projectId: string): Promise<ScopeSourceSet | null> {
  const supabase = await createClient();
  const { data: versions, error } = await supabase
    .schema('projects')
    .from('scope_versions')
    .select('version, status, requirement_version_id')
    .eq('project_id', projectId)
    .not('requirement_version_id', 'is', null)
    .in('status', ['active', 'draft'])
    .order('version', { ascending: false });
  if (error) unreadable('readScopeSourceSet.versions', error);
  const scope = (versions ?? []).find((v) => v.status === 'active') ?? (versions ?? [])[0];
  if (!scope?.requirement_version_id) return null;

  const { data: rv, error: rvError } = await supabase.schema('crm').from('requirement_versions').select('id, version, status, conversation_id').eq('id', scope.requirement_version_id).maybeSingle();
  if (rvError) unreadable('readScopeSourceSet.requirementVersion', rvError);
  if (!rv) return null;
  const { data: conversation, error: cError } = await supabase.schema('crm').from('conversations').select('lead_id').eq('id', rv.conversation_id).maybeSingle();
  if (cError) unreadable('readScopeSourceSet.conversation', cError);
  let leadTitle: string | null = null;
  if (conversation?.lead_id) {
    const { data: lead, error: lError } = await supabase.schema('crm').from('leads').select('title').eq('id', conversation.lead_id).maybeSingle();
    if (lError) unreadable('readScopeSourceSet.lead', lError);
    leadTitle = lead?.title ?? null;
  }
  const links = (await readRequirementLinks([rv.id])).get(rv.id) ?? [];
  return {
    scopeVersion: scope.version,
    scopeStatus: scope.status,
    requirementVersion: rv.version,
    requirementStatus: rv.status,
    leadId: conversation?.lead_id ?? null,
    leadTitle,
    links,
  };
}

/** The projects whose scope descends from any of these requirement versions — the lead page's way back. */
export async function readProjectsForRequirementVersions(versionIds: readonly string[]): Promise<{ projectId: string; projectName: string; scopeVersion: number }[]> {
  if (versionIds.length === 0) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('scope_versions')
    .select('project_id, version, status, projects:project_id(name)')
    .in('requirement_version_id', [...versionIds])
    .in('status', ['active', 'draft']);
  if (error) unreadable('readProjectsForRequirementVersions', error);
  const seen = new Set<string>();
  const out: { projectId: string; projectName: string; scopeVersion: number }[] = [];
  for (const r of data ?? []) {
    if (seen.has(r.project_id)) continue;
    seen.add(r.project_id);
    const p = r.projects as unknown as { name: string } | { name: string }[] | null;
    out.push({ projectId: r.project_id, projectName: (Array.isArray(p) ? p[0]?.name : p?.name) ?? 'Project', scopeVersion: r.version });
  }
  return out;
}
