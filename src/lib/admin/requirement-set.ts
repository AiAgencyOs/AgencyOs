import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * What cites a requirement version, and how far downstream it has been
 * carried — SCR-029's "requirement set" beside the extracted payload.
 *
 * A requirement version is the root of four foreign keys the product
 * already writes and never read back to the lead page: a quotation
 * (`sales.proposals.requirement_version_id`), a scope baseline
 * (`projects.scope_versions.requirement_version_id`), and the Phase 5
 * breakdown (`projects.modules` / `features` / `tasks`). Coverage is the
 * chain the design and QA gates already enforce one link at a time —
 * scope item → screen (`screen_scope_items`) → test-plan item
 * (`qa.test_plan_items.scope_item_id`) — rolled up to one percentage per
 * included item. Nothing here is a second opinion on a gate; the flags
 * that refuse a design are `readUiCoverage`'s, and this only counts.
 */

export type RequirementLinks = {
  quotations: { id: string; title: string; version: number; status: string; opportunityId: string }[];
  scopeVersions: { id: string; version: number; status: string; projectId: string; projectName: string }[];
  breakdown: { modules: number; features: number; tasks: number };
};

export type RequirementCoverage = {
  projectId: string;
  projectName: string;
  scopeVersion: number;
  includedItems: number;
  withScreen: number;
  withTest: number;
  /** Items that have BOTH a screen and a test-plan item, over included items. */
  percent: number | null;
};

export type RequirementQuestion = {
  id: string;
  question: string;
  status: string;
  answer: string | null;
  createdAt: string;
};

export type RequirementSet = {
  links: RequirementLinks;
  coverage: RequirementCoverage | null;
  /** The PM Agent's clarifications on the linked project, newest first. */
  questions: RequirementQuestion[];
};

type ClarificationRequestRow = {
  id: string;
  project_id: string;
  question: string;
  status: string;
  answer: string | null;
  created_at: string;
};

const EMPTY_LINKS: RequirementLinks = { quotations: [], scopeVersions: [], breakdown: { modules: 0, features: 0, tasks: 0 } };

export async function readRequirementSets(versionIds: readonly string[]): Promise<Map<string, RequirementSet>> {
  const out = new Map<string, RequirementSet>();
  if (versionIds.length === 0) return out;
  const ids = [...versionIds];
  const supabase = await createClient();

  const [proposals, scopeVersions, modules, features, tasks] = await Promise.all([
    supabase.schema('sales').from('proposals').select('id, title, version, status, opportunity_id, requirement_version_id').in('requirement_version_id', ids),
    supabase.schema('projects').from('scope_versions').select('id, version, status, project_id, requirement_version_id').in('requirement_version_id', ids).order('version', { ascending: false }),
    supabase.schema('projects').from('modules').select('requirement_version_id').in('requirement_version_id', ids),
    supabase.schema('projects').from('features').select('requirement_version_id').in('requirement_version_id', ids),
    supabase.schema('projects').from('tasks').select('requirement_version_id').in('requirement_version_id', ids),
  ]);
  if (proposals.error) unreadable('readRequirementSets.proposals', proposals.error);
  if (scopeVersions.error) unreadable('readRequirementSets.scopeVersions', scopeVersions.error);
  if (modules.error) unreadable('readRequirementSets.modules', modules.error);
  if (features.error) unreadable('readRequirementSets.features', features.error);
  if (tasks.error) unreadable('readRequirementSets.tasks', tasks.error);

  const projectIds = [...new Set((scopeVersions.data ?? []).map((v) => v.project_id))];
  const projectName = new Map<string, string>();
  let questionsByProject = new Map<string, RequirementQuestion[]>();
  if (projectIds.length > 0) {
    const [projects, questions] = await Promise.all([
      supabase.schema('projects').from('projects').select('id, name').in('id', projectIds),
      supabase
        .schema('projects')
        .from('clarification_requests')
        .select('id, project_id, question, status, answer, created_at')
        .in('project_id', projectIds)
        .order('created_at', { ascending: false }),
    ]);
    if (projects.error) unreadable('readRequirementSets.projects', projects.error);
    if (questions.error) unreadable('readRequirementSets.questions', questions.error);
    for (const p of projects.data ?? []) projectName.set(p.id, p.name);
    questionsByProject = new Map();
    for (const q of (questions.data ?? []) as ClarificationRequestRow[]) {
      const list = questionsByProject.get(q.project_id) ?? [];
      list.push({ id: q.id, question: q.question, status: q.status, answer: q.answer, createdAt: q.created_at });
      questionsByProject.set(q.project_id, list);
    }
  }

  // Coverage is measured on the version's live baseline: the active one, or
  // the newest if none is active yet.
  const versionForCoverage = new Map<string, { id: string; version: number; status: string; project_id: string }>();
  for (const v of scopeVersions.data ?? []) {
    const rv = v.requirement_version_id;
    if (!rv) continue;
    const current = versionForCoverage.get(rv);
    // Rows arrive newest first, so the first one wins unless a later row is
    // the active baseline and the one held is not.
    if (!current || (v.status === 'active' && current.status !== 'active')) {
      versionForCoverage.set(rv, { id: v.id, version: v.version, status: v.status, project_id: v.project_id });
    }
  }

  const coverageByRequirement = new Map<string, RequirementCoverage>();
  const coverageVersionIds = [...versionForCoverage.values()].map((v) => v.id);
  if (coverageVersionIds.length > 0) {
    const scopeItems = await supabase
      .schema('projects')
      .from('scope_items')
      .select('id, scope_version_id, inclusion')
      .in('scope_version_id', coverageVersionIds);
    if (scopeItems.error) unreadable('readRequirementSets.scopeItems', scopeItems.error);
    const itemIds = (scopeItems.data ?? []).map((i) => i.id);

    const [screenLinks, testItems] =
      itemIds.length > 0
        ? await Promise.all([
            // A superseded screen (merged or split away, 20260929200000) is
            // history, not coverage — the same exclusion projects.ui_coverage makes.
            supabase.schema('projects').from('screen_scope_items').select('scope_item_id, screens!inner(status)').in('scope_item_id', itemIds).neq('screens.status', 'superseded'),
            supabase.schema('qa').from('test_plan_items').select('scope_item_id').in('scope_item_id', itemIds),
          ])
        : [{ data: [], error: null }, { data: [], error: null }];
    if (screenLinks.error) unreadable('readRequirementSets.screenLinks', screenLinks.error);
    if (testItems.error) unreadable('readRequirementSets.testItems', testItems.error);

    const screened = new Set((screenLinks.data ?? []).map((r) => r.scope_item_id));
    const tested = new Set((testItems.data ?? []).map((r) => r.scope_item_id));

    for (const [requirementVersionId, v] of versionForCoverage) {
      const included = (scopeItems.data ?? []).filter((i) => i.scope_version_id === v.id && i.inclusion === 'included');
      const withScreen = included.filter((i) => screened.has(i.id)).length;
      const withTest = included.filter((i) => tested.has(i.id)).length;
      const both = included.filter((i) => screened.has(i.id) && tested.has(i.id)).length;
      coverageByRequirement.set(requirementVersionId, {
        projectId: v.project_id,
        projectName: projectName.get(v.project_id) ?? 'Unknown project',
        scopeVersion: v.version,
        includedItems: included.length,
        withScreen,
        withTest,
        percent: included.length === 0 ? null : Math.round((both / included.length) * 100),
      });
    }
  }

  const count = (rows: { requirement_version_id: string | null }[] | null, id: string) =>
    (rows ?? []).filter((r) => r.requirement_version_id === id).length;

  for (const id of ids) {
    const coverage = coverageByRequirement.get(id) ?? null;
    out.set(id, {
      links: {
        quotations: (proposals.data ?? [])
          .filter((p) => p.requirement_version_id === id)
          .map((p) => ({ id: p.id, title: p.title, version: p.version, status: p.status, opportunityId: p.opportunity_id })),
        scopeVersions: (scopeVersions.data ?? [])
          .filter((v) => v.requirement_version_id === id)
          .map((v) => ({
            id: v.id,
            version: v.version,
            status: v.status,
            projectId: v.project_id,
            projectName: projectName.get(v.project_id) ?? 'Unknown project',
          })),
        breakdown: {
          modules: count(modules.data, id),
          features: count(features.data, id),
          tasks: count(tasks.data, id),
        },
      },
      coverage,
      questions: coverage ? (questionsByProject.get(coverage.projectId) ?? []) : [],
    });
  }
  for (const id of ids) if (!out.has(id)) out.set(id, { links: EMPTY_LINKS, coverage: null, questions: [] });
  return out;
}
