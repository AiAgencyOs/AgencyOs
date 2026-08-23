import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listLeads, listLeadsNeedingAttention } from '@/modules/crm/queries';
import { EmptyState, IconLeads, PageHeader } from '@/ui';
import Link from 'next/link';

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
/**
 * What each tier is called, and how loudly.
 *
 * The words are a person's next action rather than the tag: `handed_over` is
 * a state, "asked for a person" is a thing to do about it.
 */
const ATTENTION: Record<string, { label: string; tone: string }> = {
  handed_over: { label: 'Asked for a person', tone: 'bg-warning/15 text-warning' },
  waiting_on_us: { label: 'Waiting on us', tone: 'bg-danger/10 text-danger' },
  revision_asked: { label: 'Asked to change the quote', tone: 'bg-warning/15 text-warning' },
  quoted_no_answer: { label: 'Quote out, no answer', tone: 'bg-neutral-100 dark:bg-neutral-800' },
  ready_to_quote: { label: 'Ready to quote', tone: 'bg-success/10 text-success' },
  open_objection: { label: 'Concern unanswered', tone: 'bg-warning/10 text-warning' },
  never_answered: { label: 'Never answered', tone: 'bg-danger/10 text-danger' },
  quiet: { label: 'Quiet', tone: 'bg-neutral-100 dark:bg-neutral-800' },
};

/**
 * How long it has been waiting, roughly.
 *
 * Rounded rather than exact: the number is read to decide what to open next,
 * and "3d" answers that as well as "3d 4h 12m" while being possible to scan
 * down a column.
 */
function waitedFor(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

export default async function LeadsPage() {
  const context = await requireInternal('/leads');
  if (!can(context.role, 'lead.read')) redirect('/dashboard');

  const leads = await listLeads();
  const waiting = await listLeadsNeedingAttention();
  const clock = await agencyClock();
  const now = new Date();

  const rows: ChatLead[] = leads.map((lead) => ({
    id: lead.id,
    title: lead.title,
    status: lead.status,
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

      {/* Doc 09 §31, under ADM-88: a fact-tier order, never a score. At the
          top because at 200-300 leads a month the first question of the day is
          not "what is my pipeline" but "who is waiting for me". */}
      {waiting.length > 0 ? (
        <section className="rounded-lg border border-subtle bg-surface p-4">
          <p className="mb-2 text-[12.5px] text-muted">Who needs you first</p>
          <div className="flex flex-col divide-y divide-subtle">
            {waiting.map((lead) => (
              <Link
                key={lead.lead_id}
                href={`/leads/${lead.lead_id}`}
                className="flex items-center gap-3 py-1.5 hover:opacity-80"
              >
                <span
                  className={`w-36 shrink-0 rounded px-1.5 py-0.5 text-center text-[11.5px] ${
                    ATTENTION[lead.reason]?.tone ?? 'bg-neutral-100 dark:bg-neutral-800'
                  }`}
                >
                  {ATTENTION[lead.reason]?.label ?? lead.reason}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{lead.title}</span>
                <span className="shrink-0 text-[12.5px] tabular text-muted">
                  {lead.waiting_since ? waitedFor(lead.waiting_since, now) : ''}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

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
