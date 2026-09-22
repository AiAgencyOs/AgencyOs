'use client';

import { useEffect, useRef } from 'react';

import { cx } from '../tokens';

/**
 * The right-side panel for inspecting or editing a record without leaving the
 * list behind it.
 *
 * Built on `<dialog>` rather than a hand-rolled overlay: `showModal()` gives
 * focus trapping, an inert background, and Escape-to-close for free, which is
 * exactly the behaviour a modal panel needs and the behaviour a div-plus-CSS
 * version of this always forgets one of. The one thing the element does not
 * do — close on a click outside the content — is wired up below by checking
 * that the click landed on the `<dialog>` itself, not on something inside it.
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  actions,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        // `onClose` above already fires for the native Escape-driven close;
        // this only stops the default (which would close without notice).
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cx(
        'm-0 h-dvh max-h-none w-full max-w-md bg-transparent p-0',
        'backdrop:bg-neutral-950/40 backdrop:backdrop-blur-[1px]',
        'fixed inset-y-0 right-0 left-auto',
        'open:animate-drawer',
      )}
    >
      <div className={cx('flex h-full flex-col border-l border-line bg-surface shadow-xl', className)}>
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight text-foreground">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{description}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid size-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              <span aria-hidden className="text-base leading-none">
                ✕
              </span>
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
        {footer ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-sunken px-4 py-3 sm:px-5">
            {footer}
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
