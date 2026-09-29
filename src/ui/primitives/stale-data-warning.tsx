import { IconClock } from '../icons';
import { ageLabel } from './staleness';
import { Callout } from './empty-state';

/**
 * The page-5 shared rule's "stale-data warning" state — a reusable version of
 * the Callout Operations wrote by hand for its scheduler tick. Anything that
 * reads a live signal on an interval (a cron heartbeat, an integration health
 * check) rather than a value recorded at write time belongs behind this
 * rather than a second hand-rolled age formatter.
 *
 * `null` age reads as stale by default — "the age could not be read" is a
 * worse sign than "it has been a while", never a better one.
 */
export function StaleDataWarning({
  label,
  ageSeconds,
  staleAfterSeconds,
  staleMessage,
  freshMessage,
}: {
  label: string;
  ageSeconds: number | null;
  staleAfterSeconds: number;
  /** Rendered when the age exceeds the threshold (or could not be read) — receives "3h ago" / "unknown". */
  staleMessage: (age: string) => React.ReactNode;
  /** Rendered otherwise — receives "45s ago". */
  freshMessage: (age: string) => React.ReactNode;
}) {
  const stale = ageSeconds === null || ageSeconds > staleAfterSeconds;
  const age = ageLabel(ageSeconds);

  return (
    <Callout tone={stale ? 'danger' : 'info'} icon={<IconClock size={16} />} title={label}>
      {stale ? staleMessage(age) : freshMessage(age)}
    </Callout>
  );
}
