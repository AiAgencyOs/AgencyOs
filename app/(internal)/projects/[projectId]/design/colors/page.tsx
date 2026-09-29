import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readDesignAssetVersions } from '@/modules/projects/design-asset-queries';
import { readDirectionSources } from '@/modules/projects/design-direction-queries';
import { getProject, readDesignTrail } from '@/modules/projects/queries';
import { Badge, IconCheck, IconPalette, IconSparkle, IconUpload, PageHeader, PermissionDenied, Stat, StatGrid } from '@/ui';

import { ProjectSubNav } from '../../project-subnav';
import { UploadDesignAssetPanel } from '../design-asset-panels';
import { DesignSubNav } from '../design-subnav';
import { GATE_TONE, Nothing, Section } from '../design-shared';
import { RecordDirectionPanel, RecordVariantPanel } from './direction-panels';

export const metadata: Metadata = { title: 'Color studio' };

/**
 * Color Studio — the palettes drawn against each theme direction, split out
 * of the original design page's per-theme colour swatches (Master §8).
 *
 * `projects.color_options`' client_status moves only through the same
 * share/reply loop that moves its theme's (recorded on the Final selection
 * tab). Bucket F (migration 20261001130000) gave a person two doors here:
 * record a theme direction and record a colour variant beside the
 * generated ones (`source` = generated | recorded), under the same 2–3
 * ceiling the agent's door enforces. Generation itself stays the agent's:
 * there is no door for a person to trigger it, and the page says so. The
 * reference uploads are SCR-038's asset lifecycle, fixed to kind
 * `reference`, into bucket E's storage.
 */
export default async function ProjectColorsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/design/colors`);
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const trail = await readDesignTrail(projectId);
  const { phase } = trail;
  const mayDecide = can(context.role, 'project.write');

  if (!phase) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Color studio" description={`${project.name} — Phase 3.`} />
        <ProjectSubNav projectId={projectId} />
        <DesignSubNav projectId={projectId} />
        <Nothing>
          Phase 3 has not started for this project.{' '}
          <Link href={`/projects/${projectId}/design`} className="underline hover:text-foreground">
            Back to Design
          </Link>
          .
        </Nothing>
      </div>
    );
  }

  const [sources, assetLibrary, clock] = await Promise.all([readDirectionSources(projectId), readDesignAssetVersions(projectId, context.organizationId ?? null), agencyClock()]);

  const themesWithColors = trail.themes.filter((t) => t.colors.length > 0);
  // SCR-033 — the counts as counts.
  const palettes = trail.themes.flatMap((t) => t.colors);
  const recordedThemes = trail.themes.filter((t) => sources.themeSource.get(t.id) === 'recorded').length;
  const recordedPalettes = palettes.filter((c) => sources.colorSource.get(c.id) === 'recorded').length;
  const references = assetLibrary.families.filter((f) => f.kind === 'reference');
  const nextThemeIndex = Math.max(0, ...sources.takenThemeIndexes) + 1;
  const variantTargets = trail.themes.map((t) => ({ id: t.id, name: t.name, nextIndex: Math.max(0, ...(sources.takenColorIndexes.get(t.id) ?? [])) + 1 }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Color studio"
        description={`${project.name} — every palette drawn, grouped by the theme direction it belongs to.`}
      />

      <ProjectSubNav projectId={projectId} />
      <DesignSubNav projectId={projectId} />

      <StatGrid cols={4}>
        <Stat label="Color combinations" value={String(palettes.length)} caption={trail.themes.length > 0 ? `across ${trail.themes.length} direction${trail.themes.length === 1 ? '' : 's'} · ${recordedPalettes} recorded by a person` : 'No direction yet'} tone="accent" icon={<IconPalette size={16} />} href="#combinations" />
        <Stat label="Theme directions" value={String(trail.themes.length)} caption={`${trail.themes.length - recordedThemes} generated · ${recordedThemes} recorded${sources.themeLimit !== null ? ` · ceiling ${sources.themeLimit}` : ''}`} tone="brand" icon={<IconSparkle size={16} />} href={`/projects/${projectId}/design/themes`} />
        <Stat label="Selected by the client" value={String(palettes.filter((c) => c.clientStatus === 'selected' || c.clientStatus === 'locked').length)} caption="palettes selected or locked" tone="success" icon={<IconCheck size={16} />} href={`/projects/${projectId}/design/final`} />
        <Stat label="Reference uploads" value={String(references.length)} caption={references.length > 0 ? `${references.filter((f) => f.latest.status === 'approved').length} approved` : 'none uploaded'} tone={references.length > 0 ? 'info' : 'neutral'} icon={<IconUpload size={16} />} href="#reference-uploads" />
      </StatGrid>

      <Section
        title="Color combinations"
        hint="Roughly 2–3 per theme direction, per Master §8. A palette's client status follows its theme's — see the Themes and Final selection tabs for the review and share history."
      >
        <div id="combinations" className="scroll-mt-4" />
        {trail.themes.length === 0 ? (
          <Nothing>No theme options have been generated or recorded yet.</Nothing>
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
                  <Badge tone={sources.themeSource.get(t.id) === 'recorded' ? 'info' : 'neutral'}>{sources.themeSource.get(t.id) ?? 'generated'}</Badge>
                  <Badge tone={GATE_TONE[t.adminStatus] ?? 'neutral'}>admin: {t.adminStatus.replace(/_/g, ' ')}</Badge>
                  <Link
                    href={`/projects/${projectId}/design/themes`}
                    className="text-xs underline hover:text-foreground"
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
                      {sources.colorSource.get(c.id) === 'recorded' ? <Badge tone="info">recorded</Badge> : null}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* SCR-033 — generate / record 2–3 directions and variants. Recording is a person's door; generating is the agent's. */}
      <Section
        title="Directions and variants"
        hint="The agent generates directions from the finalized screen baseline. A person records more here — a direction, or a colour variant against one — under the same ceiling, and each is marked as recorded."
      >
        {mayDecide ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <RecordDirectionPanel projectId={projectId} nextIndex={nextThemeIndex} limit={sources.themeLimit} taken={trail.themes.length} />
            <RecordVariantPanel projectId={projectId} themes={variantTargets} />
          </div>
        ) : (
          <Nothing>An owner, ops admin or delivery lead records a direction or a variant.</Nothing>
        )}
      </Section>

      {/* SCR-033 — reference uploads: the asset lifecycle, fixed to kind `reference`. */}
      <Section
        title="Reference uploads"
        hint="Client references and mood images a person uploaded (bucket E's storage). Each is a draft until approved on the Design overview, where its versions and links live."
      >
        <div id="reference-uploads" className="scroll-mt-4" />
        {mayDecide ? <UploadDesignAssetPanel projectId={projectId} storage={assetLibrary.storage} fixedKind="reference" /> : null}
        {references.length === 0 ? (
          <Nothing>No reference has been uploaded.</Nothing>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {references.map((f) => (
              <li key={f.familyId} className="flex flex-col gap-1 rounded-md border border-line p-2 text-[13px]">
                {f.latest.previewUrl && f.latest.mediaType !== 'application/pdf' ? (
                  <img src={f.latest.previewUrl} alt={f.title} className="aspect-video w-full rounded object-cover" />
                ) : (
                  <span className="flex aspect-video items-center justify-center rounded bg-surface-sunken text-xs text-muted">{f.latest.previewUrl ? 'PDF' : 'preview unavailable'}</span>
                )}
                <span className="truncate font-medium">{f.title}</span>
                <span className="flex items-center gap-1 text-xs text-muted">
                  <Badge tone={f.latest.status === 'approved' ? 'success' : 'neutral'}>{f.latest.status}</Badge>v{f.latest.version} · {clock.date(f.latest.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Link href={`/projects/${projectId}/design#design-assets`} className="text-xs underline hover:text-foreground">
          Approve, replace or link a reference on the Design overview
        </Link>
      </Section>
    </div>
  );
}
