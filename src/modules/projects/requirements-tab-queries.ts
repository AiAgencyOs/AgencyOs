import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

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
    .select('id, version, status')
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

  const [features, screenLinks, testCases, deliverables, comments] = await Promise.all([
    featureIds.length > 0 ? supabase.schema('projects').from('features').select('id, status, module_id').in('id', featureIds) : Promise.resolve({ data: [], error: null }),
    supabase.schema('projects').from('screen_scope_items').select('scope_item_id, screen_id').in('scope_item_id', itemIds),
    supabase.schema('qa').from('test_plan_items').select('scope_item_id').in('scope_item_id', itemIds),
    supabase.schema('projects').from('plan_deliverables').select('scope_item_id, name, status').in('scope_item_id', itemIds),
    supabase.schema('projects').from('scope_item_comments').select('scope_item_id').in('scope_item_id', itemIds),
  ]);
  if (features.error) unreadable('readProjectRequirements.features', features.error);
  if (screenLinks.error) unreadable('readProjectRequirements.screenLinks', screenLinks.error);
  if (testCases.error) unreadable('readProjectRequirements.testCases', testCases.error);
  if (deliverables.error) unreadable('readProjectRequirements.deliverables', deliverables.error);
  if (comments.error) unreadable('readProjectRequirements.comments', comments.error);

  const moduleIds = [...new Set((features.data ?? []).map((f) => f.module_id))];
  const screenIds = [...new Set((screenLinks.data ?? []).map((s) => s.screen_id))];
  const [modules, screens] = await Promise.all([
    moduleIds.length > 0 ? supabase.schema('projects').from('modules').select('id, name').in('id', moduleIds) : Promise.resolve({ data: [], error: null }),
    screenIds.length > 0 ? supabase.schema('projects').from('screens').select('id, name').in('id', screenIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (modules.error) unreadable('readProjectRequirements.modules', modules.error);
  if (screens.error) unreadable('readProjectRequirements.screens', screens.error);

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
