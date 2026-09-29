import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listLeadsNeedingAttention } from '@/modules/crm/queries';
import { listLeadsForTable } from '@/modules/crm/lead-list-queries';
import { LEAD_STATUSES, NURTURE_REASONS } from '@/modules/crm/schema';
import { listInternalRoster } from '@/modules/projects/queries';
import { EmptyState, FilterBar, FilterChips, IconLeads, PageHeader, humanize, inputClass, labelClass, selectClass, buttonClass } from '@/ui';
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function money(minor: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(minor / 100);
}

type LeadsSearch = {
  q?: string;
  source?: string;
  owner?: string;
  status?: string;
  tag?: string;
  budgetMin?: string;
  budgetMax?: string;
  createdFrom?: string;
  createdTo?: string;
};

export default async function LeadsPage({ searchParams }: { searchParams: Promise<LeadsSearch> }) {
  const context = await requireInternal('/leads');
  if (!can(context.role, 'lead.read')) redirect('/dashboard');

  // SCR-006 — server-side filters, read from the URL so a filtered list can
  // be bookmarked or shared. Only values the schema names, or that parse,
  // reach the database; a stranger is dropped rather than refused.
  const params = await searchParams;
  const q = (params.q ?? '').trim() || undefined;
  const status = (LEAD_STATUSES as readonly string[]).includes(params.status ?? '') ? params.status : undefined;
  const owner = params.owner === 'mine' ? context.userId : UUID.test(params.owner ?? '') ? params.owner : undefined;
  const source = (params.source ?? '').trim() || undefined;
  const tag = (params.tag ?? '').trim().toLowerCase() || undefined;
  const createdFrom = DATE.test(params.createdFrom ?? '') ? params.createdFrom : undefined;
  const createdTo = DATE.test(params.createdTo ?? '') ? params.createdTo : undefined;
  const toMinor = (v: string | undefined) => {
    const n = Number(v);
    return v && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined;
  };
  const budgetMinMinor = toMinor(params.budgetMin);
  const budgetMaxMinor = toMinor(params.budgetMax);
  const filtering = Boolean(q || status || owner || source || tag || createdFrom || createdTo || budgetMinMinor !== undefined || budgetMaxMinor !== undefined);

  const leads = await listLeadsForTable({ q, source, owner, status, tag, createdFrom, createdTo, budgetMinMinor, budgetMaxMinor });
  const waiting = await listLeadsNeedingAttention();
  const clock = await agencyClock();
  const now = new Date();

  const canAssign = can(context.role, 'lead.assign');
  const canWrite = can(context.role, 'lead.write');
  const roster = canAssign || canWrite ? await listInternalRoster() : [];
  const nameOf = (id: string | null) => (id ? (roster.find((m) => m.userId === id)?.fullName ?? id.slice(0, 8)) : null);
  const sources = [...new Set(leads.map((l) => l.source))].sort();
  if (source && !sources.includes(source)) sources.push(source);

  const rows: ChatLead[] = leads.map((lead) => ({
    id: lead.id,
    title: lead.title,
    status: lead.status,
    source: lead.source,
    contactName: lead.contact?.fullName ?? null,
    company: lead.contact?.company ?? null,
    time: chatTime(lead.created_at, now, clock),
    ownerName: nameOf(lead.assigned_to),
    tags: lead.tags,
    budget: lead.budgetMinor === null ? null : money(lead.budgetMinor),
  }));

  const preserve = { q, source, owner: params.owner === 'mine' ? 'mine' : owner, status, tag, budgetMin: params.budgetMin, budgetMax: params.budgetMax, createdFrom, createdTo };
  const href = (over: Partial<Record<keyof typeof preserve, string | undefined>>) => {
    const next = { ...preserve, ...over };
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) query.set(k, v);
    const qs = query.toString();
    return `/leads${qs ? `?${qs}` : ''}`;
  };

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

      {/* SCR-006 — the filters. A GET form, so the URL is the filter. */}
      <FilterBar>
        <FilterChips
          options={[
            { key: 'any-source', label: 'Any source', href: href({ source: undefined }), active: !source },
            ...sources.map((s) => ({ key: s, label: humanize(s), href: href({ source: s }), active: source === s })),
          ]}
        />
        <FilterChips
          options={[
            { key: 'anyone', label: 'Anyone', href: href({ owner: undefined }), active: !owner },
            { key: 'mine', label: 'Mine', href: href({ owner: 'mine' }), active: params.owner === 'mine' },
            ...roster
              .filter((m) => m.userId !== context.userId && leads.some((l) => l.assigned_to === m.userId))
              .map((m) => ({ key: m.userId, label: m.fullName, href: href({ owner: m.userId }), active: owner === m.userId })),
          ]}
        />
      </FilterBar>
      <form action="/leads" method="GET" className="grid grid-cols-2 gap-3 rounded-lg border border-subtle bg-surface p-3 sm:grid-cols-4 lg:grid-cols-7">
        {source ? <input type="hidden" name="source" value={source} /> : null}
        {params.owner === 'mine' ? <input type="hidden" name="owner" value="mine" /> : owner ? <input type="hidden" name="owner" value={owner} /> : null}
        <label className="col-span-2 flex flex-col gap-1">
          <span className={labelClass}>Search</span>
          <input type="search" name="q" defaultValue={q} placeholder="Lead title" className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Status</span>
          <select name="status" defaultValue={status ?? ''} className={selectClass}>
            <option value="">Any</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Tag</span>
          <input name="tag" defaultValue={tag} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Budget ≥ ₹</span>
          <input type="number" min="0" name="budgetMin" defaultValue={params.budgetMin} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Budget ≤ ₹</span>
          <input type="number" min="0" name="budgetMax" defaultValue={params.budgetMax} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Created from</span>
          <input type="date" name="createdFrom" defaultValue={createdFrom} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Created to</span>
          <input type="date" name="createdTo" defaultValue={createdTo} className={inputClass} />
        </label>
        <div className="col-span-2 flex flex-wrap items-center gap-2 sm:col-span-4 lg:col-span-6">
          <button type="submit" className={buttonClass('secondary', 'sm')}>
            Apply filters
          </button>
          {filtering ? (
            <Link href="/leads" className={buttonClass('ghost', 'sm')}>
              Clear
            </Link>
          ) : null}
          <span className="text-[12px] text-muted">
            Budget bounds read the qualification&rsquo;s budget; a lead with none on file is left out when a bound is set. There is no
            service column on a lead, so no service filter is offered.
          </span>
        </div>
      </form>

      {leads.length > 0 ? (
        <LeadChatList
          leads={rows}
          bulk={
            canAssign || canWrite
              ? {
                  roster: roster.map((m) => ({ userId: m.userId, fullName: m.fullName })),
                  statuses: LEAD_STATUSES,
                  nurtureReasons: NURTURE_REASONS,
                  canAssign,
                  canWrite,
                }
              : undefined
          }
        />
      ) : filtering ? (
        <EmptyState
          icon={<IconLeads size={22} />}
          title="No leads match these filters"
          description="That is a count of rows, not a guess. Loosen a filter or clear them."
        />
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
