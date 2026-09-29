'use client';

import { useActionState, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { addProjectLinkAction, removeProjectLinkAction } from '@/modules/projects/project-links-actions';
import type { ProjectLink } from '@/modules/projects/project-links-queries';
import { PROJECT_LINK_KINDS } from '@/modules/projects/project-links-schema';
import { Badge, buttonClass, FormMessage, humanize, IconArrowUpRight, inputClass, labelClass, selectClass } from '@/ui';

/** SCR-019 — the project links panel: the list, add and remove, through project-links-actions. */
export function ProjectLinksPanel({ projectId, links, editable }: { projectId: string; links: ProjectLink[]; editable: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(addProjectLinkAction, IDLE_STATE);

  return (
    <div className="flex flex-col gap-2">
      {links.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No links yet{editable ? ' — add the repository, the design file, the staging site.' : '.'}</p>
      ) : (
        <ul className="divide-y divide-line">
          {links.map((l) => (
            <li key={l.id} className="flex items-center gap-3 px-4 py-2 text-[13px] sm:px-5">
              <a href={l.url} target="_blank" rel="noreferrer noopener" className="flex min-w-0 flex-1 items-center gap-1.5 font-medium text-foreground underline-offset-2 hover:underline">
                <span className="truncate">{l.label}</span>
                <IconArrowUpRight size={12} />
              </a>
              <Badge tone="neutral">{humanize(l.kind)}</Badge>
              {editable ? <RemoveLinkButton projectId={projectId} linkId={l.id} label={l.label} /> : null}
            </li>
          ))}
        </ul>
      )}
      {editable ? (
        <div className="border-t border-line px-4 py-3 sm:px-5">
          {!open ? (
            <button type="button" onClick={() => setOpen(true)} className={buttonClass('ghost', 'sm')}>
              + Add link
            </button>
          ) : (
            <form action={action} className="flex flex-col gap-2">
              <input type="hidden" name="projectId" value={projectId} />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <label className="flex flex-col gap-1">
                  <span className={labelClass}>Label</span>
                  <input name="label" required maxLength={120} className={inputClass} placeholder="Figma file" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={labelClass}>Kind</span>
                  <select name="kind" defaultValue="other" className={selectClass}>
                    {PROJECT_LINK_KINDS.map((k) => (
                      <option key={k} value={k}>{humanize(k)}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 sm:col-span-3">
                  <span className={labelClass}>URL</span>
                  <input name="url" type="url" required maxLength={2000} className={inputClass} placeholder="https://" />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
                  {pending ? 'Adding…' : 'Add link'}
                </button>
                <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
                  Cancel
                </button>
                <FormMessage status={state.status} message={state.message} />
              </div>
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}

function RemoveLinkButton({ projectId, linkId, label }: { projectId: string; linkId: string; label: string }) {
  const [state, action, pending] = useActionState(removeProjectLinkAction, IDLE_STATE);
  return (
    <form
      action={action}
      className="inline-flex items-center gap-1"
      onSubmit={(e) => {
        if (!window.confirm(`Remove the link “${label}”?`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="linkId" value={linkId} />
      <button type="submit" disabled={pending} className="text-xs text-faint hover:text-danger" aria-label={`Remove ${label}`}>
        Remove
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}
