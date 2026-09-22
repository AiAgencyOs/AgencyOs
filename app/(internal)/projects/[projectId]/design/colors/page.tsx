import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, readDesignTrail } from '@/modules/projects/queries';
import { Badge, PageHeader } from '@/ui';

import { ProjectSubNav } from '../../project-subnav';
import { DesignSubNav } from '../design-subnav';
import { GATE_TONE, Nothing, Section } from '../design-shared';

export const metadata: Metadata = { title: 'Color studio' };

/**
 * Color Studio — the palettes drawn against each theme direction, split out
 * of the original design page's per-theme colour swatches (Master §8).
 *
 * Read-only by design: `projects.color_options` has no direct admin write
 * path of its own — a palette's `client_status` moves only through the same
 * share/reply loop that moves its theme's `client_status` (recorded on the
 * Final selection tab), and generation is agent-only
 * (`record_color_option`, called from the workflow, never from this UI). A
 * "create palette" form here would be inventing a write surface the backend
 * does not offer.
 */
export default async function ProjectColorsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/design/colors`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const trail = await readDesignTrail(projectId);
  const { phase } = trail;

  if (!phase) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Color studio" description={`${project.name} — Phase 3.`} />
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

  const themesWithColors = trail.themes.filter((t) => t.colors.length > 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Color studio"
        description={`${project.name} — every palette drawn, grouped by the theme direction it belongs to.`}
      />

      <ProjectSubNav projectId={projectId} />
      <DesignSubNav projectId={projectId} />

      <Section
        title="Color combinations"
        hint="Roughly 2–3 per theme direction, per Master §8. A palette's client status follows its theme's — see the Themes and Final selection tabs for the review and share history."
      >
        {trail.themes.length === 0 ? (
          <Nothing>No theme options have been generated yet.</Nothing>
        ) : themesWithColors.length === 0 ? (
          <Nothing>No palette has been drawn against any theme direction yet.</Nothing>
        ) : (
          <div className="flex flex-col gap-3">
            {themesWithColors.map((t) => (
              <div key={t.id} className="flex flex-col gap-2 rounded-md border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold">
                    {t.optionIndex}. {t.name}
                  </span>
                  <Badge tone={GATE_TONE[t.adminStatus] ?? 'neutral'}>admin: {t.adminStatus.replace(/_/g, ' ')}</Badge>
                  <Link
                    href={`/projects/${projectId}/design/themes`}
                    className="text-xs underline hover:text-fg"
                  >
                    the direction it belongs to
                  </Link>
                </div>
                <div className="flex flex-col gap-1">
                  {t.colors.map((c) => (
                    <div key={c.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                      <span className="flex gap-1" aria-hidden>
                        {c.swatches.map((hex, i) => (
                          <span
                            key={`${c.id}-${i}`}
                            className="inline-block h-4 w-4 rounded-sm border border-line"
                            style={{ backgroundColor: hex }}
                          />
                        ))}
                      </span>
                      <span>{c.paletteName}</span>
                      <Badge tone={GATE_TONE[c.clientStatus] ?? 'neutral'}>{c.clientStatus.replace(/_/g, ' ')}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
