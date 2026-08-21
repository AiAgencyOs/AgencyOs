/**
 * The event → handler catalog — ARCHITECTURE.md §9.2.
 *
 * The only place modules couple to each other. If you want to know what
 * happens when an invoice is paid, you read this file and nothing else.
 *
 * Pure data and pure functions, deliberately: no database, no imports from
 * modules/. That keeps the coupling graph readable and the dispatcher's
 * decisions unit-testable without a queue.
 *
 * Only handlers that actually exist are listed. ARCHITECTURE.md §9.2 sketches
 * a fuller catalog for subscriptions that are not built yet — listing them
 * here would enqueue jobs nothing consumes, which is a backlog of dead work
 * masquerading as an integration.
 */

/** `<module>:<handler>` — the handler's address, per §9.2. */
export const HANDLERS = [
  'projects:unlockNextMilestone',
  'crm:announceApproval',
  'crm:deliverFollowUp',
  'support:triageTicket',
] as const;

export type Handler = (typeof HANDLERS)[number];

/**
 * What listens to what.
 *
 * `invoice.paid` is emitted by finance/service.ts when recorded payments cover
 * an invoice in full. Delivery listens so the next milestone can open; finance
 * neither knows nor cares that it does.
 *
 * `approval.requested` is emitted by the approval engine. crm listens so the
 * internal WhatsApp group is told; approvals neither knows nor cares that a
 * WhatsApp group exists, which is the whole reason this file is the only
 * place the two meet.
 */
export const SUBSCRIPTIONS: Record<string, readonly Handler[]> = {
  'invoice.paid': ['projects:unlockNextMilestone'],
  /**
   * G-110, ADM-11. `approvals.request_approval` emits this for
   * **internal-audience requests only** — a client-audience request is the
   * client's decision recorded by staff with evidence (ADM-08d), and posting
   * it in the internal group would make that channel the chat log
   * docs/business-os §5.1 says it is not. The filter is in the emitter rather
   * than here, because "which requests are announced" is a rule about
   * approvals and not about the wiring.
   */
  'approval.requested': ['crm:announceApproval'],
  /**
   * G-012, ADM-69. The follow-up worker claims an attempt and writes the
   * message through `crm.send_outbound_message`, which leaves it `pending` —
   * exactly as the announcer's does. Something still has to hand it to the
   * provider.
   *
   * That goes through this catalog rather than being called inline, so the
   * delivery inherits the job runner's retry budget, backoff and parking. A
   * worker running in the cron tick has none of those, and adding them would
   * be a second retry subsystem for the same problem.
   */
  'followup.queued': ['crm:deliverFollowUp'],
  /**
   * ADM-82's `support` agent, reached the same way every other handler is.
   *
   * The subscriber is an AGENT rather than a function, and that is the point
   * of routing it through here: the runner claims `maintenance.triage` the way
   * it claims `requirement.extract`, so the agent inherits the retry budget,
   * the backoff, the parking, the autonomy gate and the cost ceiling instead
   * of growing its own. An agent wired in beside those rather than behind them
   * would be an agent that can skip them.
   *
   * It classifies WHAT KIND of work the ticket describes (Doc 18 §8's twelve
   * types) and never whether it is covered — that is §6's commercial question,
   * and the schema it answers with has no field for it.
   */
  'support_ticket.created': ['support:triageTicket'],
};

/**
 * The `core.jobs.kind` each handler runs under.
 *
 * A separate mapping rather than reusing the handler name as the kind, so the
 * `kind` column keeps one naming family (`requirement.extract`,
 * `milestone.unlock`) while handlers keep the `module:function` address §9.2
 * gives them. The runner claims by kind; the catalog is what connects the two.
 */
export const HANDLER_JOB_KIND: Record<Handler, string> = {
  'projects:unlockNextMilestone': 'milestone.unlock',
  'crm:announceApproval': 'approval.announce',
  'crm:deliverFollowUp': 'followup.deliver',
  'support:triageTicket': 'maintenance.triage',
};

export const JOB_KINDS = Object.values(HANDLER_JOB_KIND);

export function subscribersFor(eventType: string): readonly Handler[] {
  return SUBSCRIPTIONS[eventType] ?? [];
}

/**
 * The idempotency key for one (event, handler) pair — §9.1 step 6.
 *
 * `core.jobs.dedupe_key` is globally unique, so this is what makes redelivery
 * free: a dispatcher that crashes after enqueuing but before marking the event
 * published will re-enqueue on the next pass and insert nothing.
 */
export function dedupeKeyFor(eventId: number | string, handler: Handler): string {
  return `evt:${eventId}:${handler}`;
}

/** The shape the dispatcher reads out of core.outbox_events. */
export type OutboxEvent = {
  id: number;
  organization_id: string;
  type: string;
  subject_type: string | null;
  subject_id: string | null;
  payload: unknown;
  /** Present when the dispatcher reads the row; how many enqueue passes have failed. */
  attempts?: number;
};

export type PlannedJob = {
  organization_id: string;
  kind: string;
  dedupe_key: string;
  payload: {
    eventId: number;
    eventType: string;
    subjectType: string | null;
    subjectId: string | null;
    event: unknown;
  };
};

/**
 * The jobs an event produces — one per subscribed handler.
 *
 * The original event payload travels through untouched under `event`. The
 * handler reads the same `projectId` / `milestoneId` / `unlockedMilestoneId`
 * finance wrote; nothing re-derives or reshapes them on the way, so there is
 * exactly one description of what happened rather than two that can drift.
 *
 * An event with no subscribers plans no jobs and is still marked published —
 * "nobody was listening" is a complete outcome, not a failure.
 */
export function planJobsForEvent(event: OutboxEvent): PlannedJob[] {
  return subscribersFor(event.type).map((handler) => ({
    organization_id: event.organization_id,
    kind: HANDLER_JOB_KIND[handler],
    dedupe_key: dedupeKeyFor(event.id, handler),
    payload: {
      eventId: event.id,
      eventType: event.type,
      subjectType: event.subject_type,
      subjectId: event.subject_id,
      event: event.payload,
    },
  }));
}
