import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listPhaseFourCommunications } from '@/modules/crm/queries';
import { Badge, Card, EmptyState, IconInbox, PageHeader } from '@/ui';

export const metadata: Metadata = { title: 'PM Communication' };

const MILESTONE_LABEL: Record<string, string> = {
  'phase-four-started': 'Task 2 started',
  'ui-version-admin-approved': 'UI ready for client',
  'ui-version-change-requested': 'UI change requested',
  'ui-version-locked': 'UI locked',
  'prototype-submitted': 'Prototype submitted',
  'prototype-change-requested': 'Prototype change requested',
  'task2-complete': 'Task 2 complete',
  'm2-payment-verified': 'M2 payment verified',
};

function when(clock: AgencyClock, value: string): string {
  return clock.dateTime(value);
}

/**
 * PM Communication — PM §5-6 (P4-PM-MSG-CONTRACT, P4-PM-ADMINUI). All 8
 * Task 2 milestone announcements (PM4-M01–M08) are real and sent — see
 * `src/modules/crm/handlers.ts`'s `announceToInternalChannel` family — but
 * they only ever appeared inside `/communication`'s general conversation
 * list, mixed with every lead and client thread. This is the dedicated
 * surface Impl §10 names: Task 2's own milestone announcements, and nothing
 * else, across every project.
 *
 * A deliberate divergence from the PM spec's letter is already recorded
 * where the handlers themselves live: these go to AgencyOS's internal
 * WhatsApp group, not straight to a client (ADM-08d) — this page reads
 * exactly the same messages a staff member already sees there, from the
 * angle of "what has the PM announced about Task 2 lately" rather than
 * "what is in this one conversation."
 */
export default async function PmCommunicationPage() {
  const context = await requireInternal('/pm-communication');
  const clock = await agencyClock();
  if (!can(context.role, 'lead.read')) redirect('/dashboard');

  const messages = await listPhaseFourCommunications();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="PM Communication"
        description={
          messages.length === 0
            ? 'No Task 2 milestone has been announced yet.'
            : `${messages.length} Task 2 milestone announcement${messages.length === 1 ? '' : 's'}, most recent first.`
        }
      />

      {messages.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {messages.map((m) => (
            <li key={m.id}>
              <Card className="p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge tone="neutral">{MILESTONE_LABEL[m.milestone] ?? m.milestone}</Badge>
                  <span className="text-[13px] text-muted">{when(clock, m.occurredAt)}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-[13px]">{m.body}</p>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={<IconInbox size={22} />}
          title="Nothing announced yet"
          description="A message appears here the moment a Task 2 milestone fires — Task 2 started, a UI or prototype round, or M2 payment verified."
        />
      )}
    </div>
  );
}
