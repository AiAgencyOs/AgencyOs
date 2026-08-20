import { cx } from '../tokens';
import { IconAlert, IconClock, IconTickDouble, IconTickSingle } from '../icons';

/**
 * The WhatsApp surface.
 *
 * Leads arrive over WhatsApp and are answered over WhatsApp, so the screen
 * that handles them is a WhatsApp client rather than a table of rows with a
 * "body" column. Staff already know how to read this shape — who spoke, in
 * what order, and whether it went out — without being taught anything.
 *
 * The palette is WhatsApp's own (`--wa-*` in globals.css), kept in its own
 * namespace so it cannot leak into the rest of the admin panel. That
 * separation is the whole reason this can look like WhatsApp without the
 * invoices screen also turning green.
 *
 * One thing is deliberately *not* imitated: the blue double tick. WhatsApp's
 * blue means "read by the recipient", and this system does not know that —
 * `MessageDelivery` tops out at `sent`, meaning the provider accepted it. A
 * blue tick here would be a familiar-looking lie, so `sent` gets a grey double
 * tick and the title attribute says exactly what it means.
 */

/* ── Avatar ───────────────────────────────────────────────────────────────── */

const AVATAR_TINTS = [
  'bg-[#dfe5e7] text-[#4a6572]',
  'bg-[#c9e7d8] text-[#1f6b4a]',
  'bg-[#ffe0b2] text-[#8a5a1a]',
  'bg-[#d6d8f5] text-[#3f4396]',
  'bg-[#f8d3d8] text-[#a03349]',
  'bg-[#cfe8f7] text-[#1d5f86]',
];

/** Same name, same colour, every time — a hash, not a random pick. */
function tintFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[h % AVATAR_TINTS.length] ?? AVATAR_TINTS[0]!;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function Avatar({
  name,
  size = 44,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      className={cx(
        'flex shrink-0 select-none items-center justify-center rounded-full font-semibold',
        tintFor(name),
        className,
      )}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

/* ── Conversation header ──────────────────────────────────────────────────── */

export function ChatHeader({
  name,
  status,
  back,
  actions,
  className,
}: {
  name: string;
  status?: React.ReactNode;
  /** The back affordance — a phone needs one, a desktop does not. */
  back?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'flex items-center gap-3 bg-[var(--wa-header)] px-3 py-2.5 text-[var(--wa-header-fg)] sm:px-4',
        className,
      )}
    >
      {back}
      <Avatar name={name} size={40} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold leading-tight">{name}</p>
        {status ? (
          <p className="truncate text-[12px] leading-tight opacity-80">{status}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}

/** An icon control on the teal header — hover state has to work on teal. */
export function ChatHeaderButton({
  children,
  label,
  ...rest
}: { children: React.ReactNode; label: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--wa-header-fg)] opacity-85 transition-opacity hover:bg-white/10 hover:opacity-100"
      {...rest}
    >
      {children}
    </button>
  );
}

/* ── The scrolling conversation ───────────────────────────────────────────── */

export function ChatCanvas({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cx('wa-wallpaper relative flex-1 overflow-y-auto', className)}>
      <div className="relative flex flex-col gap-1 px-3 py-4 sm:px-6">{children}</div>
    </div>
  );
}

/** The centred date pill that separates one day from the next. */
export function DayDivider({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-2 flex justify-center">
      <span className="rounded-lg bg-[var(--wa-system)] px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-[var(--wa-system-fg)] shadow-bubble">
        {children}
      </span>
    </div>
  );
}

/** A centred notice from the system rather than from a person. */
export function SystemNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-2 flex justify-center">
      <span className="max-w-md rounded-lg bg-[var(--wa-system)] px-3 py-1.5 text-center text-[12px] leading-relaxed text-[var(--wa-system-fg)] shadow-bubble">
        {children}
      </span>
    </div>
  );
}

/* ── Bubbles ──────────────────────────────────────────────────────────────── */

export type BubbleDelivery = 'pending' | 'sent' | 'failed' | null;

function DeliveryMark({ delivery }: { delivery: BubbleDelivery }) {
  if (delivery === 'pending') {
    return (
      <IconClock
        size={13}
        className="shrink-0"
        label="Written, not yet sent"
      />
    );
  }
  if (delivery === 'sent') {
    // Grey, never blue. See the note at the top of this file.
    return (
      <IconTickDouble
        size={15}
        className="shrink-0"
        label="Accepted by the provider — delivery to the recipient is not confirmed"
      />
    );
  }
  if (delivery === 'failed') {
    return (
      <span className="flex shrink-0 items-center gap-0.5 font-medium text-danger">
        <IconAlert size={12} label="The send failed; the reason is in the record" />
        failed
      </span>
    );
  }
  return <IconTickSingle size={14} className="shrink-0 opacity-0" aria-hidden />;
}

export function ChatBubble({
  outgoing,
  author,
  body,
  time,
  delivery,
  /** First bubble of a run gets the tail; the rest tuck under it. */
  tail = true,
  footer,
}: {
  outgoing: boolean;
  /** Shown above the text when several people speak on our side. */
  author?: string;
  body: string;
  time: string;
  delivery?: BubbleDelivery;
  tail?: boolean;
  footer?: React.ReactNode;
}) {
  return (
    <div className={cx('flex w-full', outgoing ? 'justify-end' : 'justify-start')}>
      <div
        className={cx(
          'relative max-w-[85%] rounded-lg px-2.5 py-1.5 text-[14.5px] leading-[1.35] shadow-bubble sm:max-w-[68%]',
          'text-[var(--wa-bubble-fg)]',
          outgoing ? 'bg-[var(--wa-bubble-out)]' : 'bg-[var(--wa-bubble-in)]',
          tail && (outgoing ? 'wa-tail-out rounded-tr-none' : 'wa-tail-in rounded-tl-none'),
        )}
      >
        {author ? (
          <p className="mb-0.5 text-[12.5px] font-semibold text-[var(--wa-header)] dark:text-[var(--wa-accent)]">
            {author}
          </p>
        ) : null}

        {/* The float is how WhatsApp itself does it: a short message keeps the
            timestamp on the same line, a long one wraps around it, and neither
            case needs a second layout. */}
        <p className="whitespace-pre-wrap break-words">
          {body}
          <span className="float-right ml-2 mt-[6px] inline-flex translate-y-[2px] items-center gap-1 text-[11px] text-[var(--wa-meta)]">
            <span className="tabular">{time}</span>
            {outgoing ? <DeliveryMark delivery={delivery ?? null} /> : null}
          </span>
        </p>

        {footer ? (
          <div className="mt-1.5 border-t border-[var(--wa-divider)] pt-1.5 text-[12px] text-[var(--wa-meta)]">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ── Chat list ────────────────────────────────────────────────────────────── */

/**
 * One row of the chat list. The layout is WhatsApp's: avatar, name and last
 * line on the left, time and a state chip stacked on the right.
 */
export function ChatListItem({
  name,
  preview,
  time,
  badge,
  meta,
  active,
}: {
  name: string;
  preview: React.ReactNode;
  time?: string;
  badge?: React.ReactNode;
  meta?: React.ReactNode;
  active?: boolean;
}) {
  return (
    <div
      className={cx(
        'flex items-center gap-3 px-3 py-2.5 transition-colors sm:px-4',
        active ? 'bg-[var(--wa-panel-active)]' : 'hover:bg-[var(--wa-panel-hover)]',
      )}
    >
      <Avatar name={name} size={48} />
      <div className="min-w-0 flex-1 border-b border-[var(--wa-divider)] pb-2.5 -my-2.5 pt-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-[16px] font-medium text-foreground">{name}</p>
          {time ? <span className="shrink-0 text-[12px] text-muted">{time}</span> : null}
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <span className="clamp-1 min-w-0 flex-1 text-[13.5px] text-muted">{preview}</span>
          {badge ? <span className="shrink-0">{badge}</span> : null}
        </div>
        {meta ? <div className="mt-1 flex flex-wrap items-center gap-1.5">{meta}</div> : null}
      </div>
    </div>
  );
}

/* ── Composer chrome ──────────────────────────────────────────────────────── */

/** The grey band a message is typed into. */
export function ComposerBar({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cx(
        'shrink-0 border-t border-[var(--wa-divider)] bg-[var(--wa-composer)] px-2 py-2 sm:px-3',
        className,
      )}
    >
      {children}
    </div>
  );
}
