import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { auditActionPrefixes, readAuditLog } from '@/lib/audit/queries';
import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { Badge, Card, cx, EmptyState, IconAudit, PageHeader } from '@/ui';

export const metadata: Metadata = { title: 'Audit log' };

const short = (id: string | null) => (id ? id.slice(0, 8) : '—');

/**
 * Who changed what, and when — area M.
 *
 * The append-only `audit.audit_log` is the record every gated transition writes
 * to; this is the first place the product reads it back. RLS (`audit_log_select`)
 * bounds it to an owner or ops_admin of their own organization, so the page
 * carries no gate the database does not already enforce — `audit.read` here
 * matches it. It filters by action facet (organization·, consent·, message·…);
 * the before/after diff is not spread to the list, only its presence.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>;
}) {
  const context = await requireInternal('/audit');
  const clock = await agencyClock();
  if (!can(context.role, 'audit.read')) redirect('/dashboard');

  const { action } = await searchParams;
  const [entries, prefixes] = await Promise.all([
    readAuditLog({ actionPrefix: action, limit: 100 }),
    auditActionPrefixes(),
  ]);

  // The filter rail scrolls sideways on a phone rather than wrapping to five
  // rows of chips and pushing the log itself off the screen.
  const chip = (current: boolean) =>
    cx(
      'shrink-0 rounded-full px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors',
      current
        ? 'bg-brand text-brand-fg'
        : 'bg-surface text-muted ring-1 ring-inset ring-line hover:text-foreground',
    );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Audit log"
        description="Every gated change — a settled approval, a consent grant, a config toggle — appended here and never edited. Owner and ops-admin only, scoped to this organization."
      />

      {prefixes.length > 0 ? (
        <div className="no-scrollbar snap-rail -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <Link href="/audit" className={chip(!action)}>
            All
          </Link>
          {prefixes.map((p) => (
            <Link
              key={p}
              href={`/audit?action=${encodeURIComponent(p)}`}
              className={chip(action === p)}
            >
              {p}
            </Link>
          ))}
        </div>
      ) : null}

      {entries.length === 0 ? (
        <EmptyState
          icon={<IconAudit size={22} />}
          title={action ? 'No matching entries' : 'Nothing has been audited yet'}
          description={
            action
              ? `No audited actions match “${action}”.`
              : 'Gated changes are appended here as they happen.'
          }
        />
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {entries.map((e) => (
              <li
                key={e.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold">{e.action}</span>
                    {e.hasChange ? <Badge tone="info">changed</Badge> : null}
                  </span>
                  <span className="text-xs text-muted">
                    {e.subjectType ? `${e.subjectType} ${short(e.subjectId)}` : 'no subject'}
                  </span>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted">
                  <span className="font-medium text-foreground/70">
                    {e.actorType ?? 'system'}
                    {e.actorId ? ` ${short(e.actorId)}` : ''}
                  </span>
                  <span>{clock.dateTime(e.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="text-xs leading-relaxed text-muted">
        Showing the {entries.length} most recent{action ? ` “${action}”` : ''} entries. The audit log
        is append-only — it cannot be edited or deleted, even by the service role.
      </p>
    </div>
  );
}
