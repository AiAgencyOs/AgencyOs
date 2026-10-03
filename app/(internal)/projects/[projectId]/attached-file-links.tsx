import type { AttachedFile } from '@/modules/projects/attached-files-queries';

/**
 * The files a build, a test run or a bug carries, each a link to the signed
 * download route (`/api/projects/<project>/attachments/<id>` — the route reads
 * the row under the reader's session and redirects to a five-minute URL).
 * Renders nothing for a record with no file, so a page that has none is
 * unchanged.
 */
export function AttachedFileLinks({ projectId, files, label }: { projectId: string; files: readonly AttachedFile[] | undefined; label: string }) {
  if (!files || files.length === 0) return null;
  return (
    <ul aria-label={label} className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {files.map((f) => (
        <li key={f.id} className="min-w-0 max-w-full">
          <a href={`/api/projects/${projectId}/attachments/${f.id}`} className="break-all underline underline-offset-2" download>
            {f.fileName}
          </a>
          <span className="text-muted"> · {f.sizeBytes >= 1024 * 1024 ? `${(f.sizeBytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(f.sizeBytes / 1024))} KB`}</span>
        </li>
      ))}
    </ul>
  );
}
