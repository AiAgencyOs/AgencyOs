import Link from 'next/link';
import type { ReactNode } from 'react';

import { Avatar, Badge, buttonClass, Card, CardHeader, EmptyState, IconList, IconUsers, ViewAll } from '@/ui';
import { cx } from '@/ui';

import { PLATFORM_LABEL, platformSummary, type DeviceTile, type Platform } from './device-tiles';
import type { QaTeamMember } from './qa-team';

/**
 * Device Testing — the reference's platform tabs over a row of device tiles.
 * A tile is a device a run recorded; its picture is the run's own evidence
 * link when that link is an image, and a plain device outline otherwise (no
 * picture is ever made up). The tabs are links (`?platform=`), not client state.
 */
export function DeviceTestingCard({
  tiles,
  active,
  hrefFor,
  addHref,
  date,
  addForm,
  renderSupport,
}: {
  tiles: readonly DeviceTile[];
  active: Platform | null;
  hrefFor: (platform: Platform | null) => string;
  /** Where a device is added: a run is recorded with its device on the project's QA tab. */
  addHref: string;
  date: (iso: string) => string;
  /** SCR-044 "Add Device": the form, drawn only for whoever may register a device. Omitted, no control is shown. */
  addForm?: ReactNode;
  /** The supported / unsupported control for a registered device's tile. */
  renderSupport?: (tile: DeviceTile) => ReactNode;
}) {
  const summary = platformSummary(tiles);
  const current = active && summary.some((s) => s.platform === active) ? active : (summary[0]?.platform ?? null);
  const shown = tiles.filter((t) => t.platform === current);
  // An unsupported device is not meant to be tested, so it is not in the "Tested" denominator.
  const testable = shown.filter((t) => t.state !== 'unsupported');
  const tested = testable.filter((t) => t.state === 'tested').length;

  return (
    <Card id="device-testing">
      <CardHeader
        title="Device Testing"
        description="Test across multiple devices and platforms — a tile is a device a test run recorded in the last 90 days, or one the agency registered. A configuration the agency does not test is recorded as unsupported, with its reason."
      />
      {addForm ? (
        <details open={tiles.length === 0} className="px-4 pb-3 sm:px-5">
          <summary className={`${buttonClass('secondary', 'sm')} cursor-pointer list-none`}>Add Device</summary>
          <div className="pt-3">{addForm}</div>
        </details>
      ) : null}
      {tiles.length === 0 ? (
        <EmptyState
          icon={<IconList size={22} />}
          title="No device recorded yet"
          description="A tile appears once a test run records the device it ran on."
          action={
            <Link href={addHref} className={buttonClass('secondary', 'sm')}>
              Record a run
            </Link>
          }
        />
      ) : (
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line">
            <nav aria-label="Device platform" className="scrollbar-none -mb-px flex overflow-x-auto">
              {summary.map((s) => (
                <Link
                  key={s.platform}
                  href={hrefFor(s.platform)}
                  aria-current={s.platform === current ? 'page' : undefined}
                  className={cx(
                    'shrink-0 border-b-2 px-3 py-2 text-[13px] font-medium',
                    s.platform === current ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-foreground',
                  )}
                >
                  {PLATFORM_LABEL[s.platform]} ({s.count})
                </Link>
              ))}
            </nav>
            <Badge tone={tested === testable.length ? 'success' : 'warning'} dot>
              {tested}/{testable.length} Tested
            </Badge>
          </div>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]">
            {shown.map((t) => (
              <li key={t.key} className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-line bg-surface p-2.5">
                <div className="flex h-36 items-center justify-center overflow-hidden rounded-md bg-surface-sunken">
                  {t.thumbnailUrl ? (
                    <img src={t.thumbnailUrl} alt={`Latest evidence recorded for ${t.name}`} loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                  ) : (
                    <span aria-hidden className="flex h-28 w-16 items-center justify-center rounded-xl border-2 border-line-strong text-muted">
                      <IconList size={18} />
                    </span>
                  )}
                </div>
                <p className="truncate text-[13px] font-semibold" title={t.name}>{t.name}</p>
                <p className="truncate text-xs text-muted">{t.os ?? PLATFORM_LABEL[t.platform]} · {date(t.lastAt)}</p>
                {t.state === 'unsupported' && t.reason ? <p className="line-clamp-3 text-xs text-muted">Unsupported: {t.reason}</p> : null}
                <div className="flex items-center justify-between gap-1">
                  <Badge tone={t.state === 'tested' ? 'success' : t.state === 'failed' ? 'danger' : t.state === 'unsupported' ? 'neutral' : 'warning'} dot>
                    {t.state === 'tested' ? 'Tested' : t.state === 'failed' ? 'Failed' : t.state === 'unsupported' ? 'Unsupported' : t.state === 'untested' ? 'Not tested yet' : 'In progress'}
                  </Badge>
                  {t.evidenceUrl ? (
                    <a href={t.evidenceUrl} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline">
                      Evidence
                    </a>
                  ) : (
                    <span className="whitespace-nowrap text-xs text-faint">{t.runs} run{t.runs === 1 ? '' : 's'}</span>
                  )}
                </div>
                {renderSupport && t.configId ? renderSupport(t) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/** The QA Team card — people whose project role is QA. No "Online" is claimed. */
export function QaTeamCard({ team, manageHref }: { team: readonly QaTeamMember[]; manageHref: string | null }) {
  return (
    <Card>
      <CardHeader title="QA Team" actions={manageHref ? <ViewAll href={manageHref} label="Manage Team" /> : null} />
      {team.length === 0 ? (
        <EmptyState
          icon={<IconUsers size={22} />}
          title="No QA role on a roster"
          description="Give someone the QA project role on a project's Team tab and they appear here."
          action={
            manageHref ? (
              <Link href={manageHref} className={buttonClass('secondary', 'sm')}>
                Open team
              </Link>
            ) : (
              <Link href="/projects" className={buttonClass('secondary', 'sm')}>
                Open projects
              </Link>
            )
          }
        />
      ) : (
        <ul className="flex flex-col gap-2.5 px-4 pb-4 sm:px-5">
          {team.slice(0, 8).map((m) => (
            <li key={m.userId} className="flex items-center gap-2.5 text-[13px]">
              <Avatar name={m.fullName} size="md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{m.fullName}</span>
                <span className="block truncate text-xs text-muted">
                  QA · {m.projects.length === 1 ? m.projects[0]!.name : `${m.projects.length} projects`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
