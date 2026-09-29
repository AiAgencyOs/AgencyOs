import type { Metadata } from 'next';
import Link from 'next/link';

import { auditActionPrefixes, auditFacets, changedKeys, readAuditLog } from '@/lib/audit/queries';
import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { Badge, buttonClass, Card, cx, EmptyState, FilterBar, FilterChips, humanize, IconAudit, IconDownload, inputClass, PageHeader, PermissionDenied, selectClass } from '@/ui';

export const metadata: Metadata = { title: 'Audit log' };

function short(id: string | null): string {
  return id ? id.slice(0, 8) : '';
}

function show(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * Audit log — the `audit.audit_log` table, newest first, exactly as the
 * database appended it. Owner/ops-admin only (`audit.read`); RLS also
 * matches it. Filters by action facet, subject type, actor type and a date
 * window; each entry opens to the keys its before/after snapshots disagree
 * on, printed as written — nothing here summarises a change into a verb.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; subject?: string; actor?: string; from?: string; to?: string; correlation?: string }>;
}) {
  const context = await requireInternal('/audit');
  const clock = await agencyClock();
  if (!can(context.role, 'audit.read')) return <PermissionDenied />;

  const { action, subject, actor, from, to, correlation } = await searchParams;
  const isoDay = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const fromDay = isoDay(from);
  const toDay = isoDay(to);

  const [entries, prefixes, facets] = await Promise.all([
    readAuditLog({
      actionPrefix: action,
      subjectType: subject,
      actorType: actor,
      // SCR-066: the audit half of an event chain, linked from /operations.
      correlationId: correlation && /^[0-9a-f-]{36}$/i.test(correlation.trim()) ? correlation.trim() : undefined,
      from: fromDay ? `${fromDay}T00:00:00Z` : undefined,
      to: toDay ? `${toDay}T23:59:59.999Z` : undefined,
      limit: 100,
    }),
    auditActionPrefixes(),
    auditFacets(),
  ]);

  const qs = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { action, subject, actor, from: fromDay, to: toDay, correlation, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  const anyFilter = Boolean(action || subject || actor || fromDay || toDay);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Audit log"
        description="Every gated change — a settled approval, a consent grant, a config toggle — appended here and never edited. Owner and ops-admin only, scoped to this organization."
        actions={
          <a href={`/api/audit/export${qs({})}`} className={buttonClass('secondary', 'sm')}>
            <IconDownload size={14} /> Export CSV
          </a>
        }
      />

      <FilterBar>
        {prefixes.length > 0 ? (
          <FilterChips
            options={[
              { key: 'all', label: 'All actions', href: `/audit${qs({ action: undefined })}`, active: !action },
              ...prefixes.map((p) => ({ key: p, label: p, href: `/audit${qs({ action: p })}`, active: action === p })),
            ]}
          />
        ) : null}
        <form method="get" action="/audit" className="flex flex-wrap items-center gap-2">
          {action ? <input type="hidden" name="action" value={action} /> : null}
          <select name="subject" defaultValue={subject ?? ''} aria-label="Subject type" className={cx(selectClass, 'w-auto')}>
            <option value="">All subjects</option>
            {facets.subjectTypes.map((t) => (
              <option key={t} value={t}>{humanize(t)}</option>
            ))}
          </select>
          <select name="actor" defaultValue={actor ?? ''} aria-label="Actor type" className={cx(selectClass, 'w-auto')}>
            <option value="">All actors</option>
            {facets.actorTypes.map((t) => (
              <option key={t} value={t}>{humanize(t)}</option>
            ))}
          </select>
          <input type="date" name="from" defaultValue={fromDay ?? ''} aria-label="From" className={cx(inputClass, 'w-40')} />
          <input type="date" name="to" defaultValue={toDay ?? ''} aria-label="To" className={cx(inputClass, 'w-40')} />
          <button type="submit" className={buttonClass('secondary', 'sm')}>Apply</button>
          {anyFilter ? <Link href="/audit" className="text-xs text-muted hover:underline">Clear</Link> : null}
        </form>
      </FilterBar>

      {entries.length === 0 ? (
        <EmptyState
          icon={<IconAudit size={22} />}
          title={anyFilter ? 'No matching entries' : 'Nothing has been audited yet'}
          description={anyFilter ? 'No audited action matches these filters.' : 'Gated changes are appended here as they happen.'}
        />
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {entries.map((e) => {
              const keys = e.hasChange ? changedKeys(e.before, e.after) : [];
              return (
                <li key={e.id} className="flex flex-col gap-2 px-4 py-3 sm:px-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-semibold">{e.action}</span>
                        {e.hasChange ? <Badge tone="info">{keys.length > 0 ? `${keys.length} field${keys.length === 1 ? '' : 's'} changed` : 'snapshot'}</Badge> : null}
                      </span>
                      <span className="text-xs text-muted">
                        {e.subjectType ? `${e.subjectType} ${short(e.subjectId)}` : 'no subject'}
                        {e.correlationId ? ` · correlation ${short(e.correlationId)}` : ''}
                      </span>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted">
                      <span className="font-medium text-foreground/70">
                        {e.actorType ?? 'system'}
                        {e.actorId ? ` ${short(e.actorId)}` : ''}
                      </span>
                      <span>{clock.dateTime(e.createdAt)}</span>
                    </div>
                  </div>
                  {e.hasChange ? (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted hover:underline">Before / after</summary>
                      <div className="mt-2 overflow-x-auto rounded-lg border border-line bg-canvas">
                        <table className="w-full text-left">
                          <thead>
                            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                              <th className="px-3 py-1.5 font-semibold">Field</th>
                              <th className="px-3 py-1.5 font-semibold">Before</th>
                              <th className="px-3 py-1.5 font-semibold">After</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(keys.length > 0 ? keys : [...new Set([...Object.keys(e.before ?? {}), ...Object.keys(e.after ?? {})])]).map((k) => (
                              <tr key={k} className="border-b border-line last:border-0 align-top">
                                <td className="px-3 py-1.5 font-mono text-[11px] text-muted">{k}</td>
                                <td className="max-w-xs break-words px-3 py-1.5 font-mono text-[11px] text-danger">{show(e.before?.[k])}</td>
                                <td className="max-w-xs break-words px-3 py-1.5 font-mono text-[11px] text-success">{show(e.after?.[k])}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <p className="text-xs leading-relaxed text-muted">
        Showing the {entries.length} most recent{action ? ` “${action}”` : ''} entries{fromDay || toDay ? ' in the chosen window' : ''}. The audit log
        is append-only — it cannot be edited or deleted, even by the service role.
      </p>
    </div>
  );
}
