import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listProjectFiles } from '@/modules/projects/queries';
import { PROJECT_FILE_CATEGORIES } from '@/modules/projects/schema';
import { Card, EmptyState, FilterBar, FilterChips, humanize, IconAttach, PageHeader } from '@/ui';

import { AddProjectFileForm, FileRow } from '../files-panel';
import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Files' };

/**
 * SCR-024 — Project Files. Confirmed genuinely missing by the traceability
 * sweep, and built on the pattern `projects.deliverables` already set rather
 * than a new one: a file here is a link to wherever the agency already keeps
 * it, never a blob in Supabase Storage (see the migration for the full case
 * — the short version is that this codebase decided that once already).
 */
export default async function ProjectFilesPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ category?: string }>;
}) {
  const { projectId } = await params;
  const { category } = await searchParams;

  const context = await requireInternal(`/projects/${projectId}/files`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const editable = can(context.role, 'project.write');
  const allFiles = await listProjectFiles(projectId);
  const files = category ? allFiles.filter((f) => f.category === category) : allFiles;

  const base = `/projects/${projectId}/files`;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — Files`}
        description={allFiles.length === 0 ? 'No files linked yet.' : `${allFiles.length} file${allFiles.length === 1 ? '' : 's'}.`}
      />

      <ProjectSubNav projectId={projectId} />

      {allFiles.length > 0 ? (
        <FilterBar>
          <FilterChips
            options={[
              { key: 'all', label: 'All', href: base, active: !category },
              ...PROJECT_FILE_CATEGORIES.map((c) => ({
                key: c,
                label: humanize(c),
                href: `${base}?category=${c}`,
                active: category === c,
              })),
            ]}
          />
        </FilterBar>
      ) : null}

      {files.length > 0 ? (
        <Card>
          <ul className="divide-y divide-line">
            {files.map((f) => (
              <FileRow key={f.id} file={f} projectId={projectId} editable={editable} />
            ))}
          </ul>
        </Card>
      ) : (
        <EmptyState
          icon={<IconAttach size={22} />}
          title={category ? 'No matching files' : 'No files yet'}
          description={
            category
              ? `No files are filed under “${humanize(category)}”.`
              : 'A file here is a link to wherever it already lives — a Drive folder, a Figma file, a build host.'
          }
        />
      )}

      {editable ? <AddProjectFileForm projectId={projectId} /> : null}
    </div>
  );
}
