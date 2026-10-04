import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createAdminClient } from '@/lib/db/admin';
import { buildFigmaExport } from '@/modules/projects/figma-export';
import { listFigmaImports } from '@/modules/projects/figma-queries';
import { getProject } from '@/modules/projects/queries';
import { Callout, Card, CardHeader, PermissionDenied } from '@/ui';

import { ProjectSubNav } from '../../project-subnav';
import { WorkspaceHeader } from '../../workspace-header';
import { DesignSubNav } from '../design-subnav';
import { FigmaCodeForm } from './figma-code-form';

export const metadata: Metadata = { title: 'Figma plugin' };

/**
 * Putting the finalized screens into Figma. AgencyOS cannot create nodes in Figma (its API reads and comments only), so a small
 * plugin does it from inside Figma: it reads this project's finalized screens and selected direction with a signed code, draws a
 * wireframe frame per screen (and per state), and reports which frames it made. A person then links the frame to its screen
 * through the existing verified flow - the plugin's report links nothing by itself.
 */
export default async function FigmaPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const context = await requireInternal(`/projects/${projectId}/design/figma`);
  if (!can(context, 'project.read')) return <PermissionDenied />;
  const project = await getProject(projectId);
  if (!project) notFound();
  const organizationId = context.organizationId;
  if (!organizationId) return <PermissionDenied />;
  const mayCreate = can(context, 'project.write');
  const [exported, imports, clock, clientName] = await Promise.all([
    buildFigmaExport(createAdminClient(), { organizationId, projectId }),
    listFigmaImports(projectId),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
  ]);
  const screens = exported?.screens.length ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={mayCreate} />
      <ProjectSubNav projectId={projectId} />
      <DesignSubNav projectId={projectId} />

      {screens === 0 ? (
        <Callout tone="warning" title="No finalized screens yet">
          The plugin draws only the screen list a person has finalized. Finalize it on the Screens tab first.
        </Callout>
      ) : (
        <Callout tone="info" title={`${screens} finalized screen${screens === 1 ? '' : 's'} ready`}>
          {exported?.direction ? `Direction: ${exported.direction.name} (${exported.direction.chosenBy === 'locked' ? 'locked by the client' : 'selected by the client'}).` : 'No direction is selected yet, so the frames use neutral colours.'}
        </Callout>
      )}

      <Card>
        <CardHeader title="Install the plugin (once)" description="In the Figma desktop app." />
        <ol className="list-decimal space-y-1 px-8 pb-4 text-[13px] text-muted">
          <li>Open any Figma design file. Menu → Plugins → Development → Import plugin from manifest…</li>
          <li>
            Choose <code className="font-mono text-xs">figma-plugin/manifest.json</code> from the AgencyOS repository.
          </li>
          <li>
            Before sharing it with anyone else, replace <code className="font-mono text-xs">&quot;*&quot;</code> in that manifest&apos;s <code className="font-mono text-xs">networkAccess</code> with your deployment&apos;s address.
          </li>
        </ol>
      </Card>

      <Card>
        <CardHeader title="Import the screens" description="Each run adds a new page, so nothing in the file is overwritten." />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          <ol className="list-decimal space-y-1 pl-4 text-[13px] text-muted">
            <li>Create a plugin code below.</li>
            <li>In Figma: Plugins → Development → AgencyOS Design Import. Paste the address, project id and code.</li>
            <li>Press Import screens. A page appears with the direction (palette and type) and one frame per screen, plus a frame for each state the screen must handle.</li>
          </ol>
          {mayCreate ? <FigmaCodeForm projectId={projectId} /> : <p className="text-xs text-muted">Creating a code needs edit access to the project.</p>}
        </div>
      </Card>

      <Card>
        <CardHeader title="What the plugin has built" description="A record of each run. It links nothing: link a frame to its screen on the Screens tab, where Figma is asked that the frame exists." />
        {imports.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">The plugin has not reported anything yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {imports.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px] sm:px-5">
                <span>
                  {i.frameCount} frame{i.frameCount === 1 ? '' : 's'}
                  {i.pageName ? ` on “${i.pageName}”` : ''}
                </span>
                <span className="flex items-center gap-3 text-xs text-muted">
                  {i.fileKey ? (
                    <a href={`https://www.figma.com/design/${i.fileKey}`} target="_blank" rel="noreferrer" className="text-brand underline-offset-2 hover:underline">
                      open in Figma
                    </a>
                  ) : null}
                  {clock.dateTime(i.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
