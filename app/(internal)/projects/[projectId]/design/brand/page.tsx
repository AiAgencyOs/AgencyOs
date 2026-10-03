import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readBrandRules } from '@/modules/projects/brand-kit-queries';
import { readDesignAssetVersions, type DesignAssetsRead } from '@/modules/projects/design-asset-queries';
import { BRAND_KIT_KINDS } from '@/modules/projects/design-asset-schema';
import { getProject } from '@/modules/projects/queries';
import { Badge, Card, CardHeader, EmptyState, IconFile, IconPalette, PermissionDenied, Stat, StatGrid } from '@/ui';

import { ProjectSubNav } from '../../project-subnav';
import { WorkspaceHeader } from '../../workspace-header';
import { ApproveAssetButton, UploadDesignAssetPanel } from '../design-asset-panels';
import { DesignSubNav } from '../design-subnav';
import { AddBrandRuleForm, RemoveBrandRuleButton } from './brand-forms';

export const metadata: Metadata = { title: 'Brand kit' };

const KIND_TITLE = { logo: 'Logos', icon: 'Icons', font: 'Fonts' } as const;
const DEFAULT_RIGHTS = 'Uploaded by a person; rights as the uploader holds them.';

/**
 * The Brand Kit — SCR-038. The logos, icons and fonts a project is built with
 * (design assets of those kinds) and its written brand rules. Every asset shows
 * the licence it was uploaded with, or says none is recorded: a licensed font
 * nobody noted the terms of is how a client gets an invoice later. Uploads go
 * through the same asset door as the Design overview (storage first, then the
 * row), brand rules through `projects.add_brand_rule`.
 */
export default async function BrandKitPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const context = await requireInternal(`/projects/${projectId}/design/brand`);
  if (!can(context, 'project.read')) return <PermissionDenied />;
  const project = await getProject(projectId);
  if (!project) notFound();

  const [clock, clientName, library, rules] = await Promise.all([
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
    readDesignAssetVersions(projectId, context.organizationId ?? null),
    readBrandRules(projectId),
  ]);
  const mayWrite = can(context, 'project.write');
  const families = (kind: string) => library.families.filter((f) => f.kind === kind);
  const brandFamilies = library.families.filter((f) => (BRAND_KIT_KINDS as readonly string[]).includes(f.kind));
  const unlicensed = brandFamilies.filter((f) => !f.latest.rightsNote || f.latest.rightsNote === DEFAULT_RIGHTS).length;
  const storage: DesignAssetsRead['storage'] = library.storage;

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={mayWrite} />
      <ProjectSubNav projectId={projectId} />
      <DesignSubNav projectId={projectId} />

      <StatGrid cols={4}>
        <Stat label="Logos" value={String(families('logo').length)} tone="brand" icon={<IconPalette size={16} />} />
        <Stat label="Icons" value={String(families('icon').length)} tone="brand" icon={<IconFile size={16} />} />
        <Stat label="Fonts" value={String(families('font').length)} tone="brand" icon={<IconFile size={16} />} />
        <Stat label="No licence recorded" value={String(unlicensed)} caption={brandFamilies.length === 0 ? 'Nothing uploaded yet' : 'of the brand assets'} tone={unlicensed > 0 ? 'warning' : 'success'} />
      </StatGrid>

      {(['logo', 'icon', 'font'] as const).map((kind) => (
        <Card key={kind}>
          <CardHeader title={`${KIND_TITLE[kind]} (${families(kind).length})`} description={kind === 'font' ? 'Font files the project is licensed to use, with the licence beside each.' : `The project's ${kind}s, with versions and the licence each was uploaded under.`} />
          {families(kind).length === 0 ? (
            <EmptyState title={`No ${kind} uploaded`} description={`Upload the first ${kind} below; it starts as a draft until a person approves it.`} />
          ) : (
            <ul className="grid gap-3 px-4 pb-4 sm:grid-cols-2 sm:px-5 xl:grid-cols-3">
              {families(kind).map((f) => {
                const a = f.latest;
                const licence = a.rightsNote && a.rightsNote !== DEFAULT_RIGHTS ? a.rightsNote : null;
                return (
                  <li key={f.familyId} className="flex flex-col gap-2 rounded-lg border border-line p-3 text-[13px]">
                    {a.previewUrl && kind !== 'font' && a.mediaType !== 'application/pdf' ? (
                      <img src={a.previewUrl} alt={a.title} className="h-24 w-full rounded-md border border-line bg-surface-sunken object-contain" />
                    ) : (
                      <span className="flex h-24 items-center justify-center rounded-md border border-line bg-surface-sunken px-2 text-center text-xs text-muted">{kind === 'font' ? a.mediaType.replace('font/', '').toUpperCase() : 'No preview available'}</span>
                    )}
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 truncate font-medium">{a.title}</span>
                      <Badge tone="neutral">v{a.version}</Badge>
                      <Badge tone={a.status === 'approved' ? 'success' : 'neutral'}>{a.status}</Badge>
                    </span>
                    <p className={licence ? 'text-xs text-muted' : 'text-xs text-warning'}>{licence ? `Licence: ${licence}` : 'No licence recorded.'}</p>
                    <span className="text-xs text-muted">Uploaded {clock.date(a.createdAt)}</span>
                    {mayWrite && a.status !== 'approved' ? <ApproveAssetButton projectId={projectId} assetId={a.id} /> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      ))}

      {mayWrite ? (
        <Card>
          <CardHeader title="Upload to the brand kit" description="A logo, an icon or a font file. Record the licence: who owns it and what the client may do with it." />
          <div className="px-4 pb-4 sm:px-5">
            <UploadDesignAssetPanel projectId={projectId} storage={storage} kinds={BRAND_KIT_KINDS} />
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader title={`Brand Rules (${rules.length})`} description="The written rules every screen and asset must follow." />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          {rules.length === 0 ? (
            <p className="text-[13px] text-muted">No brand rule is written for this project.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {rules.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-line px-3 py-2 text-[13px]">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{r.title}</span>
                    <span className="block whitespace-pre-wrap text-muted">{r.rule}</span>
                  </span>
                  {mayWrite ? <RemoveBrandRuleButton projectId={projectId} ruleId={r.id} title={r.title} /> : null}
                </li>
              ))}
            </ul>
          )}
          {mayWrite ? <AddBrandRuleForm projectId={projectId} /> : null}
        </div>
      </Card>
    </div>
  );
}
