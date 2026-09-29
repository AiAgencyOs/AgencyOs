import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import {
  isDayKey,
  monthGrid,
  monthKeyOf,
  monthLabel,
  shiftDay,
  shiftMonth,
  weekOf,
  WEEKDAY_LABELS,
} from '@/lib/admin/month-grid';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listProjectMeetings } from '@/modules/projects/calendar-queries';
import { getProject, listDevelopmentBreakdown, listPaymentPlan } from '@/modules/projects/queries';
import { Badge, EmptyState, FilterBar, FilterChips, IconClock, PageHeader, cx, humanize, type Tone } from '@/ui';

import { ProjectSubNav } from '../project-subnav';

import { AddTaskOnDayForm } from './add-task-form';

export const metadata: Metadata = { title: 'Calendar' };

const VIEWS = ['month', 'week', 'day', 'list'] as const;
type View = (typeof VIEWS)[number];
const KINDS = ['task', 'milestone', 'meeting'] as const;
type Kind = (typeof KINDS)[number];

type CalendarEntry = {
  id: string;
  date: string;
  label: string;
  kind: Kind;
  status: string;
  overdue: boolean;
  time: string | null;
  href: string | null;
};

const KIND_TONE: Record<Kind, Tone> = { task: 'neutral', milestone: 'brand', meeting: 'info' };

function viewOf(value: string | undefined): View {
  return (VIEWS as readonly string[]).includes(value ?? '') ? (value as View) : 'month';
}

function kindsOf(value: string | undefined): Set<Kind> {
  const picked = (value ?? '').split(',').filter((k): k is Kind => (KINDS as readonly string[]).includes(k));
  return new Set(picked.length > 0 ? picked : KINDS);
}

/**
 * SCR-022 — Project Calendar: month, week, day and list views over the same
 * entries, with type toggles and "create a task on this day".
 *
 * Tasks and milestones come from readers this project page already has
 * (listDevelopmentBreakdown, listPaymentPlan). Meetings are the ones booked
 * on the opportunity this project was won from — `crm.meetings` has no
 * project link, and `listProjectMeetings` reads the one trace the schema
 * carries rather than inventing another. Only a task can be created from a
 * day: a milestone is a line of the payment plan (which must total 100%)
 * and a meeting is booked from a lead, so neither has an honest one-click
 * door here.
 */
export default async function ProjectCalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ view?: string; date?: string; types?: string }>;
}) {
  const { projectId } = await params;
  const { view: rawView, date: rawDate, types } = await searchParams;

  const context = await requireInternal(`/projects/${projectId}/calendar`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const clock = await agencyClock();
  const [{ tasks, modules }, milestones, meetings] = await Promise.all([
    listDevelopmentBreakdown(projectId),
    listPaymentPlan(projectId),
    listProjectMeetings(projectId),
  ]);

  const today = clock.dayKey(new Date());
  const view = viewOf(rawView);
  const kinds = kindsOf(types);
  const anchor = isDayKey(rawDate) ? rawDate : today;
  const mayWrite = can(context.role, 'task.write');

  const entries: CalendarEntry[] = [];
  if (kinds.has('task')) {
    for (const t of tasks) {
      if (!t.dueOn || t.status === 'done') continue;
      entries.push({
        id: `task-${t.id}`,
        date: t.dueOn,
        label: t.title,
        kind: 'task',
        status: t.status,
        overdue: t.dueOn < today,
        time: null,
        href: `/projects/${projectId}/development`,
      });
    }
  }
  if (kinds.has('milestone')) {
    for (const m of milestones) {
      if (!m.due_on || m.status === 'met') continue;
      entries.push({
        id: `milestone-${m.id}`,
        date: m.due_on,
        label: m.name,
        kind: 'milestone',
        status: m.status,
        overdue: m.due_on < today,
        time: null,
        href: `/projects/${projectId}#billing`,
      });
    }
  }
  if (kinds.has('meeting')) {
    for (const m of meetings) {
      if (!m.startAt) continue;
      const date = clock.dayKey(m.startAt);
      entries.push({
        id: `meeting-${m.id}`,
        date,
        label: `${humanize(m.mode ?? 'meeting')}${m.outcome ? ` · ${humanize(m.outcome)}` : ''}`,
        kind: 'meeting',
        status: m.status,
        overdue: false,
        time: clock.clock(m.startAt),
        href: `/leads/${m.leadId}`,
      });
    }
  }
  entries.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));

  const byDate = new Map<string, CalendarEntry[]>();
  for (const e of entries) {
    const list = byDate.get(e.date) ?? [];
    list.push(e);
    byDate.set(e.date, list);
  }

  const base = `/projects/${projectId}/calendar`;
  const typesParam = kinds.size === KINDS.length ? '' : `&types=${[...kinds].join(',')}`;
  const link = (v: View, date: string, k?: Set<Kind>) => {
    const t = k ? (k.size === KINDS.length ? '' : `&types=${[...k].join(',')}`) : typesParam;
    return `${base}?view=${v}&date=${date}${t}`;
  };
  const toggleKind = (k: Kind): Set<Kind> => {
    const next = new Set(kinds);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    // Turning off the last one would show nothing; treat it as "all".
    return next.size === 0 ? new Set(KINDS) : next;
  };
  const moduleOptions = modules.map((m) => ({ id: m.id, name: m.name }));

  const dayLabel = (key: string) => clock.day(`${key}T00:00:00`);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — Calendar`}
        description="Task due dates, milestone deadlines and the meetings booked on this project's deal."
      />

      <ProjectSubNav projectId={projectId} />

      <FilterBar>
        <FilterChips
          options={VIEWS.map((v) => ({ key: v, label: humanize(v), href: link(v, anchor), active: v === view }))}
        />
        <div className="flex flex-wrap items-center gap-2">
          {KINDS.map((k) => (
            <Link
              key={k}
              href={link(view, anchor, toggleKind(k))}
              aria-pressed={kinds.has(k)}
              className={cx(
                'rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset transition-colors',
                kinds.has(k) ? 'bg-surface text-foreground ring-line-strong' : 'bg-surface-sunken text-faint ring-line line-through',
              )}
            >
              {humanize(k)}s
            </Link>
          ))}
        </div>
      </FilterBar>

      {view === 'month' ? (
        <MonthView
          entries={byDate}
          month={monthKeyOf(anchor)}
          today={today}
          link={link}
          projectId={projectId}
          modules={moduleOptions}
          mayWrite={mayWrite}
        />
      ) : view === 'week' ? (
        <WeekView
          entries={byDate}
          anchor={anchor}
          today={today}
          link={link}
          projectId={projectId}
          modules={moduleOptions}
          mayWrite={mayWrite}
          dayLabel={dayLabel}
        />
      ) : view === 'day' ? (
        <DayView
          entries={byDate.get(anchor) ?? []}
          anchor={anchor}
          today={today}
          link={link}
          projectId={projectId}
          modules={moduleOptions}
          mayWrite={mayWrite}
          dayLabel={dayLabel}
        />
      ) : byDate.size > 0 ? (
        <div className="flex flex-col gap-3">
          {[...byDate.entries()].map(([date, dayEntries]) => (
            <div key={date} className="rounded-lg border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className={cx('text-sm font-semibold', date < today && 'text-danger')}>
                  <Link href={link('day', date)} className="underline-offset-2 hover:underline">
                    {dayLabel(date)}
                  </Link>
                  {date < today ? ' — overdue' : date === today ? ' — today' : ''}
                </h3>
                {mayWrite ? <AddTaskOnDayForm projectId={projectId} dueOn={date} modules={moduleOptions} compact /> : null}
              </div>
              <EntryList entries={dayEntries} />
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<IconClock size={22} />}
          title="Nothing scheduled"
          description="Task due dates, milestone deadlines and booked meetings will appear here once they're set."
        />
      )}
    </div>
  );
}

function EntryList({ entries }: { entries: CalendarEntry[] }) {
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {entries.map((e) => (
        <li key={e.id} className="flex flex-wrap items-center gap-2 text-[13px]">
          <Badge tone={KIND_TONE[e.kind]}>{e.kind}</Badge>
          {e.time ? <span className="tabular text-xs text-muted">{e.time}</span> : null}
          {e.href ? (
            <Link href={e.href} className="underline-offset-2 hover:underline">
              {e.label}
            </Link>
          ) : (
            <span>{e.label}</span>
          )}
          <span className="text-xs text-muted">{humanize(e.status)}</span>
        </li>
      ))}
    </ul>
  );
}

function EntryChip({ entry }: { entry: CalendarEntry }) {
  const inner = (
    <>
      {entry.time ? <span className="mr-1 tabular opacity-80">{entry.time}</span> : null}
      {entry.label}
    </>
  );
  const className = cx(
    'block w-full truncate rounded px-1.5 py-0.5 text-left text-xs',
    entry.overdue
      ? 'bg-danger-soft text-danger'
      : entry.kind === 'milestone'
        ? 'bg-brand-soft text-brand'
        : entry.kind === 'meeting'
          ? 'bg-info-soft text-info'
          : 'bg-surface-sunken text-foreground',
  );
  return entry.href ? (
    <Link href={entry.href} className={className} title={`${entry.kind}: ${entry.label}`}>
      {inner}
    </Link>
  ) : (
    <span className={className}>{inner}</span>
  );
}

type NavLink = (v: View, date: string) => string;

function MonthView({
  entries,
  month,
  today,
  link,
  projectId,
  modules,
  mayWrite,
}: {
  entries: Map<string, CalendarEntry[]>;
  month: string;
  today: string;
  link: NavLink;
  projectId: string;
  modules: { id: string; name: string }[];
  mayWrite: boolean;
}) {
  const weeks = monthGrid(month);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{monthLabel(month)}</h2>
        <span className="flex items-center gap-1">
          <Link href={link('month', `${shiftMonth(month, -1)}-01`)} className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-surface-hover">
            ← Previous
          </Link>
          <Link href={link('month', today)} className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-surface-hover">
            Today
          </Link>
          <Link href={link('month', `${shiftMonth(month, 1)}-01`)} className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-surface-hover">
            Next →
          </Link>
        </span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <div className="grid min-w-[700px] grid-cols-7 border-b border-line bg-surface-sunken">
          {WEEKDAY_LABELS.map((d) => (
            <div key={d} className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
              {d}
            </div>
          ))}
        </div>
        {weeks.map((week, wi) => (
          <div key={wi} className="grid min-w-[700px] grid-cols-7 border-b border-line last:border-0">
            {week.map((day) => {
              const dayEntries = entries.get(day.key) ?? [];
              return (
                <div
                  key={day.key}
                  className={cx(
                    'group/day flex min-h-24 flex-col border-r border-line p-1.5 last:border-0',
                    !day.inMonth && 'bg-surface-sunken/60',
                    day.key === today && 'bg-brand-soft/40',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <Link
                      href={link('day', day.key)}
                      className={cx(
                        'text-xs tabular underline-offset-2 hover:underline',
                        day.key === today ? 'font-semibold text-brand' : day.inMonth ? 'text-foreground' : 'text-faint',
                      )}
                    >
                      {day.dayOfMonth}
                    </Link>
                    {mayWrite ? (
                      <span className="opacity-0 transition-opacity group-hover/day:opacity-100 focus-within:opacity-100">
                        <AddTaskOnDayForm projectId={projectId} dueOn={day.key} modules={modules} compact />
                      </span>
                    ) : null}
                  </div>
                  <ul className="mt-1 flex flex-col gap-1">
                    {dayEntries.map((e) => (
                      <li key={e.id}>
                        <EntryChip entry={e} />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function WeekView({
  entries,
  anchor,
  today,
  link,
  projectId,
  modules,
  mayWrite,
  dayLabel,
}: {
  entries: Map<string, CalendarEntry[]>;
  anchor: string;
  today: string;
  link: NavLink;
  projectId: string;
  modules: { id: string; name: string }[];
  mayWrite: boolean;
  dayLabel: (key: string) => string;
}) {
  const days = weekOf(anchor);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">
          {dayLabel(days[0] ?? anchor)} – {dayLabel(days[6] ?? anchor)}
        </h2>
        <span className="flex items-center gap-1">
          <Link href={link('week', shiftDay(anchor, -7))} className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-surface-hover">
            ← Previous
          </Link>
          <Link href={link('week', today)} className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-surface-hover">
            This week
          </Link>
          <Link href={link('week', shiftDay(anchor, 7))} className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-surface-hover">
            Next →
          </Link>
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-7">
        {days.map((key, i) => {
          const dayEntries = entries.get(key) ?? [];
          return (
            <div key={key} className={cx('flex min-h-32 flex-col rounded-lg border border-line bg-surface p-2', key === today && 'ring-2 ring-brand/40')}>
              <div className="flex items-center justify-between">
                <Link href={link('day', key)} className={cx('text-xs font-semibold', key === today ? 'text-brand' : 'text-muted')}>
                  {WEEKDAY_LABELS[i]} {key.slice(8)}
                </Link>
                {mayWrite ? <AddTaskOnDayForm projectId={projectId} dueOn={key} modules={modules} compact /> : null}
              </div>
              <ul className="mt-1.5 flex flex-col gap-1">
                {dayEntries.map((e) => (
                  <li key={e.id}>
                    <EntryChip entry={e} />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DayView({
  entries,
  anchor,
  today,
  link,
  projectId,
  modules,
  mayWrite,
  dayLabel,
}: {
  entries: CalendarEntry[];
  anchor: string;
  today: string;
  link: NavLink;
  projectId: string;
  modules: { id: string; name: string }[];
  mayWrite: boolean;
  dayLabel: (key: string) => string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={cx('text-sm font-semibold', anchor < today ? 'text-danger' : 'text-foreground')}>
          {dayLabel(anchor)}
          {anchor === today ? ' — today' : ''}
        </h2>
        <span className="flex items-center gap-1">
          <Link href={link('day', shiftDay(anchor, -1))} className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-surface-hover">
            ← Previous
          </Link>
          <Link href={link('day', today)} className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-surface-hover">
            Today
          </Link>
          <Link href={link('day', shiftDay(anchor, 1))} className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-surface-hover">
            Next →
          </Link>
        </span>
      </div>
      <div className="rounded-lg border border-line bg-surface p-4">
        {entries.length > 0 ? (
          <EntryList entries={entries} />
        ) : (
          <p className="text-[13px] text-muted">Nothing due or booked on this day.</p>
        )}
        {mayWrite ? (
          <div className="mt-3 border-t border-line pt-3">
            <AddTaskOnDayForm projectId={projectId} dueOn={anchor} modules={modules} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
