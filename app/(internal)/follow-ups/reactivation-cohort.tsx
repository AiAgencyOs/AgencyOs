import Link from 'next/link';

import type { AgencyClock } from '@/lib/admin/agency-clock';
import type { ReactivationCohort } from '@/modules/crm/reactivation-queries';
import { applyReactivationCohortFilter, type ReactivationCohortFilter } from '@/modules/crm/reactivation-types';
import { Badge, buttonClass, Callout, Card, CardHeader, DataTable, EmptyState, FilterChips, humanize, IconRefresh, IconUsers } from '@/ui';

import { EnrolLeadForm } from '../leads/[leadId]/reactivation-panel';

/**
 * Reactivation cohort — SCR-013's sub-screen of Follow-ups. The leads a
 * reactivation could honestly reach: consent recorded, no open follow-up,
 * quiet for N days (`listReactivationCohort`). Each row links to the lead and,
 * when the Import desk created it, to the batch it came from. "Enroll
 * eligible lead with consent" is the lead page's own `EnrolLeadForm`, i.e.
 * `crm.add_lead_to_reactivation_pilot` — the consent guard is that door's,
 * and its refusal is shown in its words. Nothing here sends: an enrolled
 * lead is nurtured by the worker only while the pilot is on.
 */

/** How many rows the section shows before the tile or "Show all" is clicked. */
export const COHORT_PREVIEW = 8;

const FILTER_LABEL: Record<ReactivationCohortFilter, string> = {
  all: 'All',
  imported: 'From an import',
  enrolled: 'Already enrolled',
  not_enrolled: 'Not yet enrolled',
};

export function ReactivationCohortSection({
  cohort,
  filter,
  expanded,
  mayEnrol,
  clock,
  hrefFor,
}: {
  cohort: ReactivationCohort;
  /** The active chip, or null for the preview. */
  filter: ReactivationCohortFilter | null;
  /** True once the tile or a chip was clicked: every row, not the preview. */
  expanded: boolean;
  mayEnrol: boolean;
  clock: AgencyClock;
  /** The URL that sets `cohort=` to a filter (empty string clears it). */
  hrefFor: (filter: ReactivationCohortFilter | '') => string;
}) {
  const active: ReactivationCohortFilter = filter ?? 'all';
  const filtered = applyReactivationCohortFilter(cohort.rows, active);
  const rows = expanded ? filtered : filtered.slice(0, COHORT_PREVIEW);
  const counts = (f: ReactivationCohortFilter) => applyReactivationCohortFilter(cohort.rows, f).length;

  return (
    <Card id="reactivation">
      <CardHeader
        icon={<IconRefresh size={16} />}
        title="Reactivation cohort"
        description={`${cohort.rows.length} lead${cohort.rows.length === 1 ? '' : 's'} with WhatsApp consent recorded, no open follow-up and nothing recorded for ${cohort.inactiveDays} days or more (the panel's default — no organisation setting names a threshold). Of ${cohort.candidates} consented candidate${cohort.candidates === 1 ? '' : 's'}, ${cohort.withOpenFollowUp} already have an open follow-up and ${cohort.recentlyActive} were active inside the window.${cohort.capped ? ' The read hit its cap; the real cohort may be larger.' : ''}`}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            {cohort.pilotEnabled ? <Badge tone="success" dot>pilot on</Badge> : <Badge tone="warning" dot>pilot off</Badge>}
            <Link href="/import" className="text-xs text-brand hover:underline">
              Import desk →
            </Link>
          </span>
        }
      />
      <div className="flex flex-col gap-3 px-4 py-3 sm:px-5">
        {!cohort.pilotEnabled ? (
          <Callout tone="warning">
            The reactivation pilot is off. Enrolling records the decision and nothing else — the inactive-lead rhythm starts only once the pilot is switched on under{' '}
            <Link href="/settings/communication" className="font-medium text-brand hover:underline">Settings › Communication</Link>.
          </Callout>
        ) : null}
        <FilterChips
          options={(['all', 'imported', 'enrolled', 'not_enrolled'] as const).map((f) => ({
            key: f,
            label: `${FILTER_LABEL[f]} (${counts(f)})`,
            href: hrefFor(f),
            active: expanded && active === f,
          }))}
        />
        {rows.length === 0 ? (
          <EmptyState
            icon={<IconUsers size={22} />}
            title={cohort.rows.length === 0 ? 'Nobody to reactivate' : 'No lead matches this chip'}
            description={
              cohort.rows.length === 0
                ? `No consented lead has been quiet for ${cohort.inactiveDays} days without an open follow-up. Consent is recorded on the lead, never assumed; an imported lead joins this cohort only once its consent is recorded.`
                : 'That is a count of rows, not a guess.'
            }
            action={
              cohort.rows.length === 0 ? (
                <Link href="/import" className={buttonClass('secondary', 'sm')}>Open the Import desk</Link>
              ) : (
                <Link href={hrefFor('all')} className={buttonClass('secondary', 'sm')}>Show the whole cohort</Link>
              )
            }
          />
        ) : (
          <DataTable
            rows={rows}
            dense
            columns={[
              {
                key: 'lead',
                header: 'Lead',
                primary: true,
                cell: (r) => (
                  <>
                    <Link href={`/leads/${r.leadId}`} className="block font-medium text-foreground hover:underline">
                      {r.title}
                    </Link>
                    <span className="block text-xs text-muted">
                      {humanize(r.status)} · {humanize(r.source)}
                      {r.phone ? ` · ${r.phone}` : ''}
                    </span>
                  </>
                ),
              },
              { key: 'tier', header: 'Rank', badge: true, desktopOnly: true, cell: (r) => <Badge mono>{humanize(r.tierName)}</Badge> },
              {
                key: 'quiet',
                header: 'Quiet for',
                align: 'right',
                cellClassName: 'tabular',
                cell: (r) => (
                  <span title={clock.dateTime(r.lastActiveAt)}>
                    {r.quietDays} day{r.quietDays === 1 ? '' : 's'}
                  </span>
                ),
              },
              {
                key: 'import',
                header: 'Import batch',
                desktopOnly: true,
                cellClassName: 'text-xs text-muted',
                cell: (r) =>
                  r.importBatchId ? (
                    <Link href={`/import/${r.importBatchId}`} className="hover:underline">
                      {r.importSourceLabel ?? r.importBatchId.slice(0, 8)}
                    </Link>
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'enrol',
                header: '',
                align: 'right',
                cell: (r) =>
                  r.inPilot ? (
                    <Badge tone="success" dot>enrolled</Badge>
                  ) : mayEnrol ? (
                    <EnrolLeadForm leadId={r.leadId} consentEligible compact />
                  ) : (
                    <span className="text-xs text-muted">Owner or ops admin enrols</span>
                  ),
              },
            ]}
            getKey={(r) => r.leadId}
          />
        )}
        {!expanded && filtered.length > rows.length ? (
          <Link href={hrefFor('all')} className="self-start text-[13px] text-brand hover:underline">
            Show all {filtered.length} →
          </Link>
        ) : null}
      </div>
    </Card>
  );
}
