import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { clientEnv } from '@/lib/env';
import { listProjectFileTree, listTrashedFiles, readStorageStatus } from '@/modules/projects/files-storage-queries';
import { getProject } from '@/modules/projects/queries';
import { PROJECT_FILE_CATEGORIES } from '@/modules/projects/schema';
import { ActivityFeed, Card, CardHeader, cx, EmptyState, humanize, IconAttach, IconFile, IconUpload, PermissionDenied, TONE_CHIP, type Tone } from '@/ui';

import { AddProjectFileForm, EditFileForm } from '../files-panel';
import { StorageNotice, StoredFileRow, TrashList, UploadFileForm, type FileLabels } from '../files-storage-panel';
import { ProjectSubNav } from '../project-subnav';
import { WorkspaceHeader } from '../workspace-header';

export const metadata: Metadata = { title: 'Files' };

const FOLDER_TONES: Tone[] = ['info', 'accent', 'success', 'warning', 'danger', 'brand', 'neutral'];

/**
 * SCR-024 — Project Files. Since decision 5 of 2026-09-29 a file here is
 * either a LINK to wherever the agency keeps it (the original rule, still
 * honoured) or an OBJECT uploaded to Supabase Storage, with versions, a
 * trash with a restore door, and signed share links. The storage probe is
 * read first: when the bucket does not answer the page says so in words
 * and every storage control is drawn disabled — the local stack has no
 * storage service, and that state is shown, never papered over. Sizes are
 * shown only for stored files, because only those have one recorded.
 */
export default async function ProjectFilesPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ category?: string; view?: string }>;
}) {
  const { projectId } = await params;
  const { category, view } = await searchParams;

  const context = await requireInternal(`/projects/${projectId}/files`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const editable = can(context, 'project.write');
  const [allFiles, trashed, storage, clock, clientName] = await Promise.all([
    listProjectFileTree(projectId),
    listTrashedFiles(projectId),
    context.organizationId ? readStorageStatus(context.organizationId) : Promise.resolve({ reachable: false as const, bucket: 'project-files', reason: 'No organization on this session.' }),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
  ]);
  const files = category ? allFiles.filter((f) => f.category === category) : allFiles;
  const countBy = (c: string) => allFiles.filter((f) => f.category === c).length;
  const showTrash = view === 'trash';

  // Pre-formatted dates, keyed by row id, for the client rows.
  const labels: FileLabels = {};
  for (const f of allFiles) {
    labels[f.id] = clock.dateTime(f.createdAt);
    for (const v of f.versions) labels[v.id] = clock.dateTime(v.createdAt);
    for (const s of f.shares) labels[s.id] = clock.dateTime(s.expiresAt);
  }
  for (const t of trashed) labels[t.id] = clock.dateTime(t.deletedAt);

  const base = `/projects/${projectId}/files`;
  const stored = allFiles.filter((f) => f.stored).length;

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader
        project={project}
        clock={clock}
        clientName={clientName}
        canEdit={can(context, 'project.write')}
        actions={
          editable ? (
            <a href="#add-file" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium shadow-xs hover:bg-surface-hover md:h-8">
              <IconUpload size={14} />
              Upload or link a file
            </a>
          ) : null
        }
      />

      <ProjectSubNav projectId={projectId} />

      <StorageNotice status={storage} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(18rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold tracking-tight">Folders</h2>
              <p className="text-xs text-muted">
                {allFiles.length} file{allFiles.length === 1 ? '' : 's'} · {stored} stored, {allFiles.length - stored} linked ·{' '}
                <Link href={`${base}?view=trash`} className={cx('underline-offset-2 hover:underline', showTrash ? 'text-foreground' : '')}>
                  Trash ({trashed.length})
                </Link>
              </p>
            </div>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <li>
                <Link href={base} className={cx('flex flex-col gap-2 rounded-xl border bg-surface p-3 shadow-xs transition-colors hover:bg-surface-hover', !category && !showTrash ? 'border-brand/40' : 'border-line')}>
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

          {showTrash ? (
            <Card>
              <CardHeader title="Trash" description={`${trashed.length} item${trashed.length === 1 ? '' : 's'}. Restoring a file brings its versions back with it; the objects stay in the bucket either way.`} actions={<Link href={base} className="text-xs text-muted underline-offset-2 hover:underline">Back to files</Link>} />
              {trashed.length > 0 ? (
                <TrashList files={trashed} projectId={projectId} editable={editable} labels={labels} />
              ) : (
                <EmptyState icon={<IconAttach size={22} />} title="The trash is empty" description="A file moved to the trash stays here until it is restored." />
              )}
            </Card>
          ) : (
            <Card>
              <CardHeader title={category ? `${humanize(category)} files` : 'Recent files'} description={`${files.length} file${files.length === 1 ? '' : 's'}, newest first. A stored file opens its latest version; expand a row for its versions and share links.`} />
              {files.length > 0 ? (
                <ul className="divide-y divide-line">
                  {files.map((f) => (
                    <StoredFileRow key={f.id} file={f} projectId={projectId} editable={editable} reachable={storage.reachable} labels={labels} appUrl={clientEnv.NEXT_PUBLIC_APP_URL}>
                      {!f.stored ? (
                        <EditFileForm
                          file={{ id: f.id, category: f.category, title: f.title, url: f.url ?? '', description: f.description, uploadedByName: f.uploadedByName, createdAt: f.createdAt }}
                          projectId={projectId}
                        />
                      ) : null}
                    </StoredFileRow>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  icon={<IconAttach size={22} />}
                  title={category ? 'No matching files' : 'No files yet'}
                  description={category ? `No files are filed under “${humanize(category)}”.` : 'Upload a file to storage, or link one from wherever it already lives — a Drive folder, a Figma file, a build host.'}
                />
              )}
            </Card>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <ActivityFeed
            compact
            emptyTitle="Nothing added yet"
            items={allFiles.slice(0, 6).map((f) => ({
              id: f.id,
              title: `${f.latest.uploadedByName ?? f.uploadedByName ?? 'Someone'} ${f.stored ? (f.latest.version > 1 ? `uploaded v${f.latest.version} of` : 'uploaded') : 'linked'} ${f.title}`,
              detail: humanize(f.category),
              when: clock.dateTime(f.latest.createdAt),
              tone: 'info',
              icon: <IconUpload size={13} />,
              href: f.stored ? `/api/projects/${projectId}/files/${f.latest.id}/download` : (f.url ?? undefined),
            }))}
          />
          {editable ? (
            <>
              <Card id="add-file">
                <CardHeader title="Upload a file" description={storage.reachable ? `Stored in the “${storage.bucket}” bucket. A later upload of the same file becomes its next version.` : 'Storage is not reachable, so uploads are refused until it is.'} />
                <div className="px-4 pb-4 sm:px-5">
                  <UploadFileForm projectId={projectId} reachable={storage.reachable} />
                </div>
              </Card>
              <Card>
                <CardHeader title="Link a file" description="Where it already lives — a Drive folder, a Figma file, a build host." />
                <div className="px-4 pb-4 sm:px-5 [&>section]:border-0 [&>section]:p-0 [&>section]:shadow-none">
                  <AddProjectFileForm projectId={projectId} />
                </div>
              </Card>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
