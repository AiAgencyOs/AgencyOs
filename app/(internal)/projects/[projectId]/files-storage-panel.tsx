'use client';

import { useActionState, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import {
  createFileShareLinkAction,
  restoreProjectFileAction,
  revokeFileShareLinkAction,
  trashProjectFileAction,
  uploadProjectFileAction,
} from '@/modules/projects/files-storage-actions';
import type { ProjectFileHead, TrashedFile } from '@/modules/projects/files-storage-queries';
import { PROJECT_FILE_CATEGORIES } from '@/modules/projects/schema';
import { SHARE_EXPIRY_DAYS } from '@/modules/projects/files-storage-schema';
import { Badge, buttonClass, Callout, FormMessage, humanize, IconAlert, IconDownload, IconShare, IconUpload, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

/**
 * SCR-024 — the stored half of the Files tab (decision 5 of 2026-09-29):
 * upload, versions, share links, the trash. Every control is a Server
 * Action through files-storage-actions.ts and every refusal is shown
 * verbatim beside the control that earned it. When storage is not
 * reachable the page says so (`StorageNotice`) and the upload and share
 * forms are drawn disabled with the same sentence — the door would refuse
 * anyway, but a button that cannot work should not look as if it could.
 *
 * Dates arrive pre-formatted (`labels`, keyed by row id) because the agency
 * clock is server-side.
 */

export type FileLabels = Record<string, string>;

export function StorageNotice({ status }: { status: { reachable: true; bucket: string } | { reachable: false; bucket: string; reason: string } }) {
  if (status.reachable) return null;
  return (
    <Callout tone="warning" icon={<IconAlert size={16} />} title={`Storage is not reachable (bucket “${status.bucket}”)`}>
      {status.reason} Linked files keep working; uploads, downloads and share links do not until it is.
    </Callout>
  );
}

function bytes(n: number | null): string {
  if (n === null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function UploadFileForm({
  projectId,
  reachable,
  parentFileId,
  compact,
  clientId,
}: {
  projectId: string;
  reachable: boolean;
  /** Set to upload a new version of that file instead of a new file. */
  parentFileId?: string;
  compact?: boolean;
  /** SCR-015/017 — when mounted on Client 360, the client page to revalidate too. */
  clientId?: string;
}) {
  const [state, action, pending] = useActionState(uploadProjectFileAction, IDLE_STATE);
  const disabled = pending || !reachable;

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="projectId" value={projectId} />
      {clientId ? <input type="hidden" name="clientId" value={clientId} /> : null}
      {parentFileId ? <input type="hidden" name="parentFileId" value={parentFileId} /> : null}
      <div className="flex flex-col gap-1">
        <label className={labelClass}>{parentFileId ? 'New version' : 'File'}</label>
        <input name="file" type="file" required disabled={disabled} className={inputClass} />
      </div>
      {parentFileId ? null : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Title (optional)</label>
            <input name="title" maxLength={200} disabled={disabled} className={inputClass} placeholder="Defaults to the file’s name" />
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Category</label>
            <select name="category" defaultValue="documents" disabled={disabled} className={selectClass}>
              {PROJECT_FILE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      {compact ? null : (
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Description (optional)</label>
          <textarea name="description" maxLength={1000} disabled={disabled} className={textareaClass} rows={2} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={disabled} className={buttonClass('primary', 'sm')}>
          <IconUpload size={14} />
          {pending ? 'Uploading…' : parentFileId ? 'Upload version' : 'Upload'}
        </button>
        {!reachable ? <span className="text-xs text-muted">Storage is not reachable.</span> : null}
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={buttonClass('ghost', 'sm')}
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => setCopied(false));
      }}
    >
      {copied ? 'Copied' : 'Copy link'}
    </button>
  );
}

function CreateShareForm({ projectId, fileId, reachable }: { projectId: string; fileId: string; reachable: boolean }) {
  const [state, action, pending] = useActionState(createFileShareLinkAction, IDLE_STATE);
  const disabled = pending || !reachable;
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="fileId" value={fileId} />
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Link expires in</span>
        <select name="expiresInDays" defaultValue="7" disabled={disabled} className={selectClass}>
          {SHARE_EXPIRY_DAYS.map((d) => (
            <option key={d} value={d}>
              {d} day{d === 1 ? '' : 's'}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={disabled} className={buttonClass('secondary', 'sm')}>
        <IconShare size={14} />
        {pending ? 'Creating…' : 'Create share link'}
      </button>
      {state.status === 'success' && state.message ? (
        <span className="flex items-center gap-2 text-xs">
          <code className="max-w-[16rem] truncate rounded bg-canvas px-1.5 py-0.5 font-mono">{state.message}</code>
          <CopyButton text={state.message} />
        </span>
      ) : (
        <FormMessage status={state.status} message={state.message} />
      )}
    </form>
  );
}

function RevokeShareButton({ projectId, shareId }: { projectId: string; shareId: string }) {
  const [state, action, pending] = useActionState(revokeFileShareLinkAction, IDLE_STATE);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="shareId" value={shareId} />
      <button type="submit" disabled={pending} className="text-xs text-danger hover:underline disabled:opacity-50">
        {pending ? 'Revoking…' : 'Revoke'}
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

function TrashButton({ projectId, fileId }: { projectId: string; fileId: string }) {
  const [state, action, pending] = useActionState(trashProjectFileAction, IDLE_STATE);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="fileId" value={fileId} />
      <button type="submit" disabled={pending} className="text-xs text-danger hover:underline disabled:opacity-50">
        {pending ? 'Moving…' : 'Move to trash'}
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

export function StoredFileRow({
  file,
  projectId,
  editable,
  reachable,
  labels,
  appUrl,
  children,
}: {
  file: ProjectFileHead;
  projectId: string;
  editable: boolean;
  reachable: boolean;
  labels: FileLabels;
  appUrl: string;
  /** For a linked file: the rename/refile form the link door already has. */
  children?: React.ReactNode;
}) {
  const download = (id: string) => `/api/projects/${projectId}/files/${id}/download`;
  const liveShares = file.shares.filter((s) => s.live);

  if (!file.stored) {
    return (
      <li className="flex flex-col gap-2 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <a href={file.url ?? '#'} target="_blank" rel="noreferrer noopener" className="block truncate text-sm font-medium text-foreground underline-offset-2 hover:underline">
                {file.title}
              </a>
              <Badge mono>{humanize(file.category)}</Badge>
              <Badge tone="neutral">link</Badge>
            </span>
            <span className="block truncate text-xs text-muted">
              {file.uploadedByName ? `${file.uploadedByName} · ` : ''}
              {labels[file.id] ?? ''}
              {file.description ? ` · ${file.description}` : ''}
            </span>
          </div>
          {editable ? <TrashButton projectId={projectId} fileId={file.id} /> : null}
        </div>
        {editable && children ? (
          <details>
            <summary className="cursor-pointer text-xs text-muted hover:underline">Rename or refile</summary>
            <div className="pt-2">{children}</div>
          </details>
        ) : null}
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <a href={download(file.latest.id)} className="block truncate text-sm font-medium text-foreground underline-offset-2 hover:underline">
              {file.title}
            </a>
            <Badge mono>{humanize(file.category)}</Badge>
            <Badge tone="neutral">v{file.latest.version}</Badge>
            {liveShares.length > 0 ? <Badge tone="info">{liveShares.length} live link{liveShares.length === 1 ? '' : 's'}</Badge> : null}
          </span>
          <span className="block truncate text-xs text-muted">
            {file.latest.uploadedByName ? `${file.latest.uploadedByName} · ` : ''}
            {labels[file.latest.id] ?? ''}
            {file.latest.sizeBytes !== null ? ` · ${bytes(file.latest.sizeBytes)}` : ''}
            {file.description ? ` · ${file.description}` : ''}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <a href={download(file.latest.id)} className={buttonClass('ghost', 'sm')} title={reachable ? 'Download the latest version' : 'Storage is not reachable'}>
            <IconDownload size={14} />
            Download
          </a>
          {editable ? <TrashButton projectId={projectId} fileId={file.id} /> : null}
        </div>
      </div>

      <details>
        <summary className="cursor-pointer text-xs text-muted hover:underline">
          {file.versions.length} version{file.versions.length === 1 ? '' : 's'} · {file.shares.length} share link{file.shares.length === 1 ? '' : 's'}
        </summary>
        <div className="mt-2 flex flex-col gap-3 rounded-lg border border-line bg-canvas p-3">
          <ul className="flex flex-col gap-1 text-xs">
            {file.versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium">v{v.version}</span>
                  {v.uploadedByName ? ` · ${v.uploadedByName}` : ''}
                  {` · ${labels[v.id] ?? ''}`}
                  {v.sizeBytes !== null ? ` · ${bytes(v.sizeBytes)}` : ''}
                  {v.contentType ? <span className="text-muted"> · {v.contentType}</span> : null}
                </span>
                <a href={download(v.id)} className="text-muted underline-offset-2 hover:underline">
                  Download
                </a>
              </li>
            ))}
          </ul>
          {editable ? <UploadFileForm projectId={projectId} reachable={reachable} parentFileId={file.id} compact /> : null}

          <div className="border-t border-line pt-3">
            <p className="mb-1 text-xs font-medium">Share links</p>
            {file.shares.length === 0 ? <p className="text-xs text-muted">None yet. A link opens the latest stored version until it expires or is revoked.</p> : null}
            <ul className="flex flex-col gap-1 text-xs">
              {file.shares.map((s) => {
                const url = `${appUrl}/api/files/share/${s.token}`;
                return (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span className={s.live ? '' : 'text-muted line-through'}>
                      {s.revokedAt ? 'Revoked' : s.live ? `Expires ${labels[s.id] ?? ''}` : `Expired ${labels[s.id] ?? ''}`}
                      {s.createdByName ? ` · by ${s.createdByName}` : ''}
                      {` · opened ${s.accessCount} time${s.accessCount === 1 ? '' : 's'}`}
                    </span>
                    <span className="flex items-center gap-2">
                      {s.live ? <CopyButton text={url} /> : null}
                      {s.live && editable ? <RevokeShareButton projectId={projectId} shareId={s.id} /> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
            {editable ? (
              <div className="mt-2">
                <CreateShareForm projectId={projectId} fileId={file.latest.id} reachable={reachable} />
              </div>
            ) : null}
          </div>
        </div>
      </details>
    </li>
  );
}

function RestoreButton({ projectId, fileId }: { projectId: string; fileId: string }) {
  const [state, action, pending] = useActionState(restoreProjectFileAction, IDLE_STATE);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="fileId" value={fileId} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Restoring…' : 'Restore'}
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

export function TrashList({ files, projectId, editable, labels }: { files: TrashedFile[]; projectId: string; editable: boolean; labels: FileLabels }) {
  return (
    <ul className="divide-y divide-line">
      {files.map((f) => (
        <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{f.title}</span>
              <Badge mono>{humanize(f.category)}</Badge>
              {f.version > 1 ? <Badge tone="neutral">v{f.version}</Badge> : null}
              {!f.stored ? <Badge tone="neutral">link</Badge> : null}
            </span>
            <span className="block text-xs text-muted">
              Trashed {labels[f.id] ?? ''}
              {f.deletedByName ? ` by ${f.deletedByName}` : ''}
            </span>
          </div>
          {editable ? <RestoreButton projectId={projectId} fileId={f.id} /> : null}
        </li>
      ))}
    </ul>
  );
}
