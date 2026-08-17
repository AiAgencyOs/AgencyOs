import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { auditActionPrefixes, readAuditLog } from '@/lib/audit/queries';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';

export const metadata: Metadata = { title: 'Audit log · AgencyOS' };

const WHEN = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

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
  if (!can(context.role, 'audit.read')) redirect('/dashboard');

  const { action } = await searchParams;
  const [entries, prefixes] = await Promise.all([
    readAuditLog({ actionPrefix: action, limit: 100 }),
    auditActionPrefixes(),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-sm text-muted">
          Every gated change — a settled approval, a consent grant, a config toggle — appended here and never edited.
          Owner and ops-admin only, scoped to this organization.
        </p>
      </div>

      {prefixes.length > 0 ? (
        <div className="flex flex-wrap gap-2 text-xs">
          <Link
            href="/audit"
            className={`rounded border px-2 py-1 ${!action ? 'border-foreground font-medium' : 'border-default text-muted hover:text-foreground'}`}
          >
            all
          </Link>
          {prefixes.map((p) => (
            <Link
              key={p}
              href={`/audit?action=${encodeURIComponent(p)}`}
              className={`rounded border px-2 py-1 ${action === p ? 'border-foreground font-medium' : 'border-default text-muted hover:text-foreground'}`}
            >
              {p}
            </Link>
          ))}
        </div>
      ) : null}

      {entries.length === 0 ? (
        <p className="rounded-lg border border-black/10 px-4 py-6 text-center text-sm text-muted dark:border-white/15">
          {action ? `No audited actions match “${action}”.` : 'Nothing has been audited yet.'}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-black/5 rounded-lg border border-black/10 dark:divide-white/5 dark:border-white/15">
          {entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">{e.action}</span>
                <span className="text-xs text-muted">
                  {e.subjectType ? `${e.subjectType} ${short(e.subjectId)}` : 'no subject'}
                  {e.hasChange ? ' · changed' : ''}
                </span>
              </div>
              <div className="flex flex-col items-end gap-0.5 text-xs text-muted">
                <span>
                  {e.actorType ?? 'system'}
                  {e.actorId ? ` ${short(e.actorId)}` : ''}
                </span>
                <span>{WHEN.format(new Date(e.createdAt))}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-muted">
        Showing the {entries.length} most recent{action ? ` “${action}”` : ''} entries. The audit log is append-only —
        it cannot be edited or deleted, even by the service role.
      </p>
    </div>
  );
}
