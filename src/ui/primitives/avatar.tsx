import { cx, type Tone } from '../tokens';

/**
 * A person or an entity as a circle of initials.
 *
 * The reference screenshots put a face beside every name — on tables, cards,
 * feeds and the header. There are no photos in the data model, so this is
 * the initials in a tint chosen from the name, stable across renders and
 * screens so the same person is the same colour everywhere.
 */

const AVATAR_TONES: Tone[] = ['brand', 'info', 'success', 'warning', 'danger', 'accent'];

const AVATAR_TINT: Record<Tone, string> = {
  neutral: 'bg-surface-sunken text-muted ring-1 ring-inset ring-line',
  brand: 'bg-brand-soft text-brand',
  accent: 'bg-accent-soft text-brand',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
};

const AVATAR_SIZE = {
  xs: 'h-5 w-5 text-[9px]',
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-[12px]',
  lg: 'h-10 w-10 text-[14px]',
  xl: 'h-14 w-14 text-[18px]',
} as const;

export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/[\s@._-]+/).filter(Boolean);
  const first = words[0];
  const second = words[1];
  if (!first) return '?';
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

export function toneFor(name: string | null | undefined): Tone {
  const s = name ?? '';
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length] ?? 'brand';
}

export function Avatar({
  name,
  size = 'md',
  tone,
  square,
  className,
}: {
  name: string | null | undefined;
  size?: keyof typeof AVATAR_SIZE;
  tone?: Tone;
  /** A rounded square — for an organisation or a project rather than a person. */
  square?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      title={name ?? undefined}
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center font-semibold uppercase leading-none',
        square ? 'rounded-lg' : 'rounded-full',
        AVATAR_SIZE[size],
        AVATAR_TINT[tone ?? toneFor(name)],
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}

/** Overlapping avatars with a "+N" tail — the team on a project header. */
export function AvatarStack({
  names,
  max = 4,
  size = 'md',
  className,
}: {
  names: readonly string[];
  max?: number;
  size?: keyof typeof AVATAR_SIZE;
  className?: string;
}) {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return (
    <span className={cx('inline-flex items-center', className)}>
      {shown.map((n, i) => (
        <Avatar key={`${n}-${i}`} name={n} size={size} className={cx('ring-2 ring-surface', i > 0 && '-ml-2')} />
      ))}
      {rest > 0 ? (
        <span
          className={cx(
            '-ml-2 inline-flex items-center justify-center rounded-full bg-surface-sunken font-semibold text-muted ring-2 ring-surface',
            AVATAR_SIZE[size],
          )}
        >
          +{rest}
        </span>
      ) : null}
    </span>
  );
}
