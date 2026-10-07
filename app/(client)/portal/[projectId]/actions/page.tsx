import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireClient } from '@/lib/auth/session';
import { readClientActionRequests } from '@/modules/portal/client-action-queries';
import { readClientProject } from '@/modules/portal/queries';
import { IconArrowLeft } from '@/ui';

import { ResolveClientActionForm } from './resolve-form';

export const metadata: Metadata = { title: 'What we need from you' };

const humanize = (s: string) => s.replace(/_/g, ' ');

/**
 * What the agency asked the client to do, each with its deadline (Phase 7c, P702 §7). The client answers with a note; that is a message to a person, who checks it
 * and confirms. Nothing on this page marks anything done by itself, and nothing here shows another account's requests (the database function filters by account).
 */
export default async function PortalClientActionsPage({ params }: { params: Promise<{ projectId: string }> }) {
  await requireClient();
  const clock = await agencyClock();
  const { projectId } = await params;
  const project = await readClientProject(projectId);
  if (!project) notFound();
  const requests = await readClientActionRequests(projectId);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link href={`/portal/${projectId}`} className="flex w-fit items-center gap-1.5 text-[13px] text-muted hover:text-foreground">
          <IconArrowLeft size={14} />
          {project.name}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">What we need from you</h1>
      </div>
      {requests.length === 0 ? (
        <p className="text-sm text-muted">We are not waiting on anything from you right now.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {requests.map((r) => (
            <li key={r.id} className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-[15px] font-medium">{r.title}</h2>
                <span className="text-[12px] text-muted">Please do this by {clock.date(r.dueAt)}</span>
              </div>
              <p className="whitespace-pre-wrap text-sm">{r.instructions}</p>
              <p className="text-sm">
                Status: <strong>{r.overdue ? 'overdue' : humanize(r.status)}</strong>
                {r.status === 'submitted' ? '. Thank you: your project contact will check it and confirm.' : ''}
                {r.status === 'confirmed' && r.confirmedAt ? ` (confirmed ${clock.date(r.confirmedAt)})` : ''}
              </p>
              {r.status === 'open' && r.returnedNote ? <p className="text-sm">Your project contact wrote: {r.returnedNote}</p> : null}
              {r.status === 'open' ? <ResolveClientActionForm projectId={projectId} requestId={r.id} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
