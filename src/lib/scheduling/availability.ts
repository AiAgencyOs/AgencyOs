/**
 * Availability, and the one thing the Scheduler must never do — gap G-226.
 *
 * The Scheduler specification opens its "must not" list with a single line:
 * **"Invent availability."** §5.3 says the same thing from the other side —
 * "Never represent an unavailable slot as pending/confirmed unless the
 * provider actually created it" — and §14 makes a provider outage produce
 * "No false success".
 *
 * ── the distinction this module exists to hold ────────────────────────────
 *
 * Three answers look alike and are not:
 *
 *   **read, with no slots**   the calendar was asked and is full. A real
 *                             answer: tell the lead, offer the nearest
 *                             alternatives, escalate if none (§5.3).
 *   **unreadable**            the calendar was asked and did not answer. Not
 *                             an answer. Offering anything here is inventing.
 *   **unconfigured**          there is no calendar. Also not an answer, and
 *                             the state this deployment is in today (BLK-005).
 *
 * Collapsing any of these into "no slots" is how a system ends up telling a
 * client "nothing is free this week" because a token expired. This is the
 * same shape `WindowState` holds for outbound messages, where `unreadable` is
 * deliberately not a window state — it is the absence of one — and the same
 * shape G-054 removed from every read that renders.
 *
 * ── why this exists before a provider does ────────────────────────────────
 *
 * No calendar has been chosen (BLK-005), so the default source answers
 * `unconfigured` and nothing can be proposed. That is the point rather than a
 * placeholder: a refusal built after the thing it refuses is a refusal that
 * has never been true, and §12 requires provider behaviour to live behind an
 * adapter anyway. An adapter drops in under `readAvailability`; none of the
 * rules below change when it does.
 */

/** A candidate window, in absolute time. Half-open: start inclusive, end exclusive. */
export type Slot = {
  /** ISO-8601, UTC. */
  startAt: string;
  endAt: string;
};

/** Where an answer came from, recorded so a proposal can prove it was read. */
export type AvailabilitySource = {
  /** An adapter key — 'google', 'microsoft', … — never a credential. */
  provider: string;
  /** The calendar or resource asked, as that provider identifies it. */
  calendarId: string;
};

/**
 * What asking produced.
 *
 * `read` is the only member carrying slots, which is what makes "you may only
 * offer what you read" expressible in the type rather than in a comment.
 */
export type AvailabilityAnswer =
  | { state: 'read'; source: AvailabilitySource; readAt: string; slots: readonly Slot[] }
  | { state: 'unreadable'; source: AvailabilitySource; reason: string }
  | { state: 'unconfigured' };

/** What the request is allowed to narrow. §5.1's own list, minus the provider's half. */
export type SlotConstraints = {
  /** How long the meeting needs. A slot shorter than this is not a candidate. */
  durationMinutes: number;
  /**
   * §5.1's "minimum notice" — how far ahead of `now` a slot must start. A lead
   * asking at 09:58 for 10:00 is asking for something nobody can prepare for.
   */
  minimumNoticeMinutes: number;
  /** §5.1's pre/post-event buffer, applied to both ends. */
  bufferMinutes: number;
};

const MINUTE = 60_000;
const ms = (iso: string) => Date.parse(iso);

/**
 * The default source: there isn't one.
 *
 * Deliberately not a stub that returns plausible slots. A fake calendar is
 * indistinguishable from a real one at every call site, which means the day a
 * provider is wired in nobody can tell which deployments were ever asking
 * anything — and in the meantime every slot offered is invented, which is the
 * single thing §5 forbids.
 */
export function readAvailability(): AvailabilityAnswer {
  return { state: 'unconfigured' };
}

/**
 * The rule, in one place: what may be offered to a lead.
 *
 * Returns slots only for a `read` answer. Everything else refuses WITH ITS
 * REASON, so a caller can tell a lead "let me check and come back" (unreadable)
 * apart from "nothing is free that week" (read, empty) — which are different
 * sentences and different next actions.
 */
export type Proposable =
  | { ok: true; source: AvailabilitySource; readAt: string; slots: readonly Slot[] }
  | { ok: false; reason: 'unconfigured' | 'unreadable' };

export function proposableSlots(answer: AvailabilityAnswer): Proposable {
  if (answer.state === 'unconfigured') return { ok: false, reason: 'unconfigured' };
  if (answer.state === 'unreadable') return { ok: false, reason: 'unreadable' };
  return { ok: true, source: answer.source, readAt: answer.readAt, slots: answer.slots };
}

/**
 * §5.1's local filters — the ones that do not need the provider to re-answer.
 *
 * Applied to what was read, never used to manufacture what was not: this
 * narrows a list and can only ever shorten it.
 */
export function filterSlots(
  slots: readonly Slot[],
  constraints: SlotConstraints,
  now: string,
): readonly Slot[] {
  // A `now` that does not parse cannot be compared against, and `start < NaN`
  // is false for every start — so the first draft silently DISABLED minimum
  // notice whenever the clock it was handed was garbage. Fail closed: no clock,
  // no slots. Found by review.
  if (!Number.isFinite(ms(now))) return [];

  const earliest = ms(now) + constraints.minimumNoticeMinutes * MINUTE;
  // The buffer is time the meeting needs on either side, so the slot has to be
  // longer than the meeting by both of them.
  const needed = (constraints.durationMinutes + constraints.bufferMinutes * 2) * MINUTE;

  return slots.filter((slot) => {
    const start = ms(slot.startAt);
    const end = ms(slot.endAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    if (end <= start) return false;
    if (start < earliest) return false;
    return end - start >= needed;
  });
}

/** What the lead asked for, as far as it is known. Every field may be absent (§4.2). */
export type SlotRequest = {
  /** The moment they named, when they named one. */
  requestedStartAt?: string | null;
  /** The far end of a range such as "6–8 PM". */
  requestedWindowEnd?: string | null;
};

/**
 * §5.2's ranking, as a total order.
 *
 *   1. the exact requested slot, when it is genuinely available
 *   2. anything inside a requested range
 *   3. the same calendar day as the request
 *   4. everything else, nearest to the request first
 *
 * "Respect lead constraints before internal convenience" is the whole shape:
 * nothing here knows or cares which slot suits the agency. Ties break on
 * earliest start, so the order is stable and two equal candidates do not
 * reshuffle between two reads of the same list.
 */
export function rankSlots(slots: readonly Slot[], request: SlotRequest): readonly Slot[] {
  const wanted = request.requestedStartAt ? ms(request.requestedStartAt) : null;
  const windowEnd = request.requestedWindowEnd ? ms(request.requestedWindowEnd) : null;

  /** The calendar day of the request, in UTC — a coarse key, deliberately. */
  const wantedDay = wanted === null ? null : new Date(wanted).toISOString().slice(0, 10);

  const rank = (slot: Slot): number => {
    const start = ms(slot.startAt);
    if (wanted !== null && start === wanted) return 0;
    if (wanted !== null && windowEnd !== null && start >= wanted && start < windowEnd) return 1;
    if (wantedDay !== null && slot.startAt.slice(0, 10) === wantedDay) return 2;
    return 3;
  };

  const distance = (slot: Slot): number =>
    wanted === null ? ms(slot.startAt) : Math.abs(ms(slot.startAt) - wanted);

  return [...slots].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const byDistance = distance(a) - distance(b);
    if (byDistance !== 0) return byDistance;
    return ms(a.startAt) - ms(b.startAt);
  });
}

/**
 * The whole pipeline §5 names: REQUEST → FILTER → RANK → PROPOSE.
 *
 * One entry point so a caller cannot reach the slots without passing the
 * refusal — which is the difference between a rule and a suggestion.
 */
export function offerableSlots(
  answer: AvailabilityAnswer,
  request: SlotRequest,
  constraints: SlotConstraints,
  now: string,
  limit = 3,
): Proposable {
  const proposable = proposableSlots(answer);
  if (!proposable.ok) return proposable;

  const usable = filterSlots(proposable.slots, constraints, now);
  return {
    ok: true,
    source: proposable.source,
    readAt: proposable.readAt,
    // §6.1: "Present multiple options only when needed." Three is the most a
    // person chooses between in a chat message without being given homework.
    slots: rankSlots(usable, request).slice(0, limit),
  };
}
