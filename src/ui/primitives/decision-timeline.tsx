import { Badge } from './badge';
import type { Tone } from '../tokens';

/**
 * One decision, review or state change — the shape repeated by hand across
 * every ad hoc "history" list this admin panel already had (Design's
 * internal-review and Admin-decision lists first; the same shape underlies
 * the WhatsApp group audit footer and the approval decision trail). A badge
 * naming the outcome, what it was about, when, and an optional freeform note
 * — never more than that, because the moment one of these needs a different
 * field it has stopped being a decision-timeline entry and become its own
 * thing.
 */
export type DecisionEntry = {
  id: string;
  tone: Tone;
  /** The outcome, e.g. "passed", "confirm", "rejected". */
  label: string;
  /** What the decision was about, e.g. a theme option's name. */
  subject: string;
  /** Already formatted — this component does no date math. */
  when: string;
  note?: string | null;
};

/**
 * Renders only the list — callers keep their own empty state, since the
 * phrasing for "no review yet" differs by what's being reviewed and forcing
 * one wording on every caller would be the wrong kind of consistency.
 */
export function DecisionTimeline({ entries }: { entries: DecisionEntry[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {entries.map((entry) => (
        <li key={entry.id} className="flex flex-col gap-1 border-l-2 border-line pl-3 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={entry.tone}>{entry.label}</Badge>
            <span className="text-muted">
              {entry.subject} · {entry.when}
            </span>
          </div>
          {entry.note ? <p className="max-w-2xl">{entry.note}</p> : null}
        </li>
      ))}
    </ul>
  );
}
