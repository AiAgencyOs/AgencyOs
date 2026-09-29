import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-029 (bucket G-3) — the links a person DECLARED from a requirement
 * version (`crm.requirement_links`, written by `crm.link_requirement`), and
 * the records the "Link…" form may point at: the lead's quotations, and the
 * design deliverables and tasks of the lead's project(s). Beside
 * `requirement-set.ts`, which derives "Cited by" from the foreign keys other
 * tables carry; this is the list a person made on purpose.
 */

export type RequirementLink = {
  id: string;
  targetType: 'quotation' | 'design' | 'task';
  targetId: string;
  /** What the target is called, from its own table; null when it is gone or unreadable under RLS. */
  title: string | null;
  status: string | null;
  version: number | null;
  projectId: string | null;
  note: string | null;
  linkedBy: string | null;
  createdAt: string;
};

export type RequirementLinkTargets = {
  quotations: { id: string; title: string; version: number; status: string }[];
  designs: { id: string; title: string; version: number; status: string; projectId: string; projectName: string }[];
  tasks: { id: string; title: string; status: string; projectId: string; projectName: string }[];
};

const EMPTY_TARGETS: RequirementLinkTargets = { quotations: [], designs: [], tasks: [] };

export async function readRequirementLinks(versionIds: readonly string[]): Promise<Map<string, RequirementLink[]>> {
  const out = new Map<string, RequirementLink[]>();
  if (versionIds.length === 0) return out;
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('requirement_links')
    .select('id, requirement_version_id, target_type, quotation_id, deliverable_id, task_id, note, linked_by, created_at')
    .in('requirement_version_id', [...versionIds])
    .order('created_at', { ascending: false });
  if (error) unreadable('readRequirementLinks', error);

  const rows = data ?? [];
  const quotationIds = rows.map((r) => r.quotation_id).filter((id): id is string => id !== null);
  const deliverableIds = rows.map((r) => r.deliverable_id).filter((id): id is string => id !== null);
  const taskIds = rows.map((r) => r.task_id).filter((id): id is string => id !== null);

  const [proposals, deliverables, tasks] = await Promise.all([
    quotationIds.length > 0 ? supabase.schema('sales').from('proposals').select('id, title, version, status').in('id', quotationIds) : Promise.resolve({ data: [], error: null }),
    deliverableIds.length > 0 ? supabase.schema('projects').from('deliverables').select('id, title, version, status, project_id').in('id', deliverableIds) : Promise.resolve({ data: [], error: null }),
    taskIds.length > 0 ? supabase.schema('projects').from('tasks').select('id, title, status, project_id').in('id', taskIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (proposals.error) unreadable('readRequirementLinks.proposals', proposals.error);
  if (deliverables.error) unreadable('readRequirementLinks.deliverables', deliverables.error);
  if (tasks.error) unreadable('readRequirementLinks.tasks', tasks.error);

  const proposalById = new Map((proposals.data ?? []).map((p) => [p.id, p]));
  const deliverableById = new Map((deliverables.data ?? []).map((d) => [d.id, d]));
  const taskById = new Map((tasks.data ?? []).map((t) => [t.id, t]));

  for (const r of rows) {
    const targetType = r.target_type as RequirementLink['targetType'];
    const targetId = r.quotation_id ?? r.deliverable_id ?? r.task_id ?? '';
    let title: string | null = null;
    let status: string | null = null;
    let version: number | null = null;
    let projectId: string | null = null;
    if (targetType === 'quotation') {
      const p = proposalById.get(targetId);
      if (p) ({ title, status, version } = p);
    } else if (targetType === 'design') {
      const d = deliverableById.get(targetId);
      if (d) {
        ({ title, status, version } = d);
        projectId = d.project_id;
      }
    } else {
      const t = taskById.get(targetId);
      if (t) {
        ({ title, status } = t);
        projectId = t.project_id;
      }
    }
    const list = out.get(r.requirement_version_id) ?? [];
    list.push({ id: r.id, targetType, targetId, title, status, version, projectId, note: r.note, linkedBy: r.linked_by, createdAt: r.created_at });
    out.set(r.requirement_version_id, list);
  }
  return out;
}

/**
 * What the "Link…" form may point at for one lead: its quotations (through
 * the opportunity), and the design/prototype deliverables and tasks of the
 * project(s) the deal became — found by `projects.projects.opportunity_id`
 * plus any project id the page already knows (the project group's).
 */
export async function readRequirementLinkTargets(input: { opportunityId: string | null; projectIds?: readonly string[] }): Promise<RequirementLinkTargets> {
  const supabase = await createClient();

  const [proposals, byOpportunity] = await Promise.all([
    input.opportunityId
      ? supabase.schema('sales').from('proposals').select('id, title, version, status').eq('opportunity_id', input.opportunityId).order('version', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    input.opportunityId
      ? supabase.schema('projects').from('projects').select('id, name').eq('opportunity_id', input.opportunityId)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (proposals.error) unreadable('readRequirementLinkTargets.proposals', proposals.error);
  if (byOpportunity.error) unreadable('readRequirementLinkTargets.projects', byOpportunity.error);

  const projectIds = [...new Set([...(byOpportunity.data ?? []).map((p) => p.id), ...(input.projectIds ?? [])])];
  if (projectIds.length === 0 && (proposals.data ?? []).length === 0) return EMPTY_TARGETS;

  const projectName = new Map((byOpportunity.data ?? []).map((p) => [p.id, p.name]));
  const unnamed = projectIds.filter((id) => !projectName.has(id));

  const [named, deliverables, tasks] = await Promise.all([
    unnamed.length > 0 ? supabase.schema('projects').from('projects').select('id, name').in('id', unnamed) : Promise.resolve({ data: [], error: null }),
    projectIds.length > 0
      ? supabase.schema('projects').from('deliverables').select('id, title, version, status, project_id, kind').in('project_id', projectIds).in('kind', ['design', 'prototype']).order('created_at', { ascending: false }).limit(200)
      : Promise.resolve({ data: [], error: null }),
    projectIds.length > 0
      ? supabase.schema('projects').from('tasks').select('id, title, status, project_id').in('project_id', projectIds).order('created_at', { ascending: false }).limit(500)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (named.error) unreadable('readRequirementLinkTargets.namedProjects', named.error);
  if (deliverables.error) unreadable('readRequirementLinkTargets.deliverables', deliverables.error);
  if (tasks.error) unreadable('readRequirementLinkTargets.tasks', tasks.error);
  for (const p of named.data ?? []) projectName.set(p.id, p.name);

  return {
    quotations: (proposals.data ?? []).map((p) => ({ id: p.id, title: p.title, version: p.version, status: p.status })),
    designs: (deliverables.data ?? []).map((d) => ({ id: d.id, title: d.title, version: d.version, status: d.status, projectId: d.project_id, projectName: projectName.get(d.project_id) ?? 'Unknown project' })),
    tasks: (tasks.data ?? []).map((t) => ({ id: t.id, title: t.title, status: t.status, projectId: t.project_id, projectName: projectName.get(t.project_id) ?? 'Unknown project' })),
  };
}
