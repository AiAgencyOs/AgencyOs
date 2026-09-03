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
  'crm:announceEscalation',
  'crm:deliverFollowUp',
  'support:triageTicket',
  'project_manager:planBreakdown',
  'ui_designer:screenInventory',
  'sales:readIntent',
  'quality_assurance:draftTestPlan',
  'customer_success:draftCheckIn',
  'handover:draftPackage',
  'sales:readQualification',
  'sales:summariseThread',
  'sales:readObjection',
  'sales:composeFollowUp',
  'sales:answerClient',
  'sales:readMedia',
  'sales:draftQuotationScope',
  'crm:dispatchApprovedQuotation',
  'sales:reviseQuotation',
  'sales:reworkQuotation',
  'sales:learnFromDecision',
  'sales:learnFromRevision',
  'crm:announceOfferApplied',
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
   * ADM-96, G-162. `approvals.decide_approval` emits this for EVERY settled
   * request; both listeners filter to their own subject, which is cheaper to
   * reason about than a filter in the emitter that two consumers would have
   * to share. The dispatcher carries an approved quotation to the client —
   * the send a person just authorized, authored with that person — and the
   * reviser turns a `changes_requested` note into the next version. Neither
   * touches the decision itself: ADM-74's boundary (decided in AgencyOS,
   * authenticated) sits upstream of this event existing at all.
   */
  /**
   * G-180 adds a third listener, and it is the only one that writes something
   * permanent. `sales:learnFromDecision` records what the owner decided about
   * a quotation as an organization-scoped memory, so the next draft can see
   * how this agency actually prices rather than only how it priced in August.
   *
   * It listens to the same event as the dispatcher because it is interested in
   * the same moment, and it filters to `approved` inside the handler rather
   * than here: `HANDLER_RELEVANT` reads the payload, which is a CLAIM, and the
   * one thing this handler must never do is write a lesson from a draft nobody
   * approved.
   */
  /**
   * G-185 adds a fourth, and it learns something the third cannot see.
   * `learnFromDecision` records the price relationship between what the agent
   * drafted and what the owner approved; `learnFromRevision` records what the
   * owner DID to the quotation after sending it back — which lines they added,
   * which they dropped, whether they moved the timeline. Separate handlers
   * because they are separate lessons: one is about how this agency prices,
   * the other about what its owner reliably corrects, and a recall that could
   * not ask for them apart would return one when it wanted the other.
   */
  'approval.decided': [
    'crm:dispatchApprovedQuotation',
    'sales:reviseQuotation',
    'sales:learnFromDecision',
    'sales:learnFromRevision',
  ],
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
  /**
   * ADM-11, and the one client-facing thing any agent in this system does.
   * `FOLLOW_UP_BODY` has been one hardcoded English sentence since follow-ups
   * were built, and its own comment says the agent that would replace it is
   * future work. This is it.
   *
   * Emitted when a sequence is SCHEDULED rather than when it is due, so the
   * composer has until the send time to answer and the send never waits on a
   * model call — with no draft, the placeholder goes, exactly as today.
   */
  'followup.due': ['sales:composeFollowUp'],
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
  /**
   * ADM-16, granted 2026-08-13, and unimplemented until now: *"The breakdown
   * from approved requirements into modules, features and tasks is automatic —
   * the AI does it without proposing it for review."*
   *
   * `projects.break_down_requirement` was written for it and has waited for a
   * caller ever since. The acceptance is a person's; everything after it is
   * the decision the owner already made.
   */
  /**
   * Doc 09 §15's first input is *"Confirmed requirements"*, and this is the
   * moment they become confirmed. Two subscribers on one event, doing
   * different halves of what an accepted scope implies: the project manager
   * breaks it into work (ADM-16), the sales agent writes the quotation's
   * lines. Neither prices anything and neither reaches a client.
   */
  'requirement.accepted': ['project_manager:planBreakdown', 'sales:draftQuotationScope'],
  /**
   * Doc 12 §4: the designer's first act is to read the agreed scope and derive
   * the screens it needs. `ScopeFrozen` is the moment that scope becomes
   * agreed, so it is the moment the inventory can be produced.
   *
   * The first subscription whose agent is L2. It runs because ADM-61 §2 lets
   * an L2 agent draft, not because anything was relaxed: filing the inventory
   * as a design version and submitting it for approval is §3 work and stays
   * with the internal group.
   */
  /**
   * Two agents, one event, and the first time this catalog fans out.
   *
   * A frozen baseline is the moment two different questions become answerable
   * at once: *what screens does this need* (Doc 12 §9) and *what must be
   * tested* (Doc 14 §5). Both read the same rows and neither reads the
   * other's, so they are two subscribers rather than one handler doing two
   * jobs — each gets its own claim, its own retry budget and its own run
   * record, and one failing does not lose the other's work.
   *
   * Doc 14 §2 puts TEST PLAN after DEVELOPMENT COMPLETE, and there is no
   * developer agent to declare that yet. The plan is written from the approved
   * baseline (§3), not from the build, so it does not need one — and a plan
   * that exists before the work starts is the only kind anybody can build
   * against.
   */
  'scope.frozen': ['ui_designer:screenInventory', 'quality_assurance:draftTestPlan'],
  /**
   * Doc 17 §17: *"Day 0: Handover and acceptance."* Accepting a handover was
   * an audit row and nothing else; §18 gives the customer success agent
   * eleven responsibilities that all begin the moment it happens.
   *
   * The brief it drafts is preparation, not communication. §22 lists the
   * check-in itself under customer success COMMUNICATION, which ADM-61 §3
   * keeps behind a person — so this queues a reading of what the project left
   * behind, and nothing reaches the client.
   */
  /**
   * Doc 17 §9, and the other end of the same document. Opening a package is
   * the moment its contents become answerable — what the project agreed to
   * and what it produced are both on the table, and neither changes again.
   *
   * The agent lists what the package OWES. Delivering it is §3's
   * `delivery_approval` and stays with a person; `refuse_incomplete_package`
   * is what makes the list matter, because until now `deliver_handover` could
   * only refuse an EMPTY package and one item satisfied it as completely as
   * fifteen.
   */
  'handover.preparing': ['handover:draftPackage'],
  'handover.accepted': ['customer_success:draftCheckIn'],
  /**
   * Doc 08 §12. The first step of answering a lead, and the only step of it
   * that reaches nobody: naming what a client's message means is internal
   * work, and the label it produces causes nothing.
   */
  /**
   * And the third — G-198, Doc 05 §6.
   *
   * A subscriber rather than its own event for the same reason the qualifier
   * is one: a message arriving is the only thing that can make a thread
   * longer, and this is a second thing worth reading it for. It costs no
   * model call at all on a short thread or a fresh summary — the handler
   * settles in milliseconds — so subscribing to every message is cheap and
   * subscribing to a threshold event nobody emits is not possible.
   */
  'message.received': ['sales:readIntent', 'sales:readQualification', 'sales:summariseThread'],
  /**
   * Doc 09 §19, and the reason it is a separate event rather than a third
   * subscriber on `message.received`: four of Doc 08 §12's twenty-two intents
   * are objection-shaped (change_request joined the original three in G-157
   * — a scope ask against a sent quotation is a feature objection wearing
   * plainer words), and the other eighteen are not. Reading only those
   * costs a model call when there is something to read.
   *
   * `crm.emit_objection_raised` fires on the intent being written, so this is
   * the sales agent reading its own earlier reading — which is the cheapest
   * form of "only look closer when the first look says to".
   */
  'objection.raised': ['sales:readObjection'],
  /**
   * G-163, ADM-96's second half — widened by G-183.
   *
   * The objection-read job writes the row; the row's insert emits this; and an
   * objection against a sent quotation becomes the agent's rework — drafted,
   * priced, submitted, decided by the owner exactly like every other version.
   *
   * ── why PRICE now enters the loop, and why that is not a new authority ──
   *
   * It used to be `feature` alone, and the reason given was ADM-22's posture:
   * the agent may not move a number under client pressure. That reasoning
   * confused two different things, and a zero-trust audit's owner decision
   * separated them.
   *
   * What ADM-22 forbids is a number reaching a CLIENT without a person
   * deciding it. A rework decides nothing: it drafts a version and submits it
   * for approval, exactly as the scope-change loop does, and the owner sees it
   * before anybody else. Refusing to draft did not protect the price — it
   * left the whole response to a person while the request sat in a queue.
   *
   * The corpus's own discipline survives untouched, in the prompt rather than
   * in the wiring: *protect the number by cutting scope, never by
   * discounting.* The agent re-scopes to a smaller honest build and the owner
   * decides whether that is the right answer.
   *
   * `trust` and `timeline` still never enter it. Neither is a scope, and a
   * redraft is the wrong shape of answer to both — a client who does not trust
   * you is not asking for a different quotation.
   */
  'objection.recorded': ['sales:reworkQuotation'],
  /**
   * G-184, ADM-98 — the half of the owner's decision they asked for by name:
   * *"you are told afterwards."*
   *
   * A pre-authorised offer is the one path in this system where a price
   * reaches a client without a fresh decision. It is not a silent one: the
   * same announcement channel that carries an approval request carries this,
   * after the fact, saying which offer went to whom and for how much.
   *
   * A separate event from `approval.decided`, which the same application also
   * emits. That one drives the machinery — the dispatch and the learning,
   * neither of which needs to know an offer was involved. This one is a
   * person being told.
   */
  'offer.applied': ['crm:announceOfferApplied'],
  /**
   * ADM-91, 2026-08-22: *"ai agent khud kare"*. The owner widened ADM-11 so a
   * reply to an inbound WhatsApp message reaches the client with nobody
   * reading it first — the second such path in AgencyOS, and the first inside
   * a live conversation.
   *
   * A separate event rather than a third subscriber on `message.received`,
   * because answering is a different act from reading and must be switchable
   * on its own: `crm.emit_reply_due` fires only where
   * `core.organizations.agent_answers_clients` is on, and the workflow reads
   * the switch again before it sends.
   */
  'reply.due': ['sales:answerClient'],
  /**
   * Doc 09 §7 and §36. The agent stopping is half an escalation; this is the
   * half that reaches a person.
   *
   * The same announcer `approval.requested` uses — G-110's path, ADM-74's
   * channel — because a second notifier would be a second thing to keep in
   * step, and the one that drifts is the one nobody remembers exists.
   */
  'conversation.escalated': ['crm:announceEscalation'],
  /**
   * Brief 2026-08-22 §28, and Doc 08 §9 for its sibling below. Separate events
   * rather than subscribers on `message.received`, because neither is a
   * reading of a message — they are what has to happen BEFORE the message can
   * be read at all.
   *
   * `crm.emit_media_received` fires one or the other, only for a file carrying
   * a media id, and the same condition holds `message.received` and
   * `reply.due` back until the reading lands. So the ordering is not a
   * convention this file states; it is the one condition, asked in three
   * places.
   *
   * Two events and one handler: a photograph and a voice note are different
   * things to see in a log, and the same thing to do something about.
   */
  'image.received': ['sales:readMedia'],
  'audio.received': ['sales:readMedia'],
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
  'crm:announceEscalation': 'escalation.announce',
  'crm:deliverFollowUp': 'followup.deliver',
  'support:triageTicket': 'maintenance.triage',
  'project_manager:planBreakdown': 'plan.breakdown',
  'ui_designer:screenInventory': 'ui.inventory',
  'sales:readIntent': 'message.intent',
  'quality_assurance:draftTestPlan': 'qa.plan',
  'customer_success:draftCheckIn': 'success.checkin',
  'handover:draftPackage': 'handover.package',
  'sales:readQualification': 'lead.qualify',
  'sales:summariseThread': 'conversation.summarise',
  'sales:readObjection': 'objection.read',
  'sales:composeFollowUp': 'followup.compose',
  'sales:answerClient': 'reply.compose',
  'sales:readMedia': 'message.describe',
  'sales:draftQuotationScope': 'quotation.scope',
  'crm:dispatchApprovedQuotation': 'proposal.dispatch',
  'sales:reviseQuotation': 'quotation.revise',
  'sales:reworkQuotation': 'quotation.rework',
  'sales:learnFromDecision': 'quotation.learn',
  'sales:learnFromRevision': 'quotation.learnrevision',
  'crm:announceOfferApplied': 'offer.announce',
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
/**
 * Plan-time relevance — which events are even WORTH a job.
 *
 * `approval.decided` fires for every subject type (invoices, deliverables,
 * refunds…), and both of its listeners act only on proposals. Without this
 * filter every unrelated decision enqueues two jobs that exist to say
 * "not mine" — and the reviser is an AGENT job, so with the sales agent
 * disabled each one would retry into a parked failure, one dead job per
 * decision about something else entirely.
 *
 * The payload is a CLAIM (the PR #178 lesson), and that is fine HERE: this
 * filter only decides whether to spend a job. A forged "proposal" claim buys
 * an extra no-op job whose handler re-reads the request ROW and answers
 * not_mine; a forged "invoice" claim on a real proposal decision suppresses
 * the shortcut jobs, and the decision still stands in the row for the UI's
 * own carry. Authority never lives in this filter.
 */
const HANDLER_RELEVANT: Partial<Record<Handler, (event: OutboxEvent) => boolean>> = {
  'crm:dispatchApprovedQuotation': (event) =>
    (event.payload as { subjectType?: string } | null)?.subjectType === 'proposal',
  'sales:reviseQuotation': (event) =>
    (event.payload as { subjectType?: string } | null)?.subjectType === 'proposal',
  // The same cheap filter the two above use, and for the same reason: an
  // `approval.decided` for an invoice would otherwise spend a job to answer
  // "not mine". It decides only whether to SPEND a job — the handler re-reads
  // the row, so a forged claim buys an extra no-op and no authority.
  'sales:learnFromDecision': (event) =>
    (event.payload as { subjectType?: string } | null)?.subjectType === 'proposal',
  'sales:learnFromRevision': (event) =>
    (event.payload as { subjectType?: string } | null)?.subjectType === 'proposal',
  // Only a scope-change objection against a named quotation buys a rework
  // job; price, trust and timeline objections never do (see SUBSCRIPTIONS).
  // Only a scope or price objection against a NAMED quotation buys a rework
  // job (G-183 added price); trust and timeline never do — see SUBSCRIPTIONS.
  'sales:reworkQuotation': (event) => {
    const claim = event.payload as { kind?: string; proposalId?: string | null } | null;
    return (claim?.kind === 'feature' || claim?.kind === 'price') && Boolean(claim?.proposalId);
  },
};

export function planJobsForEvent(event: OutboxEvent): PlannedJob[] {
  return subscribersFor(event.type)
    .filter((handler) => HANDLER_RELEVANT[handler]?.(event) ?? true)
    .map((handler) => ({
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
