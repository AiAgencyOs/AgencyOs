'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useId, useMemo, useRef, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { createTaskAction, setTaskStatusAction, updateTaskAction } from '@/modules/projects/actions';
import type { TaskCollab } from '@/modules/projects/task-collab-queries';
import { GROUP_BY_OPTIONS, groupKeyOf, groupsFor, type GroupBy } from '@/modules/projects/project-view-derive';

import { BlockReasonField, TaskCollabPanel } from '../../../task-collab-panel';
import {
  Avatar,
  Badge,
  buttonClass,
  Callout,
  cx,
  filterChipClass,
  Drawer,
  FormMessage,
  IconAlert,
  IconAttach,
  IconCalendar,
  IconCheck,
  IconList,
  IconMessage,
  IconMore,
  IconPlus,
  IconSearch,
  inputClass,
  KanbanBoard,
  labelClass,
  ProgressBar,
  selectClass,
  StatusBadge,
  textareaClass,
  type KanbanColumn,
  type KanbanItem,
} from '@/ui';

export type BoardTask = KanbanItem & {
  /** The task's real status; `columnId` is the group it is drawn under (the same thing when grouped by status). */
  status: string;
  title: string;
  description: string | null;
  estimateHours: number | null;
  priority: string;
  assigneeId: string | null;
  assigneeName: string | null;
  /** SCR-020: the payment milestone ("phase") the task is filed under. */
  milestoneId: string | null;
  milestoneName: string | null;
  /** The sprint of this project the task is placed in (20261005100000). */
  sprintId: string | null;
  moduleId: string | null;
  moduleName: string | null;
  dueOn: string | null;
  startOn: string | null;
  labels: string[];
  dueLabel: string | null;
  completedLabel: string | null;
  overdue: boolean;
};

type SortKey = '' | 'due' | 'priority' | 'title';

export type BoardModule = { id: string; name: string };
export type BoardPerson = { userId: string; fullName: string };
/** SCR-020: the payment milestone a task is filed under — the Board's "phase" filter. */
export type BoardMilestone = { id: string; name: string };
/** A sprint of the project — the Board's "sprint" filter. */
export type BoardSprint = { id: string; name: string };

const PRIORITY: Record<string, { label: string; tone: 'danger' | 'warning' | 'info' | 'neutral' }> = {
  p0: { label: 'Critical', tone: 'danger' },
  p1: { label: 'High', tone: 'warning' },
  p2: { label: 'Medium', tone: 'info' },
  p3: { label: 'Low', tone: 'neutral' },
};

/**
 * The interactive half of the Project Board (SCR-020), drawn as the reference
 * draws it: a filter toolbar, five tinted columns, cards carrying the module
 * and priority chips, the assignee and the due date, "+ Add task" in every
 * column, and a task summary beside the recent completions underneath.
 *
 * A client component because dragging and filtering are inherently
 * client-side; every write still goes through the same Server Actions the
 * Development page calls (`setTaskStatusAction`, `createTaskAction`), so
 * this adds no second writer for `projects.tasks`. `task.write` is
 * re-checked inside those actions regardless of what this component sends —
 * a read-only role seeing `disabled` cards is a UX courtesy, not the
 * enforcement. The filters are a view over the rows the page read; they
 * never fetch.
 */
/** Open (not done) task counts keyed by `key`, most first; `null` keys are kept (unassigned / no module). */
function countBy(tasks: readonly BoardTask[], key: (t: BoardTask) => string | null): [string | null, number][] {
  const counts = new Map<string | null, number>();
  for (const t of tasks) {
    if (t.status === 'done') continue;
    counts.set(key(t), (counts.get(key(t)) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export function ProjectBoard({
  projectId,
  columns,
  tasks,
  modules,
  people,
  roster,
  rosterSource = 'roster',
  milestones = [],
  initialMilestone,
  sprints = [],
  initialSprint,
  canWrite,
  collab,
  currentUserId,
  todayKey,
  rail,
}: {
  projectId: string;
  columns: KanbanColumn[];
  tasks: BoardTask[];
  modules: BoardModule[];
  /** People with a task on this board — the assignee filter. */
  people: BoardPerson[];
  /** Who a task may be assigned to — the project's members, or the organisation roster when it has none (20261001120000). */
  roster: BoardPerson[];
  rosterSource?: 'members' | 'roster';
  /** SCR-020: the payment milestones — the "phase" filter. */
  milestones?: BoardMilestone[];
  /** `?milestone=` — the Plan page's "open tasks" link lands here pre-filtered. */
  initialMilestone?: string;
  /** The project's sprints — the "sprint" filter. */
  sprints?: BoardSprint[];
  /** `?sprint=` — a sprint id or `none`. */
  initialSprint?: string;
  canWrite: boolean;
  /** Comments, checklist, attachments and the blocker per task id — SCR-020. */
  collab: Record<string, TaskCollab>;
  currentUserId: string;
  todayKey: string;
  /** The rest of the right-hand rail (timeline, team, summary) — server-rendered by the page and drawn under Task details. */
  rail?: React.ReactNode;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState('');
  const [moduleFilter, setModuleFilter] = useState('');
  const [milestoneFilter, setMilestoneFilter] = useState(initialMilestone ?? '');
  const [sprintFilter, setSprintFilter] = useState(initialSprint ?? '');
  const [sort, setSort] = useState<SortKey>('');
  const [quick, setQuick] = useState<QuickFilter>('');
  const [groupBy, setGroupBy] = useState<GroupBy>('status');
  const [view, setView] = useState<'board' | 'list'>('board');
  const [adding, setAdding] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const groupId = useId();
  // A card dropped on Blocked waits here for its reason — the drop's promise
  // stays pending (so the optimistic move holds) until the prompt answers.
  const [blockPrompt, setBlockPrompt] = useState<{ task: BoardTask; resolve: (reason: string | null) => void } | null>(null);
  const openTask = tasks.find((t) => t.id === openTaskId) ?? null;

  function select(task: BoardTask) {
    setOpenTaskId(task.id);
    // Below the wide layout the rail sits under the board: bring it into view.
    if (typeof window !== 'undefined' && window.innerWidth < 1280) railRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function handleMove(taskId: string, toStatus: string, reason?: string) {
    setError(null);
    let why = reason ?? '';
    if (toStatus === 'blocked' && !why) {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;
      const answer = await new Promise<string | null>((resolve) => setBlockPrompt({ task, resolve }));
      setBlockPrompt(null);
      if (!answer) throw new Error('A reason is required to block a task.');
      why = answer;
    }
    const formData = new FormData();
    formData.set('taskId', taskId);
    formData.set('status', toStatus);
    formData.set('projectId', projectId);
    if (why) formData.set('reason', why);

    const result = await setTaskStatusAction(IDLE_STATE, formData);
    if (result.status === 'error') {
      setError(result.message ?? 'Could not move this task.');
      throw new Error(result.message ?? 'Could not move this task.');
    }
    router.refresh();
  }

  const weekEnd = useMemo(() => {
    const d = new Date(`${todayKey}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  }, [todayKey]);
  const quickTest = useMemo<Record<Exclude<QuickFilter, ''>, (t: BoardTask) => boolean>>(
    () => ({
      mine: (t) => t.assigneeId === currentUserId,
      overdue: (t) => t.overdue,
      week: (t) => t.status !== 'done' && t.dueOn !== null && t.dueOn >= todayKey && t.dueOn <= weekEnd,
      high: (t) => t.status !== 'done' && (t.priority === 'p0' || t.priority === 'p1'),
      files: (t) => (collab[t.id]?.attachments.length ?? 0) > 0,
    }),
    [currentUserId, todayKey, weekEnd, collab],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = tasks.filter(
      (t) =>
        (!q || t.title.toLowerCase().includes(q)) &&
        (!assignee || (assignee === 'unassigned' ? t.assigneeId === null : t.assigneeId === assignee)) &&
        (!priority || t.priority === priority) &&
        (!moduleFilter || t.moduleId === moduleFilter) &&
        (!milestoneFilter || (milestoneFilter === 'none' ? t.milestoneId === null : t.milestoneId === milestoneFilter)) &&
        (!sprintFilter || (sprintFilter === 'none' ? t.sprintId === null : t.sprintId === sprintFilter)) &&
        (!quick || quickTest[quick](t)),
    );
    if (sort === 'due') rows.sort((a, b) => (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'));
    else if (sort === 'priority') rows.sort((a, b) => a.priority.localeCompare(b.priority));
    else if (sort === 'title') rows.sort((a, b) => a.title.localeCompare(b.title));
    return rows;
  }, [tasks, query, assignee, priority, moduleFilter, milestoneFilter, sprintFilter, sort, quick, quickTest]);

  const filtered = visible.length !== tasks.length;

  // The columns: the five statuses, or one per value of the chosen grouping.
  const groupedColumns: KanbanColumn[] = useMemo(() => {
    if (groupBy === 'status') return columns;
    const labels = {
      assignees: new Map(people.concat(roster).map((p) => [p.userId, p.fullName] as const)),
      modules: new Map(modules.map((m) => [m.id, m.name] as const)),
      phases: new Map(milestones.map((m) => [m.id, m.name] as const)),
    };
    return groupsFor(visible, groupBy, labels, { statuses: columns.map((c) => c.id), phases: milestones.map((m) => m.id) }).map((g) => ({ id: g.key, label: g.label, tone: 'neutral' as const }));
  }, [groupBy, columns, visible, people, roster, modules, milestones]);
  const groupedItems: BoardTask[] = useMemo(() => visible.map((t) => ({ ...t, columnId: groupKeyOf({ status: t.status, assigneeId: t.assigneeId, priority: t.priority, moduleId: t.moduleId, milestoneId: t.milestoneId }, groupBy) })), [visible, groupBy]);

  const clearFilters = () => {
    setQuery('');
    setAssignee('');
    setPriority('');
    setModuleFilter('');
    setMilestoneFilter('');
    setSprintFilter('');
    setQuick('');
  };
  const quickCounts = {
    mine: tasks.filter(quickTest.mine).length,
    overdue: tasks.filter(quickTest.overdue).length,
    week: tasks.filter(quickTest.week).length,
    high: tasks.filter(quickTest.high).length,
    files: tasks.filter(quickTest.files).length,
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_17rem]">
      <div className="flex min-w-0 flex-col gap-4">
      {error ? (
        <Callout tone="danger" icon={<IconAlert size={16} />}>
          {error}
        </Callout>
      ) : null}

      <section aria-labelledby="task-board-heading" className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-3 shadow-xs sm:p-4">
      <h2 id="task-board-heading" className="text-base font-bold tracking-tight text-foreground">Task board</h2>
      {/* ── Toolbar ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative w-full sm:w-auto sm:min-w-[14rem] sm:flex-1 sm:max-w-xs">
          <span className="sr-only">Search tasks</span>
          <IconSearch size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tasks…" className={cx(inputClass, 'pl-8')} />
        </label>
        <select aria-label="Filter by assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} className={cx(selectClass, 'sm:w-auto sm:min-w-[9rem]')}>
          <option value="">All assignees</option>
          <option value="unassigned">Unassigned</option>
          {people.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.fullName}
            </option>
          ))}
        </select>
        {modules.length > 0 ? (
          <select aria-label="Filter by module" value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)} className={cx(selectClass, 'sm:w-auto sm:min-w-[9rem]')}>
            <option value="">All modules</option>
            {modules.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        ) : null}
        <select aria-label="Filter by priority" value={priority} onChange={(e) => setPriority(e.target.value)} className={cx(selectClass, 'sm:w-auto sm:min-w-[8rem]')}>
          <option value="">All priority</option>
          {Object.entries(PRIORITY).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        {/* SCR-020: the phase filter — the payment milestone a task is filed under. */}
        {milestones.length > 0 ? (
          <select aria-label="Filter by phase" value={milestoneFilter} onChange={(e) => setMilestoneFilter(e.target.value)} className={cx(selectClass, 'sm:w-auto sm:min-w-[9rem]')}>
            <option value="">All phases</option>
            {milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            <option value="none">No milestone</option>
          </select>
        ) : null}
        {/* Owner decision 1: the sprint filter — the sprint of this project a task is placed in. */}
        {sprints.length > 0 ? (
          <select aria-label="Filter by sprint" value={sprintFilter} onChange={(e) => setSprintFilter(e.target.value)} className={cx(selectClass, 'sm:w-auto sm:min-w-[9rem]')}>
            <option value="">All sprints</option>
            {sprints.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value="none">Not in a sprint</option>
          </select>
        ) : null}
        {rosterSource === 'members' ? <span className="text-[11px] text-muted" title="Assignees are the project's members; the organisation roster is offered when a project has none.">assignees: project members</span> : null}
        <select aria-label="Sort tasks" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className={cx(selectClass, 'sm:w-auto sm:min-w-[8rem]')}>
          <option value="">Sort: default</option>
          <option value="due">Sort: due date</option>
          <option value="priority">Sort: priority</option>
          <option value="title">Sort: title</option>
        </select>
        <label className="flex items-center gap-1.5 text-[13px] text-muted" htmlFor={groupId}>
          Group by
          <select id={groupId} value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} className={cx(selectClass, 'sm:w-auto sm:min-w-[7.5rem]')}>
            {GROUP_BY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <div role="group" aria-label="View" className="flex overflow-hidden rounded-lg border border-line">
          {(['board', 'list'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className={cx('h-9 px-3 text-[13px] font-medium', view === v ? 'bg-brand-soft text-brand' : 'bg-surface text-muted hover:text-foreground')}>
              {v === 'board' ? 'Board' : 'List'}
            </button>
          ))}
          <Link href={`/projects/${projectId}/calendar`} className="flex h-9 items-center border-l border-line bg-surface px-3 text-[13px] font-medium text-muted hover:text-foreground">
            Calendar
          </Link>
        </div>
        <span className="ml-auto text-xs text-muted">
          {filtered ? `${visible.length} of ${tasks.length}` : tasks.length} task{tasks.length === 1 ? '' : 's'}
          {filtered ? (
            <button type="button" onClick={clearFilters} className="ml-2 font-medium text-brand hover:underline">
              Clear
            </button>
          ) : null}
        </span>
        {canWrite ? (
          <button type="button" onClick={() => setAdding(columns[0]?.id ?? 'todo')} className={buttonClass('primary', 'sm')}>
            <IconPlus size={14} />
            Add task
          </button>
        ) : null}
      </div>

      {/* SCR-020: open-task counts per assignee and per module, on the board
          itself. Each chip is also the filter for that person or module. */}
      {tasks.some((t) => t.status !== 'done') ? (
        <div className="flex flex-col gap-1.5 text-[13px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Open by assignee</span>
            {countBy(tasks, (t) => t.assigneeId).map(([id, n]) => (
              <button
                key={id ?? 'unassigned'}
                type="button"
                onClick={() => setAssignee(assignee === (id ?? 'unassigned') ? '' : (id ?? 'unassigned'))}
                aria-pressed={assignee === (id ?? 'unassigned')}
                className={filterChipClass(assignee === (id ?? 'unassigned'))}
              >
                {id ? (people.find((p) => p.userId === id)?.fullName ?? 'Unknown') : 'Unassigned'} · {n}
              </button>
            ))}
          </div>
          {modules.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Open by module</span>
              {countBy(tasks, (t) => t.moduleId).map(([id, n]) => (
                <button
                  key={id ?? 'none'}
                  type="button"
                  onClick={() => setModuleFilter(id && moduleFilter !== id ? id : '')}
                  aria-pressed={id !== null && moduleFilter === id}
                  className={filterChipClass(id !== null && moduleFilter === id)}
                  disabled={id === null}
                >
                  {id ? (modules.find((m) => m.id === id)?.name ?? 'Unknown module') : 'No module'} · {n}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {groupBy !== 'status' && view === 'board' ? (
        <p className="text-xs text-muted">Grouped by {GROUP_BY_OPTIONS.find((o) => o.value === groupBy)?.label.toLowerCase()}: cards do not move between these columns. Group by status to drag a task.</p>
      ) : null}

      {view === 'board' ? (
        <KanbanBoard
          key={groupBy}
          columns={groupedColumns}
          items={groupedItems}
          disabled={!canWrite || groupBy !== 'status'}
          onMove={handleMove}
          renderColumnAction={(col) =>
            canWrite && groupBy === 'status' ? (
              <button type="button" onClick={() => setAdding(col.id)} aria-label={`Add task in ${col.label}`} className="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-foreground">
                <IconPlus size={14} />
              </button>
            ) : null
          }
          renderColumnFooter={(col) =>
            canWrite && groupBy === 'status' ? (
              <button type="button" onClick={() => setAdding(col.id)} className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-brand transition-colors hover:bg-brand-soft">
                <IconPlus size={13} />
                Add task
              </button>
            ) : null
          }
          renderCard={(task) => <TaskCard task={task} selected={task.id === openTaskId} collab={collab[task.id]} onOpen={() => select(task)} />}
        />
      ) : (
        <TaskListView columns={groupedColumns} items={groupedItems} selectedId={openTaskId} onSelect={select} />
      )}

      </section>

      <BlockReasonPrompt
        task={blockPrompt?.task ?? null}
        onAnswer={(reason) => blockPrompt?.resolve(reason)}
      />

      {canWrite ? (
        <AddTaskDrawer
          projectId={projectId}
          status={adding}
          statusLabel={columns.find((c) => c.id === adding)?.label ?? 'To do'}
          modules={modules}
          onClose={() => setAdding(null)}
          onCreated={() => {
            setAdding(null);
            router.refresh();
          }}
        />
      ) : null}
      </div>

      {/* ── The always-open rail: the selected task, quick filters, then the page's own cards ── */}
      <div className="flex min-w-0 flex-col gap-4">
        <div ref={railRef} className="scroll-mt-4 rounded-xl border border-line bg-surface p-4 shadow-xs">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold tracking-tight text-foreground">Task details</h2>
            {openTask ? (
              <button type="button" onClick={() => setOpenTaskId(null)} aria-label="Close task details" className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-foreground">
                <span aria-hidden>×</span>
              </button>
            ) : null}
          </div>
          {openTask ? (
            <TaskDetails
              task={openTask}
              collab={collab[openTask.id]}
              projectId={projectId}
              columns={columns}
              roster={roster}
              canWrite={canWrite}
              onMoved={(taskId, toStatus, reason) => {
                handleMove(taskId, toStatus, reason).catch(() => undefined);
              }}
              onSaved={() => setOpenTaskId(null)}
            />
          ) : (
            <div className="flex flex-col items-center gap-1.5 px-2 py-8 text-center">
              <span aria-hidden className="mb-1 flex h-12 w-12 items-center justify-center rounded-xl bg-surface-sunken text-faint">
                <IconList size={22} />
              </span>
              <p className="text-[13px] font-semibold text-foreground">Select a task</p>
              <p className="text-xs text-muted">Click any task to view details, comments, attachments and activity.</p>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-line bg-surface p-4 shadow-xs">
          <h2 className="text-base font-bold tracking-tight text-foreground">Quick filters</h2>
          <ul className="mt-2 flex flex-col">
            {QUICK_FILTERS.map((f) => (
              <li key={f.key}>
                <button
                  type="button"
                  aria-pressed={quick === f.key}
                  onClick={() => setQuick(quick === f.key ? '' : f.key)}
                  className={cx('flex h-9 w-full items-center justify-between gap-2 rounded-lg px-2 text-[13px] font-medium', quick === f.key ? 'bg-brand-soft text-brand' : 'text-foreground hover:bg-surface-hover')}
                >
                  {f.label}
                  <span className="tabular rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] text-muted">{quickCounts[f.key]}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {rail}
      </div>
    </div>
  );
}

type QuickFilter = '' | 'mine' | 'overdue' | 'week' | 'high' | 'files';
const QUICK_FILTERS: { key: Exclude<QuickFilter, ''>; label: string }[] = [
  { key: 'mine', label: 'My tasks' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'week', label: 'Due this week' },
  { key: 'high', label: 'High priority' },
  { key: 'files', label: 'With attachments' },
];

/** The reference's List view: the same filtered tasks as a table, one section per group. */
function TaskListView({ columns, items, selectedId, onSelect }: { columns: KanbanColumn[]; items: BoardTask[]; selectedId: string | null; onSelect: (task: BoardTask) => void }) {
  if (items.length === 0) return <p className="py-6 text-center text-[13px] text-muted">No task matches these filters.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
            <th className="py-2 pr-3">Task</th>
            <th className="py-2 pr-3">Assignee</th>
            <th className="py-2 pr-3">Priority</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2">Due date</th>
          </tr>
        </thead>
        {columns.map((col) => {
          const rows = items.filter((t) => t.columnId === col.id);
          if (rows.length === 0) return null;
          return (
            <tbody key={col.id} className="divide-y divide-line">
              <tr className="bg-surface-sunken">
                <th colSpan={5} scope="colgroup" className="px-2 py-1.5 text-left text-[12px] font-semibold text-foreground">
                  {col.label} <span className="font-normal text-muted">({rows.length})</span>
                </th>
              </tr>
              {rows.map((t) => {
                const p = PRIORITY[t.priority] ?? { label: t.priority, tone: 'neutral' as const };
                return (
                  <tr key={t.id} className={selectedId === t.id ? 'bg-brand-soft' : 'hover:bg-surface-hover'}>
                    <td className="py-2 pr-3">
                      <button type="button" onClick={() => onSelect(t)} className="text-left font-medium text-foreground hover:underline">{t.title}</button>
                    </td>
                    <td className="py-2 pr-3 text-muted">{t.assigneeName ?? 'Unassigned'}</td>
                    <td className="py-2 pr-3"><Badge tone={p.tone}>{p.label}</Badge></td>
                    <td className="py-2 pr-3"><StatusBadge status={t.status} dot={false} /></td>
                    <td className={cx('whitespace-nowrap py-2', t.overdue ? 'font-medium text-danger' : 'text-muted')}>{t.dueLabel ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

function TaskCard({ task, selected, collab, onOpen }: { task: BoardTask; selected: boolean; collab: TaskCollab | undefined; onOpen: () => void }) {
  const p = PRIORITY[task.priority] ?? { label: task.priority.toUpperCase(), tone: 'neutral' as const };
  const progress = collab?.progress;
  const comments = collab?.comments.length ?? 0;
  const attachments = collab?.attachments.length ?? 0;
  return (
    <div className={cx('rounded-lg border bg-surface p-3 shadow-xs transition-shadow hover:shadow-sm', selected ? 'border-brand ring-1 ring-brand' : 'border-line')}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium leading-snug text-foreground">{task.title}</p>
        <button
          type="button"
          aria-label={`Show details of ${task.title}`}
          onClick={onOpen}
          className="-mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-surface-hover hover:text-foreground"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <IconMore size={14} />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {task.moduleName ? <Badge tone="info">{task.moduleName}</Badge> : null}
        {task.labels.map((l) => (
          <Badge key={l} tone="neutral">{l}</Badge>
        ))}
        <Badge tone={p.tone}>{p.label}</Badge>
      </div>
      {task.status === 'blocked' && collab?.blocked.reason ? (
        <p className="mt-2 flex items-start gap-1 text-[11px] text-danger" title={collab.blocked.reason}>
          <IconAlert size={11} className="mt-0.5 shrink-0" />
          <span className="line-clamp-2">{collab.blocked.reason}</span>
        </p>
      ) : null}
      {progress && progress.total > 0 ? (
        <div className="mt-2" title={`${progress.done} of ${progress.total} checklist items done`}>
          <ProgressBar value={progress.percent} size="sm" tone={progress.percent === 100 ? 'success' : 'brand'} label={`${task.title} checklist`} showValue={false} />
          <span className="tabular mt-0.5 block text-[10px] text-muted">
            {progress.done}/{progress.total} steps
          </span>
        </div>
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="flex min-w-0 items-center gap-2">
          {task.assigneeName ? <Avatar name={task.assigneeName} size="sm" /> : <span className="h-6 w-6 rounded-full border border-dashed border-line-strong" aria-label="Unassigned" />}
          {task.dueLabel ? (
            <span className={cx('flex items-center gap-1 whitespace-nowrap text-[11px]', task.overdue ? 'font-medium text-danger' : 'text-muted')}>
              <IconCalendar size={12} />
              {task.dueLabel}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-2 text-[11px] text-muted">
          {comments > 0 ? (
            <span className="flex items-center gap-0.5" title={`${comments} comment${comments === 1 ? '' : 's'}`}>
              <IconMessage size={11} />
              {comments}
            </span>
          ) : null}
          {attachments > 0 ? (
            <span className="flex items-center gap-0.5" title={`${attachments} attachment${attachments === 1 ? '' : 's'}`}>
              <IconAttach size={11} />
              {attachments}
            </span>
          ) : null}
          {task.completedLabel ? (
            <span className="flex items-center gap-1 text-success">
              <IconCheck size={12} />
              Done
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/**
 * The question a drop on Blocked asks — SCR-020's blocker field. Cancelling
 * answers `null`, and the card snaps back to where it was.
 */
function BlockReasonPrompt({ task, onAnswer }: { task: BoardTask | null; onAnswer: (reason: string | null) => void }) {
  return (
    <Drawer open={task !== null} onClose={() => onAnswer(null)} title="Block this task" description={task?.title}>
      {task ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
            if (reason) onAnswer(reason);
          }}
          className="flex flex-col gap-3"
        >
          <BlockReasonField taskId={task.id} />
          <div className="flex items-center gap-2">
            <button type="submit" className={buttonClass('primary', 'md')}>
              Mark blocked
            </button>
            <button type="button" onClick={() => onAnswer(null)} className={buttonClass('ghost', 'md')}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </Drawer>
  );
}

/**
 * The task detail — the reference's task screen: title, description,
 * module, priority, assignee, due date, status, and (since
 * 20260929140000) the blocker, checklist, comments and attachments through
 * `<TaskCollabPanel>`. Time logs are still not drawn — no such table
 * exists — and the drawer says so rather than showing an empty section.
 */

/** A task the collaboration read did not cover (it always does; this is the type-safe fallback). */
const EMPTY_COLLAB = (taskId: string): TaskCollab => ({
  taskId,
  comments: [],
  checklist: [],
  progress: { done: 0, total: 0, percent: 0 },
  attachments: [],
  blocked: { reason: null, at: null, sinceLabel: null },
});
function TaskDetails({
  task,
  collab,
  projectId,
  columns,
  roster,
  canWrite,
  onMoved,
  onSaved,
}: {
  task: BoardTask;
  collab: TaskCollab | undefined;
  projectId: string;
  columns: KanbanColumn[];
  roster: BoardPerson[];
  canWrite: boolean;
  onSaved: () => void;
  onMoved: (taskId: string, toStatus: string, reason?: string) => void;
}) {
  const p = PRIORITY[task.priority] ?? { label: task.priority.toUpperCase(), tone: 'neutral' as const };
  // Choosing Blocked in the select does not move the task by itself: the
  // reason field appears and the move is one submit with both in it.
  const [blocking, setBlocking] = useState(false);
  const taskId = task.id;
  useEffect(() => setBlocking(false), [taskId]);
  return (
    <div className="mt-3 flex flex-col gap-4 text-[13px]">
      <div>
        <Link href={`/projects/${projectId}/development/tasks/${task.id}`} className="text-[15px] font-semibold leading-snug text-foreground hover:underline">{task.title}</Link>
        {task.moduleName ? <p className="mt-0.5 text-xs text-muted">Module · {task.moduleName}</p> : null}
        {task.labels.length > 0 ? (
          <p className="mt-1.5 flex flex-wrap gap-1.5">
            {task.labels.map((l) => (
              <Badge key={l} tone="neutral">{l}</Badge>
            ))}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-line p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Status</p>
              {canWrite ? (
                <select
                  aria-label="Task status"
                  value={blocking ? 'blocked' : task.status}
                  onChange={(e) => {
                    if (e.target.value === 'blocked' && task.status !== 'blocked') setBlocking(true);
                    else {
                      setBlocking(false);
                      if (e.target.value !== task.status) onMoved(task.id, e.target.value);
                    }
                  }}
                  className={cx(selectClass, 'mt-1')}
                >
                  {columns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="mt-1"><StatusBadge status={task.status} /></p>
              )}
            </div>
            <div className="rounded-lg border border-line p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Priority</p>
              <p className="mt-1.5"><Badge tone={p.tone}>{p.label}</Badge></p>
            </div>
            <div className="rounded-lg border border-line p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Assignee</p>
              <p className="mt-1.5 flex items-center gap-2">
                {task.assigneeName ? <><Avatar name={task.assigneeName} size="sm" /> {task.assigneeName}</> : <span className="text-muted">Unassigned</span>}
              </p>
            </div>
            <div className="rounded-lg border border-line p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Due date</p>
              <p className={cx('mt-1.5 flex items-center gap-1.5', task.overdue ? 'font-medium text-danger' : '')}>
                <IconCalendar size={13} />
                {task.dueLabel ?? <span className="text-muted">Not set</span>}
              </p>
            </div>
          </div>
          {blocking ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
                if (reason) onMoved(task.id, 'blocked', reason);
              }}
              className="flex flex-col gap-2"
            >
              <BlockReasonField taskId={task.id} />
              <div className="flex items-center gap-2">
                <button type="submit" className={buttonClass('primary', 'sm')}>
                  Mark blocked
                </button>
                <button type="button" onClick={() => setBlocking(false)} className={buttonClass('ghost', 'sm')}>
                  Cancel
                </button>
              </div>
            </form>
          ) : null}
          {canWrite ? (
            <TaskEditForm key={task.id} task={task} projectId={projectId} roster={roster} onSaved={onSaved} />
          ) : (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Description</p>
              {task.description ? <p className="mt-1 whitespace-pre-wrap leading-relaxed">{task.description}</p> : <p className="mt-1 text-muted">No description recorded.</p>}
            </div>
          )}
          {task.completedLabel ? (
            <p className="flex items-center gap-1.5 text-success">
              <IconCheck size={13} />
              Completed {task.completedLabel}
            </p>
          ) : null}
          <div className="border-t border-line pt-4">
            <TaskCollabPanel projectId={projectId} taskId={task.id} status={task.status} collab={collab ?? EMPTY_COLLAB(task.id)} canWrite={canWrite} compact />
          </div>
          <p className="text-xs text-muted">
            Time logs are not part of a task in this data model. Modules and features are arranged on the{' '}
            <Link href={`/projects/${projectId}/development`} className="font-medium text-brand hover:underline">
              Development page
            </Link>
            .
          </p>
      </div>
    </div>
  );
}

/** The task's own facts, edited in place — `updateTaskAction`; status stays on its own control above. */
function TaskEditForm({ task, projectId, roster, onSaved }: { task: BoardTask; projectId: string; roster: BoardPerson[]; onSaved: () => void }) {
  const [state, action, pending] = useActionState(updateTaskAction, IDLE_STATE);
  const router = useRouter();
  const handled = useRef<typeof state | null>(null);
  useEffect(() => {
    if (state.status === 'success' && handled.current !== state) {
      handled.current = state;
      router.refresh();
      onSaved();
    }
  }, [state, router, onSaved]);

  return (
    <form action={action} className="flex flex-col gap-3 rounded-lg border border-line p-3">
      <input type="hidden" name="taskId" value={task.id} />
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-col gap-1">
        <label htmlFor="edit-task-title" className={labelClass}>Title</label>
        <input id="edit-task-title" name="title" required maxLength={200} defaultValue={task.title} className={inputClass} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="edit-task-priority" className={labelClass}>Priority</label>
          <select id="edit-task-priority" name="priority" defaultValue={task.priority} className={selectClass}>
            {Object.entries(PRIORITY).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="edit-task-assignee" className={labelClass}>Assignee</label>
          <select id="edit-task-assignee" name="assigneeId" defaultValue={task.assigneeId ?? ''} className={selectClass}>
            <option value="">Unassigned</option>
            {roster.map((p) => (
              <option key={p.userId} value={p.userId}>{p.fullName}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="edit-task-start" className={labelClass}>Start date</label>
          <input id="edit-task-start" name="startOn" type="date" defaultValue={task.startOn ?? ''} className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="edit-task-due" className={labelClass}>Due date</label>
          <input id="edit-task-due" name="dueOn" type="date" defaultValue={task.dueOn ?? ''} className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="edit-task-estimate" className={labelClass}>Estimate (hours)</label>
          <input id="edit-task-estimate" name="estimateHours" type="number" min="0" step="0.5" defaultValue={task.estimateHours ?? ''} className={inputClass} />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="edit-task-description" className={labelClass}>Description</label>
        <textarea id="edit-task-description" name="description" rows={4} maxLength={4000} defaultValue={task.description ?? ''} className={textareaClass} placeholder="What done looks like" />
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Save task'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

function AddTaskDrawer({
  projectId,
  status,
  statusLabel,
  modules,
  onClose,
  onCreated,
}: {
  projectId: string;
  status: string | null;
  statusLabel: string;
  modules: BoardModule[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [state, action, pending] = useActionState(createTaskAction, IDLE_STATE);

  // Fires once per success: `state` is a fresh object per action result, so
  // remembering the one already handled keeps a re-render (or a new
  // `onCreated` closure) from refreshing the page a second time.
  const handled = useRef<typeof state | null>(null);
  useEffect(() => {
    if (state.status === 'success' && handled.current !== state) {
      handled.current = state;
      onCreated();
    }
  }, [state, onCreated]);

  return (
    <Drawer open={status !== null} onClose={onClose} title="Add task" description={`A new task is created in To do; drag it to ${statusLabel} once it exists. Status moves are their own validated write.`}>
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="projectId" value={projectId} />
        <div className="flex flex-col gap-1">
          <label htmlFor="board-task-title" className={labelClass}>
            Task
          </label>
          <input id="board-task-title" name="title" required maxLength={200} className={inputClass} placeholder="Build the login form" autoFocus />
        </div>
        {modules.length > 0 ? (
          <div className="flex flex-col gap-1">
            <label htmlFor="board-task-module" className={labelClass}>
              Module
            </label>
            <select id="board-task-module" name="moduleId" className={selectClass} defaultValue={modules[0]?.id ?? ''}>
              {modules.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="text-[13px] text-muted">This project has no modules yet; the task is created without one.</p>
        )}
        <div className="flex flex-col gap-1">
          <label htmlFor="board-task-description" className={labelClass}>
            Description
          </label>
          <textarea id="board-task-description" name="description" rows={3} className={textareaClass} placeholder="What done looks like" />
        </div>
        <div className="flex items-center gap-2">
          <button type="submit" disabled={pending} className={buttonClass('primary', 'md')}>
            {pending ? 'Adding…' : 'Add task'}
          </button>
          <button type="button" onClick={onClose} className={buttonClass('ghost', 'md')}>
            Cancel
          </button>
        </div>
        <FormMessage status={state.status} message={state.message} />
      </form>
    </Drawer>
  );
}
