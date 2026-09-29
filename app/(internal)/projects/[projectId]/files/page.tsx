import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listProjectFiles } from '@/modules/projects/queries';
import { PROJECT_FILE_CATEGORIES } from '@/modules/projects/schema';
import { ActivityFeed, Card, CardHeader, cx, EmptyState, humanize, IconAttach, IconFile, IconUpload, PermissionDenied, TONE_CHIP, type Tone } from '@/ui';

import { AddProjectFileForm, FileRow } from '../files-panel';
import { ProjectSubNav } from '../project-subnav';
import { WorkspaceHeader } from '../workspace-header';

export const metadata: Metadata = { title: 'Files' };

const FOLDER_TONES: Tone[] = ['info', 'accent', 'success', 'warning', 'danger', 'brand', 'neutral'];

/**
 * SCR-024 — Project Files, laid out as the reference: a folder tile per
 * category with its count, the file list under it, and a rail of recent
 * additions with the add form. Built on the pattern `projects.deliverables`
 * already set rather than a new one: a file here is a link to wherever the
 * agency already keeps it, never a blob in Supabase Storage (see the
 * migration for the full case). No sizes are shown because none are stored
 * — printing one would be a guess.
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
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const editable = can(context.role, 'project.write');
  const [allFiles, clock, clientName] = await Promise.all([
    listProjectFiles(projectId),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
  ]);
  const files = category ? allFiles.filter((f) => f.category === category) : allFiles;
  const countBy = (c: string) => allFiles.filter((f) => f.category === c).length;

  const base = `/projects/${projectId}/files`;

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader
        project={project}
        clock={clock}
        clientName={clientName}
        canEdit={can(context.role, 'project.write')}
        actions={
          editable ? (
            <a href="#add-file" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium shadow-xs hover:bg-surface-hover md:h-8">
              <IconUpload size={14} />
              Link a file
            </a>
          ) : null
        }
      />

      <ProjectSubNav projectId={projectId} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(18rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold tracking-tight">Folders</h2>
              <p className="text-xs text-muted">{allFiles.length} file{allFiles.length === 1 ? '' : 's'} linked</p>
            </div>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <li>
                <Link href={base} className={cx('flex flex-col gap-2 rounded-xl border bg-surface p-3 shadow-xs transition-colors hover:bg-surface-hover', !category ? 'border-brand/40' : 'border-line')}>
                  <span className={cx('flex h-9 w-9 items-center justify-center rounded-lg', TONE_CHIP.brand)}><IconAttach size={16} /></span>
                  <span className="text-[13px] font-medium">All files</span>
                  <span className="text-xs text-muted">{allFiles.length} file{allFiles.length === 1 ? '' : 's'}</span>
                </Link>
              </li>
              {PROJECT_FILE_CATEGORIES.map((c, i) => (
                <li key={c}>
                  <Link href={`${base}?category=${c}`} className={cx('flex flex-col gap-2 rounded-xl border bg-surface p-3 shadow-xs transition-colors hover:bg-surface-hover', category === c ? 'border-brand/40' : 'border-line')}>
                    <span className={cx('flex h-9 w-9 items-center justify-center rounded-lg', TONE_CHIP[FOLDER_TONES[i % FOLDER_TONES.length] ?? 'neutral'])}><IconFile size={16} /></span>
                    <span className="text-[13px] font-medium">{humanize(c)}</span>
                    <span className="text-xs text-muted">{countBy(c)} file{countBy(c) === 1 ? '' : 's'}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <Card>
            <CardHeader title={category ? `${humanize(category)} files` : 'Recent files'} description={`${files.length} file${files.length === 1 ? '' : 's'}, newest first.`} />
            {files.length > 0 ? (
              <ul className="divide-y divide-line">
                {files.map((f) => (
                  <FileRow key={f.id} file={f} projectId={projectId} editable={editable} />
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={<IconAttach size={22} />}
                title={category ? 'No matching files' : 'No files yet'}
                description={category ? `No files are filed under “${humanize(category)}”.` : 'A file here is a link to wherever it already lives — a Drive folder, a Figma file, a build host.'}
              />
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <ActivityFeed
            compact
            emptyTitle="Nothing linked yet"
            items={allFiles.slice(0, 6).map((f) => ({
              id: f.id,
              title: `${f.uploadedByName ?? 'Someone'} linked ${f.title}`,
              detail: humanize(f.category),
              when: clock.dateTime(f.createdAt),
              tone: 'info',
              icon: <IconUpload size={13} />,
              href: f.url,
            }))}
          />
          {editable ? (
            <Card id="add-file">
              <CardHeader title="Link a file" description="Where it already lives — a Drive folder, a Figma file, a build host." />
              <div className="px-4 pb-4 sm:px-5 [&>section]:border-0 [&>section]:p-0 [&>section]:shadow-none">
                <AddProjectFileForm projectId={projectId} />
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
