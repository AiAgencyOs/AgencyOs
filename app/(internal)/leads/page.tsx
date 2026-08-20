import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listLeads } from '@/modules/crm/queries';
import { EmptyState, IconLeads, PageHeader } from '@/ui';

import { LeadChatList, type ChatLead } from './chat-list';

export const metadata: Metadata = { title: 'Leads' };


/**
 * A chat list's timestamp column, which is the one place a relative date is
 * genuinely clearer than an absolute one: time today, "Yesterday", a weekday
 * inside the last week, a date after that.
 *
 * Computed on the server and sent down as a string. Deriving it in the browser
 * as well would let the two disagree across a midnight boundary, and React
 * treats a mismatched text node as a broken tree.
 *
 * Both the reading and the day comparison happen in the agency's zone. On a
 * UTC runtime the old version called a message "Yesterday" while the office
 * clock still said today.
 */
function chatTime(iso: string, now: Date, clock: AgencyClock): string {
  const at = new Date(iso);
  const key = clock.dayKey(at);
  if (key === clock.dayKey(now)) return clock.clock(at);
  if (key === clock.dayKey(new Date(now.getTime() - 86_400_000))) return 'Yesterday';
  const days = Math.floor((now.getTime() - at.getTime()) / 86_400_000);
  if (days < 7) return clock.weekday(at);
  return clock.date(at);
}

/**
 * Lead pipeline, as a chat list.
 *
 * These conversations happen on WhatsApp, so the index of them looks like the
 * index of them on WhatsApp: who it is, what the last thing about them was,
 * and when. The pipeline facts a table would have shown — status, source,
 * score — ride along as a chip and a subtitle rather than as four more
 * columns nobody scrolls to on a phone.
 *
 * The nav in the internal layout hides this entry for roles without
 * `lead.read`, but hiding a link is not access control — a contractor can
 * still type the URL. The capability is therefore re-checked here, and RLS
 * independently refuses the rows underneath, so a mistake in either layer
 * still fails closed.
 */
export default async function LeadsPage() {
  const context = await requireInternal('/leads');
  if (!can(context.role, 'lead.read')) redirect('/dashboard');

  const leads = await listLeads();
  const clock = await agencyClock();
  const now = new Date();

  const rows: ChatLead[] = leads.map((lead) => ({
    id: lead.id,
    title: lead.title,
    status: lead.status,
    score: lead.score,
    source: lead.source,
    contactName: lead.contact?.fullName ?? null,
    company: lead.contact?.company ?? null,
    time: chatTime(lead.created_at, now, clock),
  }));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Leads"
        description={
          leads.length === 0
            ? 'Conversations captured from WhatsApp, referrals and the website land here.'
            : `${leads.length} conversation${leads.length === 1 ? '' : 's'} in the pipeline.`
        }
      />

      {leads.length > 0 ? (
        <LeadChatList leads={rows} />
      ) : (
        <EmptyState
          icon={<IconLeads size={22} />}
          title="No leads yet"
          description="Leads captured from WhatsApp, referrals, and the website will appear here. Nothing is missing — none have arrived."
        />
      )}
    </div>
  );
}
