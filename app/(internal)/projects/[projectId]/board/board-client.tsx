'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useMemo, useRef, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { createTaskAction, setTaskStatusAction } from '@/modules/projects/actions';
import {
  Avatar,
  Badge,
  buttonClass,
  Callout,
  cx,
  DonutChart,
  Drawer,
  FormMessage,
  IconAlert,
  IconCalendar,
  IconCheck,
  IconMore,
  IconPlus,
  IconSearch,
  inputClass,
  KanbanBoard,
  labelClass,
  selectClass,
  StatusBadge,
  textareaClass,
  type KanbanColumn,
  type KanbanItem,
} from '@/ui';

export type BoardTask = KanbanItem & {
  title: string;
  description: string | null;
  priority: string;
  assigneeId: string | null;
  assigneeName: string | null;
  moduleId: string | null;
  moduleName: string | null;
  dueOn: string | null;
  dueLabel: string | null;
  completedLabel: string | null;
  overdue: boolean;
};

export type BoardModule = { id: string; name: string };
export type BoardPerson = { userId: string; fullName: string };

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
export function ProjectBoard({
  projectId,
  columns,
  tasks,
  modules,
  people,
  canWrite,
}: {
  projectId: string;
  columns: KanbanColumn[];
  tasks: BoardTask[];
  modules: BoardModule[];
  people: BoardPerson[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState('');
  const [moduleFilter, setModuleFilter] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const [openTask, setOpenTask] = useState<BoardTask | null>(null);

  async function handleMove(taskId: string, toStatus: string) {
    setError(null);
    const formData = new FormData();
    formData.set('taskId', taskId);
    formData.set('status', toStatus);
    formData.set('projectId', projectId);

    const result = await setTaskStatusAction(IDLE_STATE, formData);
    if (result.status === 'error') {
      setError(result.message ?? 'Could not move this task.');
      return;
    }
    router.refresh();
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter(
      (t) =>
        (!q || t.title.toLowerCase().includes(q)) &&
        (!assignee || (assignee === 'unassigned' ? t.assigneeId === null : t.assigneeId === assignee)) &&
        (!priority || t.priority === priority) &&
        (!moduleFilter || t.moduleId === moduleFilter),
    );
  }, [tasks, query, assignee, priority, moduleFilter]);

  const filtered = visible.length !== tasks.length;

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <Callout tone="danger" icon={<IconAlert size={16} />}>
          {error}
        </Callout>
      ) : null}

      {/* ── Toolbar ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2 shadow-xs">
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
        <span className="ml-auto text-xs text-muted">
          {filtered ? `${visible.length} of ${tasks.length}` : tasks.length} task{tasks.length === 1 ? '' : 's'}
          {filtered ? (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setAssignee('');
                setPriority('');
                setModuleFilter('');
              }}
              className="ml-2 font-medium text-brand hover:underline"
            >
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

      <KanbanBoard
        columns={columns}
        items={visible}
        disabled={!canWrite}
        onMove={handleMove}
        renderColumnAction={(col) =>
          canWrite ? (
            <button type="button" onClick={() => setAdding(col.id)} aria-label={`Add task in ${col.label}`} className="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-foreground">
              <IconPlus size={14} />
            </button>
          ) : null
        }
        renderColumnFooter={(col) =>
          canWrite ? (
            <button type="button" onClick={() => setAdding(col.id)} className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-brand transition-colors hover:bg-brand-soft">
              <IconPlus size={13} />
              Add task
            </button>
          ) : null
        }
        renderCard={(task) => <TaskCard task={task} onOpen={() => setOpenTask(task)} />}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(18rem,1fr)]">
        <RecentCompletions tasks={tasks} />
        <TaskSummary tasks={tasks} columns={columns} />
      </div>

      <TaskDrawer
        task={openTask}
        projectId={projectId}
        columns={columns}
        canWrite={canWrite}
        onClose={() => setOpenTask(null)}
        onMoved={(taskId, toStatus) => {
          setOpenTask(null);
          void handleMove(taskId, toStatus);
        }}
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
  );
}

function TaskCard({ task, onOpen }: { task: BoardTask; onOpen: () => void }) {
  const p = PRIORITY[task.priority] ?? { label: task.priority.toUpperCase(), tone: 'neutral' as const };
  return (
    <div className="rounded-lg border border-line bg-surface p-3 shadow-xs transition-shadow hover:shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium leading-snug text-foreground">{task.title}</p>
        <button
          type="button"
          aria-label={`Open ${task.title}`}
          onClick={onOpen}
          className="-mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-surface-hover hover:text-foreground"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <IconMore size={14} />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {task.moduleName ? <Badge tone="info">{task.moduleName}</Badge> : null}
        <Badge tone={p.tone}>{p.label}</Badge>
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          {task.assigneeName ? <Avatar name={task.assigneeName} size="sm" /> : <span className="h-6 w-6 rounded-full border border-dashed border-line-strong" aria-label="Unassigned" />}
          {task.dueLabel ? (
            <span className={cx('flex items-center gap-1 text-[11px]', task.overdue ? 'font-medium text-danger' : 'text-muted')}>
              <IconCalendar size={12} />
              {task.dueLabel}
            </span>
          ) : null}
        </span>
        {task.completedLabel ? (
          <span className="flex items-center gap-1 text-[11px] text-success">
            <IconCheck size={12} />
            Done
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The task detail — the reference's task screen, reduced to what
 * `projects.tasks` actually holds: title, description, module, priority,
 * assignee, due date, status. No comments, subtasks, time log or
 * attachments are drawn, because no such tables exist; the drawer says so
 * rather than showing empty sections that imply a feature.
 */
function TaskDrawer({
  task,
  projectId,
  columns,
  canWrite,
  onClose,
  onMoved,
}: {
  task: BoardTask | null;
  projectId: string;
  columns: KanbanColumn[];
  canWrite: boolean;
  onClose: () => void;
  onMoved: (taskId: string, toStatus: string) => void;
}) {
  const p = task ? (PRIORITY[task.priority] ?? { label: task.priority.toUpperCase(), tone: 'neutral' as const }) : null;
  return (
    <Drawer open={task !== null} onClose={onClose} title={task?.title ?? 'Task'} description={task?.moduleName ? `Module · ${task.moduleName}` : undefined}>
      {task && p ? (
        <div className="flex flex-col gap-4 text-[13px]">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-line p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Status</p>
              {canWrite ? (
                <select
                  aria-label="Task status"
                  value={task.columnId}
                  onChange={(e) => onMoved(task.id, e.target.value)}
                  className={cx(selectClass, 'mt-1')}
                >
                  {columns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="mt-1"><StatusBadge status={task.columnId} /></p>
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
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Description</p>
            {task.description ? <p className="mt-1 whitespace-pre-wrap leading-relaxed">{task.description}</p> : <p className="mt-1 text-muted">No description recorded.</p>}
          </div>
          {task.completedLabel ? (
            <p className="flex items-center gap-1.5 text-success">
              <IconCheck size={13} />
              Completed {task.completedLabel}
            </p>
          ) : null}
          <p className="text-xs text-muted">
            Comments, subtasks, time logs and attachments are not part of a task in this data model. Edit the title, module or assignee on the{' '}
            <Link href={`/projects/${projectId}/development`} className="font-medium text-brand hover:underline">
              Development page
            </Link>
            .
          </p>
        </div>
      ) : null}
    </Drawer>
  );
}

function RecentCompletions({ tasks }: { tasks: BoardTask[] }) {
  const done = tasks.filter((t) => t.completedLabel).slice(0, 4);
  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-xs sm:p-5">
      <h2 className="text-sm font-semibold tracking-tight text-foreground">Recent activity</h2>
      {done.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted">Nothing has been completed on this board yet.</p>
      ) : (
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {done.map((t) => (
            <li key={t.id} className="flex items-start gap-3">
              <Avatar name={t.assigneeName ?? 'Unassigned'} size="md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-foreground">
                  <span className="font-medium">{t.assigneeName ?? 'Someone'}</span> completed a task
                </span>
                <span className="block truncate text-xs text-muted">{t.title}</span>
              </span>
              <span className="shrink-0 text-[11px] text-faint">{t.completedLabel}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TaskSummary({ tasks, columns }: { tasks: BoardTask[]; columns: KanbanColumn[] }) {
  const data = columns.map((c) => ({ label: c.label, value: tasks.filter((t) => t.columnId === c.id).length }));
  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-xs sm:p-5">
      <h2 className="text-sm font-semibold tracking-tight text-foreground">Task summary</h2>
      {tasks.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted">No tasks to summarise.</p>
      ) : (
        <div className="mt-2">
          <DonutChart data={data} height={150} totalLabel="Total tasks" />
        </div>
      )}
    </section>
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
