import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, getPrototypeArtifactByUiVersion } from '@/modules/projects/queries';
import { Badge, Card, EmptyState, IconProjects, PageHeader, PermissionDenied } from '@/ui';

import { PrototypeScreenView } from '@/ui/prototype-screen-view';

export const metadata: Metadata = { title: 'Prototype preview' };

/**
 * The internal review surface for one Prototype Agent build — PROTO §12,
 * §13; QAP §7; `docs/phase-4-gap-analysis.md` step 4.
 *
 * This is what `record_prototype_build`'s `artifact_url` points at, and what
 * an Admin opens before deciding whether to click "Submit for review" on the
 * existing `/prototype` page — the human gate PROTO/Impl name stays exactly
 * that click, informed by the QA findings shown here rather than bypassed by
 * them.
 *
 * A client-facing equivalent now exists at
 * `app/(client)/portal/[projectId]/prototype/[uiVersionId]/page.tsx`, reusing
 * `prototype_artifacts`' own RLS policy (which already admitted a client
 * scoped to their own project) and the same `PrototypeScreenView` renderer.
 * It shows fewer columns than this page does — no `qa_findings`/
 * `qa_reviewed_at`, which stay internal review detail.
 */
export default async function PrototypePreviewPage({
  params,
}: {
  params: Promise<{ projectId: string; uiVersionId: string }>;
}) {
  const { projectId, uiVersionId } = await params;

  const context = await requireInternal(`/projects/${projectId}/prototype/preview/${uiVersionId}`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const artifact = await getPrototypeArtifactByUiVersion(uiVersionId);
  if (!artifact || artifact.projectId !== projectId) notFound();

  const findings = artifact.qaFindings;
  const hasFindings = Boolean(
    findings &&
      ((findings.missingScreens?.length ?? 0) > 0 ||
        (findings.brokenRoutes?.length ?? 0) > 0 ||
        (findings.secretFindings?.length ?? 0) > 0),
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — Prototype preview`}
        description="A review prototype, not the finished product. Mock data throughout."
        meta={
          !artifact.qaReviewedAt ? (
            <Badge tone="warning">QA not reviewed yet</Badge>
          ) : hasFindings ? (
            <Badge tone="danger">QA found issues</Badge>
          ) : (
            <Badge tone="success">QA passed</Badge>
          )
        }
      />

      <Link href={`/projects/${projectId}/prototype`} className="text-sm text-muted underline underline-offset-2">
        Back to Prototype
      </Link>

      {hasFindings ? (
        <Card className="border-danger/40 p-4">
          <p className="text-sm font-medium text-danger">Design QA found coverage gaps</p>
          {(findings?.missingScreens?.length ?? 0) > 0 ? (
            <p className="mt-1 text-sm text-muted">
              Missing screens: {findings?.missingScreens?.join(', ')}
            </p>
          ) : null}
          {(findings?.brokenRoutes?.length ?? 0) > 0 ? (
            <p className="mt-1 text-sm text-muted">
              Broken navigation targets: {findings?.brokenRoutes?.join(', ')}
            </p>
          ) : null}
          {(findings?.secretFindings?.length ?? 0) > 0 ? (
            <p className="mt-1 text-sm text-muted">
              Security FAIL — looks like real credentials:{' '}
              {findings?.secretFindings
                ?.map((f) => `${f.screenKey} element ${f.elementIndex} (${f.pattern})`)
                .join('; ')}
            </p>
          ) : null}
        </Card>
      ) : null}

      {artifact.screens.length > 0 ? (
        <PrototypeScreenView screens={artifact.screens} />
      ) : (
        <EmptyState icon={<IconProjects size={22} />} title="No screens in this build" description="" />
      )}
    </div>
  );
}
