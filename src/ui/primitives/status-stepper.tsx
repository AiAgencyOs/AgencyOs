import { cx } from '../tokens';
import { humanize } from '../tokens';
import { IconCheck } from '../icons';
import { TONE_CHIP } from '../tokens';

/**
 * A horizontal read of where a record sits on its own happy path — first
 * built for a lead's status, generalized here once a project's status needed
 * the identical shape. `offRamps` are real states a record can be in that are
 * not points on the happy path (an "on hold" project did not pass through
 * every later step to get there), so they render as a callout beside the
 * track instead of extra steps that would claim an order the state machine
 * does not actually have.
 */
export function StatusStepper<T extends string>({
  status,
  happyPath,
  offRamps,
  offRampLabel = 'Off the happy path',
}: {
  status: T;
  happyPath: readonly T[];
  offRamps: readonly T[];
  offRampLabel?: string;
}) {
  const offRamp = offRamps.includes(status);
  const currentIndex = happyPath.indexOf(status);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2.5 sm:gap-3 sm:px-4">
      {happyPath.map((step, i) => {
        const done = !offRamp && currentIndex >= 0 && i < currentIndex;
        const active = !offRamp && i === currentIndex;
        return (
          <div key={step} className="flex items-center gap-2 sm:gap-3">
            <span
              className={cx(
                'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-medium',
                active ? TONE_CHIP.brand : done ? TONE_CHIP.success : 'text-faint',
              )}
            >
              {done ? <IconCheck size={13} /> : null}
              {humanize(step)}
            </span>
            {i < happyPath.length - 1 ? <span className="h-px w-4 shrink-0 bg-line sm:w-8" aria-hidden /> : null}
          </div>
        );
      })}
      {offRamp ? (
        <span className={cx('ml-1 rounded-full px-2.5 py-1 text-[12.5px] font-medium', TONE_CHIP.warning)}>
          {offRampLabel} — {humanize(status)}
        </span>
      ) : null}
    </div>
  );
}
