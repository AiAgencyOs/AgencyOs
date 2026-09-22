import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  getProject,
  readDesignTrail,
  readSampleScreens,
  readTokenSets,
} from '@/modules/projects/queries';
import { figmaConfigured } from '@/lib/figma/client';
import { Badge, PageHeader } from '@/ui';

import { ProjectSubNav } from '../../project-subnav';
import { DesignSubNav } from '../design-subnav';
import {
  AdminDecisionForm,
  FigmaReferenceForm,
  InternalReviewForm,
  RecordSampleForm,
  TokenSetForm,
} from '../design-forms';
import { GATE_TONE, Nothing, Section, when } from '../design-shared';

export const metadata: Metadata = { title: 'Theme studio' };

/**
 * Theme Studio — the designer → internal review → Admin queue, split out of
 * the original design page's "Theme and colour options" section (Master
 * §8, §10). Colour palettes moved to their own Colors tab; everything here
 * is per-theme: direction, Figma reference, token set, sample screens and the
 * two review gates.
 *
 * Same discipline as the page this was split from: every gate renders the
 * STORED status, and a form is offered only where that status makes one
 * meaningful — the doors re-check every rule regardless.
 */
export default async function ProjectThemesPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/design/themes`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const trail = await readDesignTrail(projectId);
  const { phase } = trail;
  const mayDecide = can(context.role, 'project.write');

  if (!phase) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Theme studio" description={`${project.name} — Phase 3.`} />
        <ProjectSubNav projectId={projectId} />
        <DesignSubNav projectId={projectId} />
        <Nothing>
          Phase 3 has not started for this project.{' '}
          <Link href={`/projects/${projectId}/design`} className="underline hover:text-fg">
            Back to Design
          </Link>
          .
        </Nothing>
      </div>
    );
  }

  const { samples, coverage, approvedScreens } = await readSampleScreens(
    projectId,
    trail.themes.map((t) => t.id),
  );
  const tokenSets = await readTokenSets(projectId);
  // Whether a token exists, never its value. The form's wording changes with
  // it, because a deployment that cannot check a reference must not imply it
  // did.
  const figmaReady = figmaConfigured();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Theme studio"
        description={`${project.name} — every theme option generated, its Figma reference and where it stands at each gate.`}
      />

      <ProjectSubNav projectId={projectId} />
      <DesignSubNav projectId={projectId} />

      <Section title="Theme options">
        {trail.themes.length === 0 ? (
          <Nothing>No theme options have been generated.</Nothing>
        ) : (
          <div className="flex flex-col gap-3">
            {trail.themes.map((t) => (
              <div key={t.id} className="flex flex-col gap-2 rounded-md border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold">
                    {t.optionIndex}. {t.name}
                  </span>
                  <span className="text-xs text-muted">v{t.version} · {t.origin.replace(/_/g, ' ')}</span>
                </div>
                <p className="max-w-2xl text-[13px] text-muted">{t.directionSummary}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={GATE_TONE[t.internalReviewStatus] ?? 'neutral'}>
                    internal: {t.internalReviewStatus.replace(/_/g, ' ')}
                  </Badge>
                  <Badge tone={GATE_TONE[t.adminStatus] ?? 'neutral'}>
                    admin: {t.adminStatus.replace(/_/g, ' ')}
                  </Badge>
                  <Badge tone={GATE_TONE[t.clientStatus] ?? 'neutral'}>
                    client: {t.clientStatus.replace(/_/g, ' ')}
                  </Badge>
                  <Link
                    href={`/projects/${projectId}/design/colors`}
                    className="text-xs underline hover:text-fg"
                  >
                    its colour options
                  </Link>
                </div>
                <p className="text-[13px] text-muted">
                  {t.figmaNodeId ? (
                    <>
                      Figma node <code className="text-fg">{t.figmaNodeId}</code>
                      {t.figmaVersion ? ` · version ${t.figmaVersion}` : ''}
                    </>
                  ) : t.previewAssetUrl ? (
                    'Preview only — no Figma reference recorded. Figma is the canonical artifact for Phase 4.'
                  ) : (
                    'Nothing to show yet: no Figma reference and no preview.'
                  )}
                </p>
                {/* Designer §8, §24 — the canonical artifact, recorded and where possible checked. */}
                {mayDecide ? (
                  <FigmaReferenceForm
                    projectId={projectId}
                    themeOptionId={t.id}
                    configured={figmaReady}
                    current={{
                      fileKey: t.figmaFileKey,
                      nodeId: t.figmaNodeId,
                      version: t.figmaVersion,
                      nodeName: t.figmaNodeName,
                      verifiedAt: t.figmaVerifiedAt,
                    }}
                  />
                ) : null}

                {/* Designer §4.5, §19 — what Phase 4 inherits from this direction. */}
                {mayDecide ? (
                  <TokenSetForm
                    projectId={projectId}
                    themeOptionId={t.id}
                    current={tokenSets.find((ts) => ts.themeOptionId === t.id) ?? null}
                  />
                ) : null}

                {/*
                  Designer §7 — the samples that demonstrate this direction,
                  and what §7 asks for that is still unsampled. The unmet list
                  is a REPORT: §7 hedges both of its "at least one" rules with
                  "when applicable", so nothing here refuses on it.
                */}
                {(() => {
                  const mine = samples.filter((sc) => sc.themeOptionId === t.id);
                  const cov = coverage.find((c) => c.themeOptionId === t.id);
                  return (
                    <div className="flex flex-col gap-1 border-t border-line pt-2">
                      <span className="text-xs text-muted">Sample screens ({mine.length})</span>
                      {mine.length === 0 ? (
                        <p className="text-[13px] text-muted">
                          Nothing is sampled yet, so there is nothing to judge this direction on.
                        </p>
                      ) : (
                        <ul className="flex flex-col gap-1 text-[13px]">
                          {mine.map((sc) => (
                            <li key={sc.id} className="flex flex-wrap items-center gap-2">
                              <Badge tone="neutral">{sc.pattern}</Badge>
                              <span>
                                {sc.screenName}
                                {sc.screenKey ? ` (${sc.screenKey})` : ''}
                              </span>
                              {sc.decisionNote ? <span className="text-muted">— {sc.decisionNote}</span> : null}
                            </li>
                          ))}
                        </ul>
                      )}
                      {cov && cov.unmet.length > 0 ? (
                        <ul className="flex flex-col gap-0.5 text-[13px] text-muted">
                          {cov.unmet.map((u) => (
                            <li key={u}>· {u}</li>
                          ))}
                        </ul>
                      ) : null}
                      {mayDecide ? (
                        <RecordSampleForm
                          projectId={projectId}
                          themeOptionId={t.id}
                          approvedScreens={approvedScreens}
                        />
                      ) : null}
                    </div>
                  );
                })()}

                {/* §10's queues. Offered from the stored status; the doors decide. */}
                {mayDecide && t.internalReviewStatus !== 'passed' && t.adminStatus !== 'approved' ? (
                  <InternalReviewForm projectId={projectId} themeOptionId={t.id} />
                ) : null}
                {mayDecide && t.internalReviewStatus === 'passed' && t.adminStatus !== 'approved' ? (
                  <AdminDecisionForm projectId={projectId} themeOptionId={t.id} />
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* §8 — Internal Review */}
      <Section title="Internal review" hint="Reviewer result, comments and when — before Admin ever sees an option.">
        {trail.reviews.length === 0 ? (
          <Nothing>No internal review has been recorded.</Nothing>
        ) : (
          <ul className="flex flex-col gap-2">
            {trail.reviews.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 border-l-2 border-line pl-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={r.result === 'passed' ? 'success' : 'danger'}>{r.result.replace(/_/g, ' ')}</Badge>
                  <span className="text-muted">
                    {trail.themes.find((t) => t.id === r.themeOptionId)?.name ?? 'an option not in this phase'} · {when(r.createdAt)}
                  </span>
                </div>
                {r.comments ? <p className="max-w-2xl">{r.comments}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* §8 — Admin Decisions */}
      <Section title="Admin decisions" hint="CONFIRM and EDIT, with the reason. An edit returns the option to the designer and to internal review.">
        {trail.adminDecisions.length === 0 ? (
          <Nothing>No Admin decision has been recorded.</Nothing>
        ) : (
          <ul className="flex flex-col gap-2">
            {trail.adminDecisions.map((a) => (
              <li key={a.id} className="flex flex-col gap-1 border-l-2 border-line pl-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={a.decision === 'confirm' ? 'success' : 'warning'}>{a.decision}</Badge>
                  <span className="text-muted">
                    {trail.themes.find((t) => t.id === a.themeOptionId)?.name ?? 'an option not in this phase'} · {when(a.createdAt)}
                  </span>
                </div>
                {a.reason ? <p className="max-w-2xl">{a.reason}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
