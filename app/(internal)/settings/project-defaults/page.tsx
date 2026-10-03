import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { folderLines } from '@/modules/projects/org-project-defaults-schema';
import { readOrgProjectDefaults } from '@/modules/projects/org-project-defaults-queries';
import { Card, CardHeader } from '@/ui';

import { ProjectDefaultsForm } from './defaults-form';

export const metadata: Metadata = { title: 'Project Defaults' };

/**
 * Settings › Project defaults (PDF §7, SCR-071): the organisation-wide
 * defaults a new project starts from. Two are editable (the phase changes a
 * new watcher follows, the standard folder structure) through one door,
 * `projects.set_project_defaults`. The third, the WhatsApp group-name
 * pattern, is shown read-only: it is the PDF's fixed pattern and changing it
 * would rename groups people already belong to (an owner question, recorded).
 */
export default async function ProjectDefaultsPage() {
  const context = await requireInternal('/settings/project-defaults');
  const [defaults, clock] = await Promise.all([readOrgProjectDefaults(), agencyClock()]);
  const mayEdit = can(context, 'organization.settings');

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          title="Project Defaults"
          description={defaults.updatedAt ? `Last saved ${clock.dateTime(defaults.updatedAt)}.` : 'Nothing saved yet: new watchers are offered all four phase changes and new projects start with no standard folders.'}
        />
        <div className="px-4 pb-4 sm:px-5">
          <ProjectDefaultsForm watchPhases={defaults.watchPhases} folderText={folderLines(defaults.folders)} mayEdit={mayEdit} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Project Group Name" description="Every project’s WhatsApp group is named from the same four parts, in this order." />
        <div className="flex flex-col gap-2 px-4 pb-4 text-[13px] sm:px-5">
          <p className="font-mono text-foreground">project // price // start date // client</p>
          <p className="text-muted">
            The pattern is fixed. The owner’s own trailing word is set under{' '}
            <Link href="/settings/team#project-group-names" className="text-brand underline underline-offset-2">Settings › Team</Link>.
          </p>
        </div>
      </Card>
    </div>
  );
}
