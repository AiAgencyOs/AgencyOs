'use client';

import { useState } from 'react';

import { buttonClass, Drawer, IconDownload, IconFile } from '@/ui';

/**
 * SCR-024 — the preview drawer. An image or a PDF is shown through the
 * internal download route, which signs a five-minute storage URL under the
 * caller's own session and redirects; the `<img>` and `<iframe>` follow
 * the redirect, so nothing here holds a signed URL longer than the
 * browser does. Anything else is offered as a download — a preview that
 * cannot render is said, not faked. A linked (external) file previews
 * nothing: its bytes are not ours to fetch.
 */
export function FilePreviewButton({
  projectId,
  fileId,
  title,
  contentType,
  stored,
  reachable,
}: {
  projectId: string;
  fileId: string;
  title: string;
  contentType: string | null;
  stored: boolean;
  reachable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const href = `/api/projects/${projectId}/files/${fileId}/download`;
  const isImage = Boolean(contentType && /^image\//i.test(contentType));
  const isPdf = contentType === 'application/pdf';
  if (!stored) return null;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('ghost', 'sm')} title={reachable ? 'Preview' : 'Storage is not reachable'}>
        <IconFile size={14} />
        Preview
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        description={contentType ?? 'unknown type'}
        actions={
          <a href={href} className={buttonClass('secondary', 'sm')}>
            <IconDownload size={14} />
            Download
          </a>
        }
      >
        {!reachable ? (
          <p className="text-[13px] text-muted">Storage is not reachable right now, so the file cannot be fetched for a preview.</p>
        ) : isImage ? (
          // A plain <img>: the source is a signed, short-lived storage URL behind a redirect, not an optimisable static asset.
          <img src={href} alt={title} className="max-h-[70vh] w-full rounded-lg border border-line object-contain" />
        ) : isPdf ? (
          <iframe src={href} title={title} className="h-[70vh] w-full rounded-lg border border-line bg-white" />
        ) : (
          <p className="text-[13px] text-muted">This file type is not previewed in the browser. Download it to open it.</p>
        )}
      </Drawer>
    </>
  );
}
