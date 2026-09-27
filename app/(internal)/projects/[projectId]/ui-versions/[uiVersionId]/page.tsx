import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, getUiVersionDetail } from '@/modules/projects/queries';
import { Badge, Card, EmptyState, IconProjects, PageHeader, humanize } from '@/ui';

export const metadata: Metadata = { title: 'UI version' };

/**
 * The internal review surface for one UI Designer draft — UID §18's "UI
 * Versions" Admin surface, and the other half of the Coverage Matrix
 * (`phase-four-panel.tsx`): that grid answers WHICH screens and states
 * exist; this answers what was actually proposed for each —
 * `layoutSummary`, `keyComponents`, `statesAddressed` — real content nothing
 * in the Admin Panel showed before this. `readPhaseFourOverview` only ever
 * surfaced a screen count.
 *
 * Staff-only, matching the identical, already-reviewed boundary the
 * prototype preview page (`prototype/preview/[uiVersionId]/page.tsx`) draws
 * for the same reason: no client-facing renderer route exists yet, named
 * rather than silently assumed done.
 *
 * Renders nothing but plain strings and arrays React already escapes —
 * `layoutSummary`/`keyComponents`/`statesAddressed` are validated JSON
 * (`uiVersionDraftSchema`) written by the model, never markup, and this page
 * has no raw-HTML escape hatch anywhere in it because nothing here needs one.
 */
export default async function UiVersionDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; uiVersionId: string }>;
}) {
  const { projectId, uiVersionId } = await params;

  const context = await requireInternal(`/projects/${projectId}/ui-versions/${uiVersionId}`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const version = await getUiVersionDetail(uiVersionId);
  if (!version || version.projectId !== projectId) notFound();

  const findings = version.qaFindings;
  const hasFindings = Boolean(
    findings && ((findings.missingScreens?.length ?? 0) > 0 || (findings.stateGaps?.length ?? 0) > 0),
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — UI version ${version.version}`}
        description="What the UI Designer proposed for each locked screen — a direction to judge, not a production spec."
        meta={
          !version.qaReviewedAt ? (
            <Badge tone="warning">QA not reviewed yet</Badge>
          ) : hasFindings ? (
            <Badge tone="danger">QA found gaps</Badge>
          ) : (
            <Badge tone="success">QA passed</Badge>
          )
        }
      />

      <div className="flex items-center gap-3">
        <Link href={`/projects/${projectId}`} className="text-sm text-muted underline underline-offset-2">
          Back to project
        </Link>
        <Badge tone="neutral">{humanize(version.status)}</Badge>
      </div>

      {hasFindings ? (
        <Card className="border-danger/40 p-4">
          <p className="text-sm font-medium text-danger">Design QA found coverage gaps</p>
          {(findings?.missingScreens?.length ?? 0) > 0 ? (
            <p className="mt-1 text-sm text-muted">Missing screens: {findings?.missingScreens?.join(', ')}</p>
          ) : null}
          {(findings?.stateGaps?.length ?? 0) > 0 ? (
            <ul className="mt-1 list-disc pl-5 text-sm text-muted">
              {findings?.stateGaps?.map((gap, i) => <li key={i}>{gap}</li>)}
            </ul>
          ) : null}
        </Card>
      ) : null}

      {version.screens.length > 0 ? (
        <div className="flex flex-col gap-3">
          {version.screens.map((screen) => (
            <Card key={screen.screenKey} className="flex flex-col gap-2 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">{screen.screenKey}</span>
                {screen.statesAddressed.map((state) => (
                  <Badge key={state} tone="neutral">
                    {humanize(state)}
                  </Badge>
                ))}
              </div>
              <p className="text-sm text-muted">{screen.layoutSummary}</p>
              <div className="flex flex-wrap gap-1">
                {screen.keyComponents.map((component, i) => (
                  <span key={i} className="rounded-md bg-surface-hover px-2 py-0.5 text-xs text-muted">
                    {component}
                  </span>
                ))}
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState icon={<IconProjects size={22} />} title="No screens in this draft" description="" />
      )}
    </div>
  );
}
