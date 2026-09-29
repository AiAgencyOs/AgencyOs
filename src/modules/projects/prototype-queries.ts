import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-037 — the prototype builds of a project as the Prototype tab needs
 * them: each `prototype_artifacts` row with its deliverable's version and
 * status, its platform, its revision count (how many builds share the UI
 * version), its QA evidence (the coverage verdict and when a person
 * submitted it) and what the client said about the UI version it was built
 * from. Read only; every failed read refuses.
 */

export type PrototypeBuild = {
  artifactId: string;
  deliverableId: string;
  uiVersionId: string;
  uiVersion: number | null;
  version: number;
  title: string;
  status: string;
  artifactUrl: string | null;
  platform: string | null;
  screensCount: number;
  /** Builds recorded against the same UI version — the revision count. */
  revisionCount: number;
  qaSubmittedAt: string | null;
  qaReviewedAt: string | null;
  qaFindings: { flags?: unknown[]; verdict?: string } | null;
  clientFeedback: { decision: string; clientWords: string; createdAt: string }[];
  createdAt: string;
};

export async function listPrototypeBuilds(projectId: string): Promise<PrototypeBuild[]> {
  const supabase = await createClient();

  const { data: artifacts, error } = await supabase
    .schema('projects')
    .from('prototype_artifacts')
    .select('id, deliverable_id, ui_version_id, screens, platform, qa_submitted_at, qa_reviewed_at, qa_findings, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) unreadable('listPrototypeBuilds', error);
  type ArtifactRow = {
    id: string;
    deliverable_id: string;
    ui_version_id: string;
    screens: unknown;
    platform: string | null;
    qa_submitted_at: string | null;
    qa_reviewed_at: string | null;
    qa_findings: unknown;
    created_at: string;
  };
  const rows = (artifacts ?? []) as ArtifactRow[];
  if (rows.length === 0) return [];

  const deliverableIds = rows.map((r) => r.deliverable_id);
  const uiVersionIds = [...new Set(rows.map((r) => r.ui_version_id))];

  const [deliverables, versions, decisions] = await Promise.all([
    supabase.schema('projects').from('deliverables').select('id, version, title, status, artifact_url').in('id', deliverableIds),
    supabase.schema('projects').from('ui_versions').select('id, version').in('id', uiVersionIds),
    supabase
      .schema('projects')
      .from('ui_version_client_decisions')
      .select('ui_version_id, decision, client_words, created_at')
      .in('ui_version_id', uiVersionIds)
      .order('created_at', { ascending: false }),
  ]);
  if (deliverables.error) unreadable('listPrototypeBuilds.deliverables', deliverables.error);
  if (versions.error) unreadable('listPrototypeBuilds.uiVersions', versions.error);
  if (decisions.error) unreadable('listPrototypeBuilds.clientDecisions', decisions.error);

  const deliverableOf = new Map((deliverables.data ?? []).map((d) => [d.id, d]));
  const versionOf = new Map(((versions.data ?? []) as { id: string; version: number }[]).map((v) => [v.id, v.version]));
  const feedbackOf = new Map<string, PrototypeBuild['clientFeedback']>();
  for (const d of (decisions.data ?? []) as { ui_version_id: string; decision: string; client_words: string; created_at: string }[]) {
    feedbackOf.set(d.ui_version_id, [...(feedbackOf.get(d.ui_version_id) ?? []), { decision: d.decision, clientWords: d.client_words, createdAt: d.created_at }]);
  }
  const revisionsOf = new Map<string, number>();
  for (const r of rows) revisionsOf.set(r.ui_version_id, (revisionsOf.get(r.ui_version_id) ?? 0) + 1);

  return rows.flatMap((r) => {
    const d = deliverableOf.get(r.deliverable_id);
    if (!d) return [];
    return [
      {
        artifactId: r.id,
        deliverableId: r.deliverable_id,
        uiVersionId: r.ui_version_id,
        uiVersion: versionOf.get(r.ui_version_id) ?? null,
        version: d.version,
        title: d.title,
        status: d.status,
        artifactUrl: d.artifact_url,
        platform: r.platform,
        screensCount: Array.isArray(r.screens) ? r.screens.length : 0,
        revisionCount: revisionsOf.get(r.ui_version_id) ?? 1,
        qaSubmittedAt: r.qa_submitted_at,
        qaReviewedAt: r.qa_reviewed_at,
        qaFindings: (r.qa_findings ?? null) as PrototypeBuild['qaFindings'],
        clientFeedback: feedbackOf.get(r.ui_version_id) ?? [],
        createdAt: r.created_at,
      },
    ];
  });
}
