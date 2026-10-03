'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { openRenewalAction } from '@/modules/sales/renewal-actions';
import { RENEWAL_KINDS } from '@/modules/sales/renewal-schema';
import { buttonClass, cx, Drawer, FormMessage, IconPlus, inputClass, labelClass, selectClass } from '@/ui';

import { MeetingRequestForm } from '../../leads/[leadId]/meeting-request-form';
import { UploadFileForm } from '../../projects/[projectId]/files-storage-panel';
import { CreateProjectForm } from '../../quick-create-forms';

/**
 * SCR-015/016 — the doors the PDF puts on Client 360, each one mounted
 * from where it already exists (bucket F rule 1):
 *
 * - upload: the bucket-E storage door (`uploadProjectFileAction`) on a
 *   project of this client, chosen here; a stored file belongs to a
 *   project, so the picker is the scoping;
 * - schedule meeting: the Lead 360's meeting-request form on one of the
 *   client's leads;
 * - create project: the manual project door's own form, the client
 *   pre-filled;
 * - renewal / upsell: `sales.open_renewal`, on a completed project.
 */
export function ClientUploadForm({ clientId, projects, reachable }: { clientId: string; projects: readonly { id: string; name: string }[]; reachable: boolean }) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  if (projects.length === 0) return <p className="text-[13px] text-muted">A stored file belongs to a project; this client has none yet.</p>;
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Project</span>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={selectClass}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {projectId ? <UploadFileForm key={projectId} projectId={projectId} reachable={reachable} compact clientId={clientId} /> : null}
    </div>
  );
}

export function ClientMeetingForm({ leads, agencyZone }: { leads: readonly { id: string; title: string; conversationId: string | null }[]; agencyZone: string }) {
  const [open, setOpen] = useState(false);
  const [leadId, setLeadId] = useState(leads[0]?.id ?? '');
  const lead = leads.find((l) => l.id === leadId) ?? null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('secondary', 'sm')}>
        <IconPlus size={14} /> Schedule meeting
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Schedule a meeting" description="Recorded on one of this client's leads; nothing is agreed by recording it — times are offered from the calendar afterwards.">
        {leads.length === 0 ? (
          <p className="text-[13px] text-muted">A meeting is requested on a lead, and this client has none.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Lead</span>
              <select value={leadId} onChange={(e) => setLeadId(e.target.value)} className={selectClass}>
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.title}
                  </option>
                ))}
              </select>
            </label>
            {lead ? <MeetingRequestForm key={lead.id} leadId={lead.id} conversationId={lead.conversationId} agencyZone={agencyZone} /> : null}
          </div>
        )}
      </Drawer>
    </>
  );
}

export function ClientCreateProjectButton({ clientAccountId }: { clientAccountId: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('secondary', 'sm')} title="Through the manual project door, with this client pre-filled.">
        <IconPlus size={14} /> Create project
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title="New project" description="The manual project door, with this client already chosen.">
        <CreateProjectForm initialClientAccountId={clientAccountId} onCancel={() => setOpen(false)} onCreated={(href) => router.push(href)} />
      </Drawer>
    </>
  );
}

export function RenewalForm({ clientAccountId, completedProjects }: { clientAccountId: string; completedProjects: readonly { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(openRenewalAction, IDLE_STATE);
  const [open, setOpen] = useState(false);
  if (completedProjects.length === 0) {
    return <p className="text-[12.5px] text-muted">A renewal or upsell continues a completed project; none is completed yet.</p>;
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('secondary', 'sm')}>
        <IconPlus size={14} /> Start renewal / upsell
      </button>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-line bg-surface-sunken p-3">
      <input type="hidden" name="clientAccountId" value={clientAccountId} />
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Continues from</span>
          <select name="projectId" required className={selectClass}>
            {completedProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Kind</span>
          <select name="kind" required className={selectClass}>
            {RENEWAL_KINDS.map((k) => (
              <option key={k} value={k}>
                {k[0]!.toUpperCase() + k.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Deal name</span>
          <input name="name" required maxLength={200} placeholder="e.g. Year 2 maintenance" className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Value (₹, optional)</span>
          <input name="value" type="number" min="0" step="1" placeholder="0" className={cx(inputClass, 'text-right')} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Opening…' : 'Open deal'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
          Cancel
        </button>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}
