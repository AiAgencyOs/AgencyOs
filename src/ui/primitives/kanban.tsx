'use client';

import {
  DndContext,
  PointerSensor,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { useState, useId } from 'react';

import { cx, TONE_TEXT, type Tone } from '../tokens';

/**
 * A drag-and-drop Kanban board — SCR-020's board mode, and the "column-per-
 * status, card-per-record" pattern the reference screenshots use throughout.
 *
 * This component owns dragging and layout only. It has NO idea what a "task"
 * is or how a status change is authorized — the caller supplies `renderCard`
 * for content and `onMove` for the write, so every board built on this stays
 * routed through whatever validated backend action the caller already has.
 * That split exists on purpose: the Project Board's own history is a card
 * that moved a status directly against the database once and created a
 * second, divergent writer next to the Development page's own action — this
 * component cannot repeat that mistake because it never touches a status
 * itself.
 *
 * Columns are drawn as the reference draws them: a tinted header carrying an
 * icon, the name and a count pill, an optional action at the right ("+"),
 * and an optional footer ("+ Add task") — both supplied by the caller.
 */

export type KanbanColumn = { id: string; label: string; tone?: Tone; icon?: React.ReactNode; /** A line under the name — the reference's column total ('₹12,50,000'). */ subtitle?: React.ReactNode };
export type KanbanItem = { id: string; columnId: string };

export function KanbanBoard<T extends KanbanItem>({
  columns,
  items,
  renderCard,
  onMove,
  disabled = false,
  isItemLocked,
  renderColumnAction,
  renderColumnFooter,
  emptyLabel = 'No tasks',
  className,
}: {
  columns: KanbanColumn[];
  items: readonly T[];
  renderCard: (item: T) => React.ReactNode;
  /** Called after a card is dropped on a different column. Awaited before the optimistic move is trusted. */
  onMove?: (itemId: string, toColumnId: string) => void | Promise<void>;
  /** Renders every card as a plain, non-draggable tile — for roles without write permission. */
  disabled?: boolean;
  /** Renders one card as a plain tile even when the board is writable (a read-only column, e.g. Won / Lost). */
  isItemLocked?: (item: T) => boolean;
  /** A control in the column header's right corner. */
  renderColumnAction?: (column: KanbanColumn) => React.ReactNode;
  /** A control under the column's cards. */
  renderColumnFooter?: (column: KanbanColumn) => React.ReactNode;
  /** What an empty column says. */
  emptyLabel?: string;
  className?: string;
}) {
  // dnd-kit numbers its aria-describedby ids from a module counter, which
  // runs separately on the server and in the browser and produced a React
  // hydration mismatch on every board (live QA, 2026-09-29). A stable id
  // from React makes both renders agree.
  const dndId = useId();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // Optimistic column assignment, reconciled by whatever `items` the caller
  // passes on its next render (a server action revalidates the page's data,
  // which flows back in as new `items`). If `onMove` rejects, the local
  // override is dropped and the card snaps back to its authoritative column.
  const [pendingColumnById, setPendingColumnById] = useState<Record<string, string>>({});

  function columnIdFor(item: T): string {
    return pendingColumnById[item.id] ?? item.columnId;
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    const itemId = String(active.id);
    const toColumnId = String(over.id);
    const item = items.find((i) => i.id === itemId);
    if (!item || columnIdFor(item) === toColumnId) return;

    setPendingColumnById((prev) => ({ ...prev, [itemId]: toColumnId }));
    try {
      await onMove?.(itemId, toColumnId);
    } finally {
      // Whether it succeeded or failed, the next render's `items` (from a
      // revalidated server read, or unchanged on failure) is the truth —
      // the optimistic override has done its job either way.
      setPendingColumnById((prev) => {
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
    }
  }

  return (
    <DndContext id={dndId} sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
      <div className={cx('grid grid-cols-1 gap-3 sm:grid-cols-2', XL_COLS[columns.length] ?? 'xl:grid-cols-5', className)}>
        {columns.map((col) => (
          <KanbanColumnView
            key={col.id}
            column={col}
            count={items.filter((i) => columnIdFor(i) === col.id).length}
            action={renderColumnAction?.(col)}
            footer={renderColumnFooter?.(col)}
            emptyLabel={emptyLabel}
          >
            {items
              .filter((i) => columnIdFor(i) === col.id)
              .map((item) => (
                <KanbanCard key={item.id} id={item.id} disabled={disabled || Boolean(isItemLocked?.(item))}>
                  {renderCard(item)}
                </KanbanCard>
              ))}
          </KanbanColumnView>
        ))}
      </div>
    </DndContext>
  );
}

// Literal class names, so Tailwind's scanner emits them.
const XL_COLS: Record<number, string> = { 1: 'xl:grid-cols-1', 2: 'xl:grid-cols-2', 3: 'xl:grid-cols-3', 4: 'xl:grid-cols-4', 5: 'xl:grid-cols-5' };

const HEADER_TINT: Record<Tone, string> = {
  neutral: 'bg-surface-sunken',
  brand: 'bg-brand-soft',
  accent: 'bg-accent-soft',
  success: 'bg-success-soft',
  warning: 'bg-warning-soft',
  danger: 'bg-danger-soft',
  info: 'bg-info-soft',
};

function KanbanColumnView({
  column,
  count,
  action,
  footer,
  emptyLabel,
  children,
}: {
  column: KanbanColumn;
  count: number;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  emptyLabel: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const tone = column.tone ?? 'neutral';

  return (
    <div
      ref={setNodeRef}
      className={cx(
        'flex flex-col rounded-xl border bg-surface-sunken/60 transition-colors',
        isOver ? 'border-brand/40 bg-brand-soft/30' : 'border-line',
      )}
    >
      <div className={cx('flex items-start justify-between gap-2 rounded-t-xl px-3 py-2.5', HEADER_TINT[tone])}>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className={cx('flex min-w-0 items-center gap-2 text-[14px] font-semibold', TONE_TEXT[tone])}>
            {column.icon ? <span className="shrink-0">{column.icon}</span> : null}
            <span className="truncate">{column.label}</span>
          </span>
          {column.subtitle ? <span className="tabular text-[13px] font-semibold text-foreground">{column.subtitle}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="tabular rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold text-foreground">{count}</span>
          {action ? <span>{action}</span> : null}
        </span>
      </div>
      <div className="flex min-h-[80px] flex-1 flex-col gap-2 p-2">
        {count > 0 ? children : <p className="px-2 py-4 text-center text-xs text-faint">{emptyLabel}</p>}
      </div>
      {footer ? <div className="px-2 pb-2">{footer}</div> : null}
    </div>
  );
}

function KanbanCard({ id, disabled, children }: { id: string; disabled: boolean; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id, disabled });

  return (
    <div
      ref={setNodeRef}
      style={transform ? { transform: CSS.Translate.toString(transform) } : undefined}
      className={cx(isDragging && 'z-10 opacity-60', !disabled && 'cursor-grab touch-none active:cursor-grabbing')}
      // dnd-kit's default role="button" would nest the card's own links inside a button (axe: nested-interactive)
      {...(disabled ? {} : { ...attributes, role: 'group', ...listeners })}
    >
      {children}
    </div>
  );
}
