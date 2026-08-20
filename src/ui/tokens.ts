/**
 * Design tokens, in TypeScript.
 *
 * The colours themselves live in `app/globals.css`. What lives here is the
 * *meaning*: which tone a domain status gets, and the class strings that make
 * up a control. Both exist so the answer is written once.
 *
 * `statusTone` in particular replaces the pattern this codebase had before —
 * every page inventing its own `status === 'failed' ? 'red' : …` ladder — with
 * one table. Two screens showing the same status now agree on its colour,
 * which is what makes a status colour readable at all.
 */

/** Join class names, dropping anything falsy. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';

/**
 * Status vocabularies across the product (lead, opportunity, proposal,
 * invoice, job, delivery, approval) overlap far more than they differ, so the
 * mapping is by word rather than by table. A status not listed here is
 * neutral, which is the correct answer for a state whose meaning is not
 * "good", "bad", or "waiting" — most of them.
 */
const TONE_BY_STATUS: Record<string, Tone> = {
  // Settled well
  approved: 'success',
  accepted: 'success',
  won: 'success',
  converted: 'success',
  paid: 'success',
  sent: 'success',
  delivered: 'success',
  succeeded: 'success',
  completed: 'success',
  complete: 'success',
  done: 'success',
  passed: 'success',
  active: 'success',
  healthy: 'success',
  ready: 'success',
  enabled: 'success',
  configured: 'success',
  ok: 'success',
  granted: 'success',
  issued: 'success',
  released: 'success',

  // Settled badly
  failed: 'danger',
  rejected: 'danger',
  lost: 'danger',
  disqualified: 'danger',
  error: 'danger',
  overdue: 'danger',
  expired: 'danger',
  cancelled: 'danger',
  canceled: 'danger',
  blocked: 'danger',
  dead: 'danger',
  denied: 'danger',
  refunded: 'danger',
  breached: 'danger',
  missing: 'danger',
  unconfigured: 'danger',
  disabled: 'danger',
  revoked: 'danger',

  // Waiting on somebody
  pending: 'warning',
  pending_approval: 'warning',
  awaiting: 'warning',
  proposed: 'warning',
  review: 'warning',
  submitted: 'warning',
  on_hold: 'warning',
  paused: 'warning',
  degraded: 'warning',
  at_risk: 'warning',
  partial: 'warning',
  stale: 'warning',
  draft: 'warning',
  unpaid: 'warning',
  due: 'warning',

  // In flight
  new: 'info',
  queued: 'info',
  running: 'info',
  in_progress: 'info',
  processing: 'info',
  scheduled: 'info',
  contacted: 'info',
  qualified: 'info',
  discovery: 'info',
  proposal: 'info',
  negotiation: 'info',
  open: 'info',
  live: 'info',
  building: 'info',
};

export function statusTone(status: string | null | undefined): Tone {
  if (!status) return 'neutral';
  return TONE_BY_STATUS[status.toLowerCase().trim()] ?? 'neutral';
}

/** Machine words (`pending_approval`) read as prose (`Pending approval`). */
export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Tint pairs for chips, dots and inline callouts. */
export const TONE_CHIP: Record<Tone, string> = {
  neutral: 'bg-surface-sunken text-muted ring-1 ring-inset ring-line',
  brand: 'bg-brand-soft text-brand ring-1 ring-inset ring-brand/20',
  success: 'bg-success-soft text-success ring-1 ring-inset ring-success/20',
  warning: 'bg-warning-soft text-warning ring-1 ring-inset ring-warning/25',
  danger: 'bg-danger-soft text-danger ring-1 ring-inset ring-danger/20',
  info: 'bg-info-soft text-info ring-1 ring-inset ring-info/20',
};

export const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-faint',
  brand: 'bg-brand',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
};

export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted',
  brand: 'text-brand',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
};

/* ── Control surfaces ──────────────────────────────────────────────────────
   Exported as strings, not only as components, because the write controls are
   Client Components that render raw `<input>`/`<select>` elements. A string
   keeps them on the same visual grid without dragging a component across the
   server/client boundary for the sake of a border colour.

   Heights are 44px on touch and 36px from `md` up: 44 is the smallest target
   a thumb hits reliably, and 36 is the density a mouse-driven admin screen
   wants. That single pair is why the app is usable on a phone.
   ─────────────────────────────────────────────────────────────────────────── */

export const inputClass =
  'h-11 w-full rounded-lg border border-line bg-surface px-3 text-[15px] text-foreground ' +
  'placeholder:text-faint transition-colors outline-none ' +
  'hover:border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/20 ' +
  'disabled:opacity-50 md:h-9 md:text-sm';

export const textareaClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-foreground ' +
  'placeholder:text-faint transition-colors outline-none resize-y ' +
  'hover:border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/20 ' +
  'disabled:opacity-50 md:text-sm';

export const selectClass =
  'h-11 w-full rounded-lg border border-line bg-surface px-3 text-[15px] text-foreground ' +
  'transition-colors outline-none appearance-none ' +
  'hover:border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/20 ' +
  'disabled:opacity-50 md:h-9 md:text-sm';

export const labelClass = 'text-xs font-semibold uppercase tracking-wider text-muted';

export const cardClass = 'rounded-xl border border-line bg-surface shadow-xs';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'whatsapp';
export type ButtonSize = 'sm' | 'md';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-brand-fg shadow-xs hover:bg-brand-hover active:scale-[.98]',
  secondary:
    'border border-line bg-surface text-foreground shadow-xs hover:bg-surface-hover hover:border-line-strong active:scale-[.98]',
  ghost: 'text-muted hover:bg-surface-hover hover:text-foreground active:scale-[.98]',
  danger: 'bg-danger text-white shadow-xs hover:opacity-90 active:scale-[.98]',
  // The header teal, not the accent: this variant carries a *label*, and text
  // needs 4.5:1 — which no bright WhatsApp green reaches against white.
  whatsapp:
    'bg-[var(--wa-header)] text-[var(--wa-header-fg)] shadow-xs hover:brightness-110 active:scale-[.98]',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-9 gap-1.5 px-3 text-[13px] md:h-8',
  md: 'h-11 gap-2 px-4 text-[15px] md:h-9 md:text-sm',
};

export function buttonClass(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  extra?: string,
): string {
  return cx(
    'inline-flex shrink-0 items-center justify-center rounded-lg font-medium',
    'transition-[background-color,border-color,color,opacity,transform] duration-150',
    'disabled:pointer-events-none disabled:opacity-50',
    VARIANT[variant],
    SIZE[size],
    extra,
  );
}
