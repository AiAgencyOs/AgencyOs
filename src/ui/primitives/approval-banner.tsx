import { cx } from '../tokens';
import { IconAlert, IconCheck, IconClock } from '../icons';

/**
 * The banner a record wears while a decision hangs over it — the PDF §8's
 * "approval banner". One component for every screen that has an approval
 * behind it, so "Waiting for the owner" reads the same on a quotation, a
 * refund and the approval's own page.
 *
 * It states a fact from the approval row and nothing else: the state, who
 * must decide, when it is due (and that it is late), and — once decided —
 * when and with what note. `href` points at the decision so the banner is
 * also the way to it.
 */

export type ApprovalBannerState = 'pending' | 'approved' | 'rejected' | 'changes_requested' | 'expired' | 'cancelled';

const SKIN: Record<ApprovalBannerState, { box: string; label: string }> = {
  pending: { box: 'border-warning/30 bg-warning-soft text-warning', label: 'Waiting for approval' },
  approved: { box: 'border-success/30 bg-success-soft text-success', label: 'Approved' },
  rejected: { box: 'border-danger/30 bg-danger-soft text-danger', label: 'Rejected' },
  changes_requested: { box: 'border-danger/30 bg-danger-soft text-danger', label: 'Changes requested' },
  expired: { box: 'border-line bg-surface-sunken text-muted', label: 'Expired without a decision' },
  cancelled: { box: 'border-line bg-surface-sunken text-muted', label: 'Cancelled' },
};

export function ApprovalBanner({
  state,
  requiredRole,
  dueLabel,
  overdue = false,
  decidedLabel,
  note,
  href,
  hrefLabel = 'Open the decision',
  className,
}: {
  state: ApprovalBannerState;
  /** Who must decide, as a readable label (e.g. "Owner"). */
  requiredRole?: string;
  /** The agency-local due moment, already formatted. */
  dueLabel?: string;
  overdue?: boolean;
  /** The agency-local decision moment, already formatted — for a decided row. */
  decidedLabel?: string;
  /** The decision note, when one was given. */
  note?: string | null;
  href?: string;
  hrefLabel?: string;
  className?: string;
}) {
  const skin = SKIN[state];
  const Icon = state === 'approved' ? IconCheck : state === 'pending' ? IconClock : IconAlert;

  return (
    <div role="status" className={cx('flex flex-wrap items-start gap-3 rounded-xl border px-4 py-3 text-[13px]', skin.box, className)}>
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold">
          {skin.label}
          {state === 'pending' && requiredRole ? ` — needs ${requiredRole}` : ''}
          {state === 'pending' && overdue ? ' — past its deadline' : ''}
        </span>
        <span className="text-xs opacity-90">
          {state === 'pending' && dueLabel ? `Due ${dueLabel}.` : null}
          {state !== 'pending' && decidedLabel ? `Decided ${decidedLabel}.` : null}
          {note ? ` “${note}”` : null}
        </span>
      </div>
      {href ? (
        <a href={href} className="text-xs font-medium underline underline-offset-2">
          {hrefLabel}
        </a>
      ) : null}
    </div>
  );
}
