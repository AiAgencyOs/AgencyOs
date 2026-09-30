'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';

import { resendCenterEmailAction, sendCenterEmailAction } from '@/modules/crm/email-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, buttonClass, cx, FormMessage, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

export type EmailRowView = {
  id: string;
  kind: 'email' | 'client_update';
  to: string;
  subject: string;
  body: string;
  status: 'sent' | 'failed';
  transport: 'resend' | 'smtp' | null;
  error: string | null;
  projectName: string | null;
  retryReason: string | null;
  isRetry: boolean;
  resends: number;
  when: string;
};

export type EmailTargetsView = {
  projects: { id: string; name: string; clientAccountId: string }[];
  clients: { id: string; name: string; billingEmail: string | null }[];
};

/**
 * The email and client-update lane — SCR-057. Sends go through the same
 * transport as the invoice email (Resend or SMTP, whichever the deployment
 * configured); the provider's answer is recorded either way, and a send that
 * failed can be sent again with a reason. `transport` says what is wired, or
 * why nothing is, so the composer never pretends.
 */
export function EmailLane({
  rows,
  targets,
  canSend,
  transport,
}: {
  rows: EmailRowView[];
  targets: EmailTargetsView;
  canSend: boolean;
  transport: { configured: true; label: string } | { configured: false; reason: string };
}) {
  return (
    <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
      {transport.configured ? (
        <p className="text-xs text-muted">Sends through {transport.label}.</p>
      ) : (
        <p className="rounded-md border border-line bg-surface-sunken px-3 py-2 text-xs text-muted">Email is not configured on this deployment. {transport.reason}</p>
      )}
      {canSend && transport.configured ? <ComposeForm targets={targets} /> : null}
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted">Nothing sent by email yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-col gap-1 px-3 py-2 text-[13px]">
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={r.kind === 'client_update' ? 'info' : 'neutral'}>{r.kind === 'client_update' ? 'Client update' : 'Email'}</Badge>
                <Badge tone={r.status === 'sent' ? 'success' : 'danger'} dot>{r.status === 'sent' ? 'Sent' : 'Failed'}</Badge>
                {r.projectName ? <Badge tone="brand">{r.projectName}</Badge> : null}
                <span className="font-medium text-foreground">{r.subject}</span>
              </span>
              <span className="text-xs text-muted">
                to {r.to} · {r.when}
                {r.transport ? ` · via ${r.transport === 'resend' ? 'Resend' : 'SMTP'}` : ''}
                {r.isRetry ? ` · sent again — ${r.retryReason ?? 'no reason kept'}` : ''}
                {r.status === 'failed' && r.resends > 0 ? ` · sent again ${r.resends} time${r.resends === 1 ? '' : 's'}` : ''}
              </span>
              {r.status === 'failed' && r.error ? <span className="text-xs text-danger">{r.error}</span> : null}
              {r.status === 'failed' && r.resends === 0 && canSend && transport.configured ? <ResendForm emailId={r.id} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ComposeForm({ targets }: { targets: EmailTargetsView }) {
  const [state, action, pending] = useActionState(sendCenterEmailAction, IDLE_STATE);
  const ref = useRef<HTMLFormElement>(null);
  const id = useId();
  const [projectId, setProjectId] = useState('');
  const [to, setTo] = useState('');
  useEffect(() => {
    if (state.status === 'success') {
      ref.current?.reset();
      setProjectId('');
      setTo('');
    }
  }, [state]);

  function pickProject(next: string) {
    setProjectId(next);
    // A project names its client; offer that client's billing address unless one is typed.
    const project = targets.projects.find((p) => p.id === next);
    const address = targets.clients.find((c) => c.id === project?.clientAccountId)?.billingEmail;
    if (address && !to.trim()) setTo(address);
  }

  return (
    <form ref={ref} action={action} className="flex flex-col gap-2 rounded-lg border border-dashed border-line p-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-kind`} className={labelClass}>Kind</label>
          <select id={`${id}-kind`} name="kind" defaultValue="client_update" className={cx(selectClass, 'h-9 text-[13px]')}>
            <option value="client_update">Client update</option>
            <option value="email">Email</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-project`} className={labelClass}>About a project (optional)</label>
          <select id={`${id}-project`} name="projectId" value={projectId} onChange={(e) => pickProject(e.target.value)} className={cx(selectClass, 'h-9 text-[13px]')}>
            <option value="">No project</option>
            {targets.projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-to`} className={labelClass}>To</label>
          <input id={`${id}-to`} name="to" type="email" required maxLength={254} value={to} onChange={(e) => setTo(e.target.value)} list={`${id}-addresses`} placeholder="client@example.com" className={cx(inputClass, 'h-9 text-[13px]')} />
          <datalist id={`${id}-addresses`}>
            {targets.clients.filter((c) => c.billingEmail).map((c) => (
              <option key={c.id} value={c.billingEmail ?? ''}>{c.name}</option>
            ))}
          </datalist>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-subject`} className={labelClass}>Subject</label>
        <input id={`${id}-subject`} name="subject" required maxLength={200} className={cx(inputClass, 'h-9 text-[13px]')} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-body`} className={labelClass}>Message</label>
        <textarea id={`${id}-body`} name="body" required maxLength={10000} rows={4} className={cx(textareaClass, 'text-[13px]')} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Sending…' : 'Send'}
        </button>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}

function ResendForm({ emailId }: { emailId: string }) {
  const [state, action, pending] = useActionState(resendCenterEmailAction, IDLE_STATE);
  const id = useId();
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="emailId" value={emailId} />
      <label htmlFor={`${id}-reason`} className="sr-only">Why you are sending this email again</label>
      <input id={`${id}-reason`} name="reason" required minLength={5} maxLength={600} placeholder="Why send it again? (e.g. SMTP is configured now)" className={cx(inputClass, 'h-8 min-w-48 flex-1 text-xs')} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Sending…' : 'Send again'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
