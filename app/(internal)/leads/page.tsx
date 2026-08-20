import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listLeads } from '@/modules/crm/queries';
import { EmptyState, IconLeads, PageHeader } from '@/ui';

import { LeadChatList, type ChatLead } from './chat-list';

export const metadata: Metadata = { title: 'Leads' };

const TIME = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' });
const WEEKDAY = new Intl.DateTimeFormat('en-IN', { weekday: 'short' });
const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });

/**
 * A chat list's timestamp column, which is the one place a relative date is
 * genuinely clearer than an absolute one: time today, "Yesterday", a weekday
 * inside the last week, a date after that.
 *
 * Computed on the server and sent down as a string. Deriving it in the browser
 * as well would let the two disagree across a midnight boundary, and React
 * treats a mismatched text node as a broken tree.
 */
function chatTime(iso: string, now: Date): string {
  const at = new Date(iso);
  const days = Math.floor(
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
      Date.UTC(at.getFullYear(), at.getMonth(), at.getDate())) /
      86_400_000,
  );
  if (days <= 0) return TIME.format(at);
  if (days === 1) return 'Yesterday';
  if (days < 7) return WEEKDAY.format(at);
  return DATE.format(at);
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
  const now = new Date();

  const rows: ChatLead[] = leads.map((lead) => ({
    id: lead.id,
    title: lead.title,
    status: lead.status,
    score: lead.score,
    source: lead.source,
    contactName: lead.contact?.fullName ?? null,
    company: lead.contact?.company ?? null,
    time: chatTime(lead.created_at, now),
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
