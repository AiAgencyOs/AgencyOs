import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { clientEnv } from '@/lib/env';
import { listProjectFolders } from '@/modules/projects/project-folder-queries';
import { folderNodes, parentFolder } from '@/modules/projects/project-folder-schema';
import { listProjectFileTree, listTrashedFiles, readStorageStatus } from '@/modules/projects/files-storage-queries';
import { listProjectMembers } from '@/modules/projects/project-members-queries';
import { PROJECT_ROLE_LABEL } from '@/modules/projects/project-members-schema';
import { getProject } from '@/modules/projects/queries';
import { PROJECT_FILE_CATEGORIES } from '@/modules/projects/schema';
import { ActivityFeed, Card, CardHeader, cx, DonutChart, EmptyState, humanize, IconAttach, IconFile, IconSearch, IconUpload, PermissionDenied, ViewAll } from '@/ui';

import { AddProjectFileForm, EditFileForm } from '../files-panel';
import { StorageNotice, StoredFileRow, TrashList, UploadFileForm, type FileLabels } from '../files-storage-panel';
import { ProjectSubNav } from '../project-subnav';
import { WorkspaceHeader } from '../workspace-header';

import { FilePreviewButton } from './file-preview-drawer';
import { FileIntoFolderForm, NewFolderForm } from './folder-forms';

export const metadata: Metadata = { title: 'Files' };

/** The reference's folder colours, one per category in order. Palette entries are the app's own tone variables. */
const FOLDER_COLORS = ['var(--info)', 'var(--brand)', 'var(--success)', 'var(--warning)', 'var(--danger)', 'var(--accent)', 'var(--info)', 'var(--brand)', 'var(--success)', 'var(--warning)'];

function FolderGlyph({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 48 40" className="h-10 w-12" aria-hidden>
      <path d="M2 8a4 4 0 0 1 4-4h11l5 5h20a4 4 0 0 1 4 4v21a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8Z" fill={color} opacity="0.32" />
      <path d="M2 14a4 4 0 0 1 4-4h36a4 4 0 0 1 4 4v20a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V14Z" fill={color} opacity="0.55" />
    </svg>
  );
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * SCR-024 — Project Files. Since decision 5 of 2026-09-29 a file here is
 * either a LINK to wherever the agency keeps it (the original rule, still
 * honoured) or an OBJECT uploaded to Supabase Storage, with versions, a
 * trash with a restore door, and signed share links. The storage probe is
 * read first: when the bucket does not answer the page says so in words
 * and every storage control is drawn disabled — the local stack has no
 * storage service, and that state is shown, never papered over.
 *
 * Since 20261001120000: total storage (the sum of every stored version's
 * recorded size — links have none and are counted as files, not bytes), a
 * folder tree inside each category (`project_files.folder`), a preview
 * drawer for images and PDFs through the signed download route, rename /
 * move for stored files through the same update door links use, and the
 * INTERNAL share — who on the project can open a file through the internal
 * link — drawn beside the public share links so the two are never confused.
 */
export default async function ProjectFilesPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ category?: string; folder?: string; view?: string; q?: string; sort?: string; layout?: string }>;
}) {
  const { projectId } = await params;
  const { category, folder, view, q, sort, layout: layoutRaw } = await searchParams;
  const layout: 'grid' | 'list' = layoutRaw === 'grid' ? 'grid' : 'list';

  const context = await requireInternal(`/projects/${projectId}/files`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const editable = can(context, 'project.write');
  const [allFiles, trashed, storage, clock, clientName, members, folderRecords] = await Promise.all([
    listProjectFileTree(projectId),
    listTrashedFiles(projectId),
    context.organizationId ? readStorageStatus(context.organizationId) : Promise.resolve({ reachable: false as const, bucket: 'project-files', reason: 'No organization on this session.' }),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
    listProjectMembers(projectId),
    listProjectFolders(projectId),
  ]);
  const inCategory = category ? allFiles.filter((f) => f.category === category) : allFiles;
  const inFolder = folder ? inCategory.filter((f) => f.folder === folder || f.folder.startsWith(`${folder}/`)) : inCategory;
  const needle = q?.trim().toLowerCase() ?? '';
  const matched = needle ? inFolder.filter((f) => f.title.toLowerCase().includes(needle)) : inFolder;
  const files = sort === 'name' ? [...matched].sort((a, b) => a.title.localeCompare(b.title)) : matched;
  const countBy = (c: string) => allFiles.filter((f) => f.category === c).length;
  const showTrash = view === 'trash';
  // Owner decision 7: folders are records, so an empty folder is drawn; the count is the files filed in it.
  const tree = folderNodes(category ? folderRecords.filter((f) => f.category === category) : folderRecords, allFiles);
  const foldersOf = (c: string) => folderRecords.filter((f) => f.category === c).map((f) => f.path);
  // Grid: the folders directly inside where the person is (only meaningful once a category is chosen).
  const childFolders = category ? tree.filter((n) => parentFolder(n.path) === (folder ?? '')) : [];
  const viewHref = (l: 'grid' | 'list') => {
    const p = new URLSearchParams();
    if (category) p.set('category', category);
    if (folder) p.set('folder', folder);
    if (q) p.set('q', q);
    if (sort) p.set('sort', sort);
    if (l === 'grid') p.set('layout', 'grid');
    const qs = p.toString();
    return qs ? `${base}?${qs}` : base;
  };

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
  // SCR-024 "Total files/storage": every stored version's recorded size.
  const storageBytes = allFiles.reduce((n, f) => n + f.versions.reduce((m, v) => m + (v.sizeBytes ?? 0), 0), 0);
  const liveShares = allFiles.reduce((n, f) => n + f.shares.filter((s) => s.live).length, 0);
  const sizeByCategory = PROJECT_FILE_CATEGORIES.map((c) => ({
    label: humanize(c),
    value: allFiles.filter((f) => f.category === c).reduce((n, f) => n + f.versions.reduce((m, v) => m + (v.sizeBytes ?? 0), 0), 0),
  })).filter((d) => d.value > 0);
  const href = (c?: string, dir?: string) => `${base}${[c ? `category=${c}` : '', dir ? `folder=${encodeURIComponent(dir)}` : ''].filter(Boolean).length ? `?${[c ? `category=${c}` : '', dir ? `folder=${encodeURIComponent(dir)}` : ''].filter(Boolean).join('&')}` : ''}`;

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

      <section aria-labelledby="files-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="files-title" className="text-xl font-bold tracking-tight text-foreground">Project Files</h2>
            <p className="text-[13px] text-muted">Manage all project files, documents, designs, code and resources</p>
          </div>
          {editable ? (
            <a href="#add-file" className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand px-4 text-[13px] font-semibold text-brand-fg shadow-xs hover:opacity-90">
              <IconUpload size={15} />
              Upload Files
            </a>
          ) : null}
        </div>
        {editable ? <NewFolderForm projectId={projectId} categories={PROJECT_FILE_CATEGORIES} defaultCategory={category ?? 'documents'} parent={folder ?? ''} /> : null}
        <form action={base} method="GET" className="flex flex-wrap items-center gap-2">
          {folder ? <input type="hidden" name="folder" value={folder} /> : null}
          {layout === 'grid' ? <input type="hidden" name="layout" value="grid" /> : null}
          <label className="relative min-w-[220px] flex-1">
            <span className="sr-only">Search files and folders</span>
            <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"><IconSearch size={15} /></span>
            <input type="search" name="q" defaultValue={q ?? ''} placeholder="Search files and folders..." className="h-10 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-[13px] text-foreground placeholder:text-faint" />
          </label>
          <label>
            <span className="sr-only">Type</span>
            <select name="category" defaultValue={category ?? ''} className="h-10 rounded-lg border border-line bg-surface px-3 text-[13px] text-foreground">
              <option value="">All Types</option>
              {PROJECT_FILE_CATEGORIES.map((c) => (
                <option key={c} value={c}>{humanize(c)}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Sort</span>
            <select name="sort" defaultValue={sort ?? 'modified'} className="h-10 rounded-lg border border-line bg-surface px-3 text-[13px] text-foreground">
              <option value="modified">Last Modified</option>
              <option value="name">Name</option>
            </select>
          </label>
          <button type="submit" className="h-10 rounded-lg border border-line bg-surface px-4 text-[13px] font-medium text-foreground hover:bg-surface-hover">Apply</button>
        </form>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(18rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <p className="mb-2 text-xs text-muted">
              {allFiles.length} file{allFiles.length === 1 ? '' : 's'} · {stored} stored, {allFiles.length - stored} linked ·{' '}
              <Link href={`${base}?view=trash`} className={cx('underline-offset-2 hover:underline', showTrash ? 'text-foreground' : '')}>
                Trash ({trashed.length})
              </Link>
            </p>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
              {PROJECT_FILE_CATEGORIES.map((c, i) => (
                <li key={c}>
                  <Link href={href(c)} className={cx('flex flex-col gap-3 rounded-xl border bg-surface p-3.5 shadow-xs transition-colors hover:bg-surface-hover', category === c ? 'border-brand/60' : 'border-line')}>
                    <FolderGlyph color={FOLDER_COLORS[i % FOLDER_COLORS.length] ?? 'var(--info)'} />
                    <span>
                      <span className="block truncate text-[12px] font-semibold text-foreground">{String(i + 1).padStart(2, '0')}_{humanize(c).replace(/ /g, '_')}</span>
                      <span className="block text-xs text-muted">{countBy(c)} file{countBy(c) === 1 ? '' : 's'}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {/* SCR-024 "Folder tree": the folders inside the chosen category (or every category), as a tree. */}
            {tree.length > 0 ? (
              <nav aria-label="Folder tree" className="mt-3 rounded-xl border border-line bg-surface p-3 shadow-xs">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{category ? `${humanize(category)} folders` : 'Folders across categories'}</p>
                <ul className="flex flex-col gap-0.5 text-[13px]">
                  <li>
                    <Link href={href(category)} className={cx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-hover', !folder ? 'font-medium text-foreground' : 'text-muted')}>
                      <IconFile size={12} /> {category ? humanize(category) : 'All'} (root)
                    </Link>
                  </li>
                  {tree.map((node) => (
                    <li key={`${node.category}/${node.path}`} style={{ paddingLeft: `${node.depth * 1.25 + 0.75}rem` }}>
                      <Link href={href(node.category, node.path)} className={cx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-hover', folder === node.path && category === node.category ? 'font-medium text-foreground' : 'text-muted')}>
                        <IconFile size={12} /> {category ? '' : `${humanize(node.category)} / `}{node.path.split('/').pop()} <span className="text-xs text-faint">({node.files})</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            ) : null}
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
              <CardHeader
                title={folder ? `${humanize(category ?? 'all')} / ${folder}` : category ? `${humanize(category)} files` : 'Recent Files'}
                description={`${files.length} file${files.length === 1 ? '' : 's'}, newest first. A stored file opens its latest version; expand a row for its versions, the internal share and the public share links.`}
                actions={
                  <span role="group" aria-label="Layout" className="inline-flex overflow-hidden rounded-lg border border-line text-[13px] font-medium">
                    <Link href={viewHref('grid')} aria-current={layout === 'grid' ? 'page' : undefined} className={cx('px-3 py-1.5', layout === 'grid' ? 'bg-brand-soft text-brand' : 'text-muted hover:text-foreground')}>Grid</Link>
                    <Link href={viewHref('list')} aria-current={layout === 'list' ? 'page' : undefined} className={cx('border-l border-line px-3 py-1.5', layout === 'list' ? 'bg-brand-soft text-brand' : 'text-muted hover:text-foreground')}>List</Link>
                  </span>
                }
              />
              {layout === 'grid' && (files.length > 0 || childFolders.length > 0) ? (
                <ul className="grid grid-cols-2 gap-3 px-4 pb-4 sm:grid-cols-3 sm:px-5 xl:grid-cols-4">
                  {childFolders.map((n) => (
                    <li key={`${n.category}/${n.path}`}>
                      <Link href={`${href(n.category, n.path)}${href(n.category, n.path).includes('?') ? '&' : '?'}layout=grid`} className="flex h-full flex-col gap-2 rounded-xl border border-line bg-surface p-3 shadow-xs hover:bg-surface-hover">
                        <FolderGlyph color="var(--brand)" />
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-semibold text-foreground">{n.path.split('/').pop()}</span>
                          <span className="block text-xs text-muted">{n.files} file{n.files === 1 ? '' : 's'}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                  {files.map((f) => (
                    <li key={f.id}>
                      <a
                        href={f.stored ? `/api/projects/${projectId}/files/${f.latest.id}/download` : (f.url ?? viewHref('list'))}
                        {...(f.stored || f.url ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
                        className="flex h-full flex-col gap-2 rounded-xl border border-line bg-surface p-3 shadow-xs hover:bg-surface-hover"
                      >
                        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-soft text-brand"><IconFile size={18} /></span>
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-semibold text-foreground">{f.title}</span>
                          <span className="block truncate text-xs text-muted">{humanize(f.category)}{f.folder ? ` / ${f.folder}` : ''}</span>
                          <span className="block truncate text-xs text-muted">{[f.stored && f.latest.sizeBytes ? bytes(f.latest.sizeBytes) : f.stored ? '' : 'Link', clock.date(f.latest.createdAt)].filter(Boolean).join(' · ')}</span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : layout === 'list' && files.length > 0 ? (
                <ul className="divide-y divide-line">
                  {files.map((f) => (
                    <StoredFileRow
                      key={f.id}
                      file={f}
                      projectId={projectId}
                      editable={editable}
                      reachable={storage.reachable}
                      labels={labels}
                      appUrl={clientEnv.NEXT_PUBLIC_APP_URL}
                      extra={f.stored ? <FilePreviewButton projectId={projectId} fileId={f.latest.id} title={f.title} contentType={f.latest.contentType} stored={f.stored} reachable={storage.reachable} /> : null}
                      internalShare={
                        f.stored ? (
                          <div className="flex flex-col gap-1 text-xs">
                            <p className="font-medium">Internal share</p>
                            <p className="text-muted">
                              Anyone on the project opens it through the internal link, under their own sign-in: <code className="rounded bg-surface-sunken px-1">{`${clientEnv.NEXT_PUBLIC_APP_URL}/api/projects/${projectId}/files/${f.latest.id}/download`}</code>
                            </p>
                            {members.length === 0 ? (
                              <p className="text-muted">No project members recorded yet — every internal role with project access can still open it. Put people on the project from the Team tab.</p>
                            ) : (
                              <ul className="flex flex-wrap gap-1">
                                {members.map((m) => (
                                  <li key={m.id} className="rounded-full border border-line px-2 py-0.5">
                                    {m.fullName} <span className="text-muted">· {PROJECT_ROLE_LABEL[m.projectRole]}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        ) : null
                      }
                    >
                      {editable ? <FileIntoFolderForm projectId={projectId} fileId={f.id} title={f.title} current={f.folder} folders={foldersOf(f.category)} /> : null}
                      {editable ? (
                        <EditFileForm
                          file={{ id: f.id, category: f.category, title: f.title, ...(f.url ? { url: f.url } : {}), description: f.description, uploadedByName: f.uploadedByName, createdAt: f.createdAt }}
                          folder={f.folder}
                          projectId={projectId}
                        />
                      ) : null}
                    </StoredFileRow>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  icon={<IconAttach size={22} />}
                  title={category || folder ? 'No matching files' : 'No files yet'}
                  description={folder ? `Nothing is filed under “${folder}”.` : category ? `No files are filed under “${humanize(category)}”.` : 'Upload a file to storage, or link one from wherever it already lives — a Drive folder, a Figma file, a build host.'}
                />
              )}
            </Card>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Storage Usage" />
            <div className="px-4 pb-4 sm:px-5">
              {sizeByCategory.length > 0 ? (
                <DonutChart data={sizeByCategory.map((d) => ({ label: d.label, value: d.value }))} height={130} totalLabel={bytes(storageBytes)} />
              ) : (
                <p className="text-[13px] text-muted">No stored file yet; links take no storage.</p>
              )}
              <p className="mt-2 text-xs text-muted">{allFiles.length} file{allFiles.length === 1 ? '' : 's'} · {liveShares} live public share link{liveShares === 1 ? '' : 's'}</p>
            </div>
          </Card>
          <ActivityFeed
            title="Recent Activity"
            compact
            emptyTitle="Nothing added yet"
            items={allFiles.slice(0, 6).map((f) => ({
              id: f.id,
              title: `${f.latest.uploadedByName ?? f.uploadedByName ?? 'Someone'} ${f.stored ? (f.latest.version > 1 ? `uploaded v${f.latest.version} of` : 'uploaded') : 'linked'} ${f.title}`,
              detail: `${humanize(f.category)}${f.folder ? ` / ${f.folder}` : ''}`,
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
          <Card>
            <CardHeader title="Quick Links" actions={<ViewAll href="/integrations" label="Integrations" />} />
            <ul className="grid grid-cols-2 gap-2 p-3 sm:p-4">
              {['Google Drive', 'Figma', 'GitHub', 'Firebase'].map((n) => (
                <li key={n}>
                  <Link href="/integrations" className="flex flex-col rounded-lg border border-line bg-surface px-3 py-2 text-[13px] font-medium text-foreground hover:bg-surface-hover">
                    {n}
                    <span className="text-xs font-normal text-brand">Connect</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
