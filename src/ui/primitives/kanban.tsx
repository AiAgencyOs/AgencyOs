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

import { cx, TONE_DOT, type Tone } from '../tokens';

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
 */

export type KanbanColumn = { id: string; label: string; tone?: Tone };
export type KanbanItem = { id: string; columnId: string };

export function KanbanBoard<T extends KanbanItem>({
  columns,
  items,
  renderCard,
  onMove,
  disabled = false,
  className,
}: {
  columns: KanbanColumn[];
  items: readonly T[];
  renderCard: (item: T) => React.ReactNode;
  /** Called after a card is dropped on a different column. Awaited before the optimistic move is trusted. */
  onMove?: (itemId: string, toColumnId: string) => void | Promise<void>;
  /** Renders every card as a plain, non-draggable tile — for roles without write permission. */
  disabled?: boolean;
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
      <div className={cx('grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5', className)}>
        {columns.map((col) => (
          <KanbanColumnView key={col.id} column={col} count={items.filter((i) => columnIdFor(i) === col.id).length}>
            {items
              .filter((i) => columnIdFor(i) === col.id)
              .map((item) => (
                <KanbanCard key={item.id} id={item.id} disabled={disabled}>
                  {renderCard(item)}
                </KanbanCard>
              ))}
          </KanbanColumnView>
        ))}
      </div>
    </DndContext>
  );
}

function KanbanColumnView({
  column,
  count,
  children,
}: {
  column: KanbanColumn;
  count: number;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <div
      ref={setNodeRef}
      className={cx(
        'flex flex-col rounded-xl border bg-surface shadow-xs transition-colors',
        isOver ? 'border-brand/40 bg-brand-soft/30' : 'border-line',
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
        <span className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
          <span aria-hidden className={cx('h-2 w-2 shrink-0 rounded-full', TONE_DOT[column.tone ?? 'neutral'])} />
          {column.label}
        </span>
        <span className="tabular text-xs text-muted">{count}</span>
      </div>
      <div className="flex min-h-[80px] flex-1 flex-col gap-2 p-2">
        {count > 0 ? children : <p className="px-2 py-3 text-center text-xs text-faint">Empty</p>}
      </div>
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
      {...(disabled ? {} : { ...attributes, ...listeners })}
    >
      {children}
    </div>
  );
}
