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
  'projects:startPhaseTwo',
  'projects:startPhaseThree',
  'projects:announcePhaseThree',
  'projects:askFinalDesignConfirmation',
  'projects:startPhaseFour',
  'orchestrator:routeTask2Design',
  'orchestrator:routeDevelopmentPlan',
  'orchestrator:routeQaOutcome',
  'quality_assurance:reviewUIVersion',
  'orchestrator:requestUIVersionAdminReview',
  'ui_prototype:build',
  'ui_prototype:reviseBuild',
  'quality_assurance:reviewPrototypeBuild',
  'projects:completePhaseFourOnPrototypeApproval',
  'projects:startPhaseFive',
  'projects:recordM3Verified',
  'projects:startPhaseSix',
  'projects:scheduleQaJobs',
  'projects:reopenOnSourceChange',
  'crm:announceTestingStarted',
  'crm:announceQaClarification',
  'crm:announceQaDefectProgress',
  'projects:recordM4Verified',
  'crm:announceReleaseCandidateApproved',
  'crm:announceReleaseCandidateReady',
  'crm:announceReleaseExceptionRequested',
  'crm:announcePhaseEightStarted',
  'crm:announceSupportTicketEscalated',
  'crm:announceSupportSlaBreached',
  'crm:announceRetentionRecoveryRequired',
  'crm:announceMaintenanceRenewalDue',
  'crm:announceMaintenanceWorkOpened',
  'crm:announceMaintenanceQaFailed',
  'crm:announceMaintenanceReleaseRequested',
  'crm:announceMaintenanceReleaseApproved',
  'crm:announceMaintenanceReleased',
  'crm:announceMaintenanceBillingProposed',
  'crm:announceMaintenanceSlaBreached',
  'crm:announceMaintenanceWorkStalled',
  'crm:announceQaReverification',
  'crm:announceM4PaymentVerified',
  'crm:announceFinanciallyClosed',
  'projects:validateQaIntake',
  'crm:announcePhaseSixReady',
  'crm:announceM3PaymentVerified',
  'crm:announceBuildFeedbackRouted',
  'finance:generateM1Invoice',
  'finance:deliverIssuedInvoice',
  'finance:raiseFreeMaintenance',
  'project_planning:draftBlueprint',
  'projects:askClarification',
  'projects:readClarificationAnswer',
  'projects:welcomeClient',
  'projects:askGstDetails',
  'projects:updateClientOnPayment',
  'projects:readBillingReply',
  'finance:generateM2Invoice',
  'finance:generateM3Invoice',
  'finance:generateM4Invoice',
  'projects:openChangeRequestFromScopeEscalation',
  'crm:announceApproval',
  'crm:announceEscalation',
  'crm:acknowledgeHandover',
  'crm:deliverFollowUp',
  'support:triageTicket',
  'project_manager:planBreakdown',
  'ui_designer:designDirections',
  'ui_designer:screenInventory',
  'ui_designer:draftUIVersion',
  'ui_designer:reviseUIVersion',
  'project_manager:classifyClientFeedback',
  'project_manager:suggestBuildFeedbackClass',
  'project_manager:readDesignReply',
  'sales:readIntent',
  'sales:readMeetingRequest',
  'sales:readLeadOutcome',
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
  'sales:syncDiscountDecision',
  'crm:announceOfferApplied',
  'crm:announceRevisionLimitEscalated',
  'crm:announcePhaseThreeCompleted',
  'crm:announcePhaseFourStarted',
  'crm:announceUiVersionAdminReviewed',
  'crm:announceUiVersionChangeRequested',
  'crm:announceUiVersionLocked',
  'crm:announcePrototypeSubmitted',
  'crm:announcePrototypeChangeRequested',
  'crm:announceTask2Complete',
  'crm:announceTask3Complete',
  'crm:announcePhaseFiveStarted',
  'crm:announceBuildShared',
  'crm:announceBuildFeedbackReceived',
  'crm:announceBuildApproved',
  'crm:announceBuildReadyForAdmin',
  'crm:announceDevelopmentEscalated',
  'crm:announceModuleCompleted',
  'crm:announceDevClarification',
  'crm:announceTask4Complete',
  'crm:announceM2PaymentVerified',
  'crm:routeLead',
  'crm:classifyLeadIdentity',
  // Phase 7 (Production Launch & Handover): the entry gate, the deployment runner door, and the PM7 announcers
  'projects:openPhaseSeven',
  'projects:runDeployment',
  'crm:announcePhaseSevenReady',
  'crm:announceDeploymentApproved',
  'crm:announceProductionValidated',
  'crm:announceProductionValidationFailed',
  'crm:announceHandoverReady',
  'crm:announceProjectCompleted',
  // Phase 7b: the Phase 7 -> Phase 8 seam (the intake reads the frozen handoff) and the Orchestrator's recorded Phase 7 routing decision
  'projects:fillPhaseEightIntake',
  'projects:routePhaseSevenTask',
  // Phase 7c / 8A: a client's support message opens a ticket (it never replies); a validated production gets a DRAFT handover package (it never delivers)
  'projects:openSupportTicketFromMessage',
  'projects:createDraftHandoverPackage',
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
  // PM4-M08 (Impl §8; PM §5) fans out from the same pre-existing fact: an
  // Admin's real verification, re-checked against the milestone row rather
  // than trusted from the payload, filtered to M2 (position 2) inside the
  // handler — this is not a second gate, only a second listener on one.
  // Phase 2 Planning §2: the advance verified opens planning. The agent itself decides whether this invoice IS the advance.
  'invoice.paid': ['projects:unlockNextMilestone', 'crm:announceM2PaymentVerified', 'projects:startPhaseFive', 'projects:recordM3Verified', 'projects:recordM4Verified', 'project_planning:draftBlueprint', 'projects:updateClientOnPayment'],
  'project.planning_requested': ['project_planning:draftBlueprint'],
  /** Planning §10: the planner's question goes to the client through the PM, one at a time. */
  'project.clarification_required': ['projects:askClarification'],
  'project.clarification_resolved': ['projects:askClarification'],
  /**
   * Phase 2 Master Flow §5.1 — the receiver PH1-CLS-002 said would arrive.
   *
   * Not `opportunity.handed_off`, which fires at the WIN with no project:
   * conversion is a separate human act that may come hours later or never,
   * and Master §5.3's workspace IS the project. So Phase 2 starts at the
   * BINDING, which `ai.handoffs` now emits for itself.
   */
  'project.handoff_bound': ['projects:startPhaseTwo', 'projects:welcomeClient'],
  /**
   * Master §7.12 and §15 — Phase 3's entry, and the event G-258 emitted into
   * nothing on purpose.
   *
   * `record_kickoff` emits this when Phase 2 completes. The handler calls the
   * door and does nothing else; the PM's client-facing announcement is its own
   * unit, because a phase that begins by messaging a client is the one step
   * nobody can undo.
   */
  'project.phase_three_ready': ['projects:startPhaseThree'],
  /** Phase 3 PM §7.1: the PM tells the client the UI finalization stage has begun (the workspace row is the authority, not the payload). */
  'project.phase_three_started': ['projects:announcePhaseThree'],
  /** Phase 3 PM §15: a theme and colour chosen -> the PM asks for the explicit final confirmation. */
  'project.client_design_selected': ['projects:askFinalDesignConfirmation'],
  /**
   * Phase 2 Master Flow §5–§6 — GST/Non-GST confirmation → Finance Agent →
   * M1 invoice, as one automated step rather than a person opening the
   * project page. `finance.confirm_billing_mode` emits this once the profile
   * is complete; the handler re-checks completeness itself rather than
   * trusting the payload, and skips quietly for a project whose payment plan
   * was configured by hand instead of the locked structure.
   */
  'project.billing_mode_confirmed': ['finance:generateM1Invoice', 'projects:askGstDetails'],
  /** Phase 2 PM §6 PM-08: where the client's payment stands, said to the client. */
  'payment.submitted': ['projects:updateClientOnPayment'],
  'payment.rejected': ['projects:updateClientOnPayment'],
  'payment.mismatched': ['projects:updateClientOnPayment'],
  /** Phase 2 Finance §4.5 — the issued bill reaches the client's email and the project group. */
  'invoice.issued': ['finance:deliverIssuedInvoice'],
  /**
   * Master §17: "new functionality is not automatically a design revision."
   * `record_client_design_decision` has emitted this since it was written
   * (20260919140000), and stops Phase 3 into `scope_escalation` the same
   * moment — but nothing ever subscribed, so the change request a PM needs to
   * triage waited on somebody to notice the phase had stopped and open one by
   * hand. Wired the same way G-309 wired `project.revision_limit_escalated`:
   * the emitting function is untouched, a handler closes the gap.
   */
  'project.possible_scope_change_detected': ['projects:openChangeRequestFromScopeEscalation'],
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
    // Business Phase 1-4 audit step 1.27: carries an owner's decision onto
    // the discount_decisions row it settled. Filters to
    // subject_type = 'discount_decision' itself, exactly as the other three
    // filter to 'proposal'.
    'sales:syncDiscountDecision',
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
  // Master §7.5 — the directions are drawn against the finalized screen list,
  // so this is the moment there is something to draw for. Phase 3 starting is
  // too early: the baseline does not exist yet.
  'project.screen_list_finalized': ['ui_designer:designDirections'],
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
  // Finance §9: Phase 7 complete → the free-maintenance ₹0 document, if maintenance was included free.
  'handover.accepted': ['customer_success:draftCheckIn', 'finance:raiseFreeMaintenance'],
  // ...and once raised it is delivered like any invoice.
  'maintenance.free_invoice_issued': ['finance:deliverIssuedInvoice'],
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
  /**
   * G-249 added the fourth — Scheduler §3.1.
   *
   * A subscriber here rather than on the intent being written, the way
   * `objection.raised` is. Asking for a call is not one of Doc 08 §12's
   * twenty-two intents and does not belong among them: a message can be a
   * price enquiry AND ask to meet, and a single-label column cannot carry
   * both. Two orthogonal readings, so two readings.
   *
   * It costs a model call per inbound client message, which is the price of
   * §3.1 being a reading rather than a keyword. The handler declines before
   * the call for a message from staff, a thread with no lead, and a lead that
   * already has a meeting open — which is the lead most likely to write again.
   */
  'message.received': ['sales:readIntent', 'sales:readQualification', 'sales:summariseThread', 'sales:readMeetingRequest', 'sales:readLeadOutcome', 'projects:readBillingReply', 'projects:readClarificationAnswer', 'project_manager:readDesignReply', 'projects:openSupportTicketFromMessage'],
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
   * A client wrote while their thread waits for a person. The agent stays
   * silent; the APPLICATION tells the client once that a colleague has it, and
   * tells staff each time the client writes. Owner decision 2026-10-03.
   */
  'conversation.client_waiting': ['crm:acknowledgeHandover'],
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
  /**
   * Master §16, PM §4.8 — G-309.
   *
   * `projects.open_design_revision` emits this the moment Phase 3's client
   * revision limit is reached and the phase stops itself. Until now nothing
   * subscribed: the event sat in the outbox and the only surfacing was a
   * badge on that one project's own Admin Panel page, which tells nobody
   * unless they were already looking at it. Reuses the same "internal group"
   * announcer `conversation.escalated` uses, because it is the same act:
   * telling a person that something needs them.
   */
  'project.revision_limit_escalated': ['crm:announceRevisionLimitEscalated'],
  /**
   * Master §7.12 — G-309.
   *
   * `projects.lock_phase_three_direction` emits this always, the moment a
   * client confirms a UI direction, whether or not the handoff is Phase 4
   * ready. Task 1 could previously close with only a database row and a UI
   * badge to show for it.
   */
  'project.phase_three_completed': ['crm:announcePhaseThreeCompleted'],
  /**
   * Impl §8 / ORCH §19, Phase 4's own entry — the receiver
   * `20260923100000_phase_four_begins_where_phase_three_locks.sql` says
   * `project.phase_four_ready` was waiting for since 20260920000000.
   *
   * The handler calls the door and does nothing else; the PM's Task 2 start
   * communication is its own unit once it exists, the same argument
   * `project.phase_three_ready` already made for not messaging a client from
   * inside a phase-start handler.
   */
  'project.phase_four_ready': ['projects:startPhaseFour'],
  /**
   * ORCH §4, §19 — the Orchestrator's first real routing act.
   *
   * `20260923100000_phase_four_begins_where_phase_three_locks.sql` emits this
   * once Task 2's workspace exists, with a comment saying it is "consumed by
   * the PM's Task 2 start communication once it exists." The PM announcement
   * still does not exist (gap analysis step 5), but routing Task 2's first
   * hop to a designer does not depend on it — the two are independent
   * reactions to the same fact, exactly like `project.phase_three_completed`
   * fanning out to more than one subscriber once there was a second thing
   * worth doing with it.
   */
  'project.phase_four_started': [
    'orchestrator:routeTask2Design',
    'ui_designer:draftUIVersion',
    'crm:announcePhaseFourStarted',
  ],
  /**
   * QAP §7, UID §19; ADM-82 — Design QA, decided by quality_assurance, never
   * by the ui_designer whose draft it reviews.
   *
   * `20260923110000_the_ui_version_designs_the_locked_screens.sql` emits this
   * the moment `record_ui_version_draft` succeeds. The handler calls
   * `verdictFor` (`src/modules/agents/verification.ts`) — the same
   * producer≠verifier contract every other completion in this codebase goes
   * through — rather than a bespoke Design-QA-only rule.
   */
  'project.ui_version_drafted': ['quality_assurance:reviewUIVersion'],
  /**
   * Impl §7.2; Master's locked objective: "QA PASS → ADMIN REVIEW".
   *
   * Fires for every verdict, `qa_changes_required` included; the handler's
   * own row-authority check (not the payload) is what decides whether review
   * is actually raised — see `handleRequestUIVersionAdminReview`'s docblock.
   */
  'project.ui_version_qa_reviewed': ['orchestrator:requestUIVersionAdminReview', 'ui_designer:reviseUIVersion'],
  /**
   * PROTO §4, §8 — the Prototype Agent's first build, off the fact
   * `20260923140000_the_client_confirms_the_locked_ui.sql`'s `lock_ui_version`
   * already emits.
   */
  'project.ui_version_locked': ['ui_prototype:build', 'crm:announceUiVersionLocked'],
  /**
   * PM4-M02, Impl §8 — `sync_ui_version_decision` has emitted this since
   * `20260923130000_admin_review_reuses_the_engine.sql` and nothing ever
   * subscribed, the same gap `project.phase_three_completed` sat in before
   * G-309. `announceUiVersionAdminReviewed` filters to `admin_approved`
   * inside the handler. `ui_designer:reviseUIVersion` (20260924120000)
   * filters to `admin_edit` — Master's OTHER path back to the designer,
   * sharing the same door and revision counter the client_change path uses.
   */
  'project.ui_version_admin_reviewed': ['crm:announceUiVersionAdminReviewed', 'ui_designer:reviseUIVersion'],
  /**
   * PM4-M03, Impl §8 — `record_ui_version_client_decision`
   * (`20260923140000_the_client_confirms_the_locked_ui.sql`) has emitted this
   * since it was written; `announceUiVersionChangeRequested` filters to
   * `change_requested` inside the handler (`final_confirmed` is announced via
   * `project.ui_version_locked` instead, once the lock actually happens).
   */
  /**
   * The revision loop (`20260924100000`). `ui_designer:reviseUIVersion`
   * filters to `change_requested` inside the workflow — a `final_confirmed`
   * decision drafts nothing, the lock door handles that path instead.
   */
  'project.ui_version_client_decided': [
    'crm:announceUiVersionChangeRequested',
    'ui_designer:reviseUIVersion',
    // Additive, PM Agent spec §4.6/§8: classifies the client's free-text
    // feedback into six categories. Filters to change_requested itself and
    // never gates/duplicates the revision loop above.
    'project_manager:classifyClientFeedback',
  ],
  /**
   * QAP §7 — Prototype QA, decided by quality_assurance, never by
   * ui_prototype whose build it reviews (ADM-82). Off the fact
   * `record_prototype_build` already emits.
   */
  'project.prototype_build_ready': ['quality_assurance:reviewPrototypeBuild'],
  /**
   * QAP §Prototype QA defect flow: a build Prototype QA sent back (qa_changes_required) is fixed by the Prototype Agent as a NEW build that
   * is QA'd from scratch (FIXED is not VERIFIED). The workflow filters to qa_changes_required itself - the event fires for every verdict.
   */
  'project.prototype_qa_reviewed': ['ui_prototype:reviseBuild'],
  /**
   * Prototype spec, Admin review: ADMIN EDIT -> PROTOTYPE AGENT -> QA -> ADMIN AGAIN (never ADMIN EDIT -> CLIENT). Fires for approved too;
   * the workflow filters to changes_required itself.
   */
  'project.prototype_admin_decided': ['ui_prototype:reviseBuild'],
  /**
   * Impl §7.4; Master steps 39-40 — Task 2 closes on the FINAL prototype's
   * approval. `project.deliverable_decided` (new, `20260923160000_m2_and_
   * the_gate_it_actually_needs.sql`) fires for every deliverable kind's
   * decision; the handler filters to `kind = 'prototype'` and
   * `status = 'approved'` itself, because the SQL this event comes from is
   * shared by design/prototype/build/document deliverables alike and must
   * not know what Phase 4 is.
   */
  'project.deliverable_decided': [
    'projects:completePhaseFourOnPrototypeApproval',
    'crm:announcePrototypeChangeRequested',
    'crm:announceBuildApproved',
    'ui_prototype:reviseBuild',
  ],
  /**
   * PM4-M05, Impl §8 — off the same event `submit_deliverable` (any kind)
   * always emitted starting `20260923160000_m2_and_the_gate_it_actually_
   * needs.sql`; the handler filters to `kind = 'prototype'` itself.
   */
  'project.deliverable_submitted': ['crm:announcePrototypeSubmitted', 'crm:announceBuildShared', 'projects:reopenOnSourceChange'],
  /**
   * Finance §2, §5 — the M2 (20%) invoice, off the fact
   * `projects.complete_phase_four` already emits. PM4-M07 (Task 2 Complete)
   * fans out from the same event, independent of the invoicing chain.
   */
  'project.phase_four_completed': ['finance:generateM2Invoice', 'crm:announceTask2Complete'],
  /** Phase 5 Orchestrator spec: an Admin-approved plan is routed task by task to the named specialists (held, not faked, while they are disabled). */
  'project.development_plan_approved': ['orchestrator:routeDevelopmentPlan'],
  /** Phase 5 Orchestrator spec section 11: QA failed or passed a development task. The handler re-reads the task, its runs and defects and records a routing decision. */
  'project.dev_task_qa_failed': ['orchestrator:routeQaOutcome'],
  'project.dev_task_qa_passed': ['orchestrator:routeQaOutcome'],
  /** PM5-M01 (Phase 5 PM Agent spec): Task 3 Start, off the fact `start_phase_five` emits. */
  'project.phase_five_started': ['crm:announcePhaseFiveStarted'],
  /** PM5-M03: the client's feedback on a build was recorded and is awaiting classification. */
  /** PM5-A01 / A02 / M03 / M02: ready for the Admin, escalated work, module progress, a clarification question. */
  'project.build_ready_for_admin': ['crm:announceBuildReadyForAdmin'],
  'project.development_escalated': ['crm:announceDevelopmentEscalated'],
  'project.module_completed': ['crm:announceModuleCompleted'],
  'project.dev_clarification_requested': ['crm:announceDevClarification'],
  'project.build_feedback_received': ['crm:announceBuildFeedbackReceived', 'project_manager:suggestBuildFeedbackClass'],
  /** PM5: what became of the feedback (defect, change request, revision, clarification). */
  'project.build_feedback_routed': ['crm:announceBuildFeedbackRouted'],
  /** Finance spec, Phase 6 gate: M3 verified paid in full, recorded once; the PM tells the team. */
  'project.m3_payment_verified': ['crm:announceM3PaymentVerified', 'projects:startPhaseSix'],
  /**
   * Q-PH56 (owner, round 3) — exactly as Phase 4 above: completing Phase 5
   * (development) raises the M3 invoice and the PM's Task 3 message; completing
   * Phase 6 (testing) raises M4 and the PM's Task 4 message. Both events come
   * from `projects.complete_phase` (`20261009100000_phase_five_and_six_...`).
   */
  'project.phase_five_completed': ['finance:generateM3Invoice', 'crm:announceTask3Complete', 'projects:startPhaseSix'],
  /** P601 §55: an approved Master Test Plan is scheduled to the QA specialists (held, not faked, while they are disabled); the PM tells the team testing began. */
  'project.master_test_plan_approved': ['projects:scheduleQaJobs', 'crm:announceTestingStarted'],
  /** P601 §38: QA may ask the client ONE genuinely ambiguous question; the PM is told it exists. */
  'project.qa_clarification_requested': ['crm:announceQaClarification'],
  /** PM6: a defect found in testing is being corrected (client-safe: severity class only). */
  'project.qa_defect_handed_off': ['crm:announceQaDefectProgress'],
  /** PM6: the Admin approved the exact release candidate. */
  'project.release_candidate_approved': ['crm:announceReleaseCandidateApproved'],
  /** PM6-A01: a release candidate was frozen; an Admin is asked to review it. */
  'project.release_candidate_created': ['crm:announceReleaseCandidateReady'],
  /** PM6-A02: an exception to a release rule waits for the owner. */
  'project.release_exception_requested': ['crm:announceReleaseExceptionRequested'],
  /** PM8-M01: Phase 8 (Customer Success) started for a completed project. */
  'project.phase_eight_started': ['crm:announcePhaseEightStarted'],
  /** PM8-A01: a support ticket was escalated to a person. */
  'support.ticket_escalated': ['crm:announceSupportTicketEscalated'],
  /** PM8-A02: a support ticket missed its response or resolution target. */
  'support.sla_breached': ['crm:announceSupportSlaBreached'],
  /** PM8-RECOVERY: an account is at risk and a recovery plan was opened. */
  'customer.retention_recovery_required': ['crm:announceRetentionRecoveryRequired'],
  /** PM8-RENEWAL-DUE: a maintenance plan entered its renewal window; a review was opened, nothing was renewed. */
  'maintenance.renewal_due': ['crm:announceMaintenanceRenewalDue'],
  /** PM8-C01: project.maintenance_work_opened. */
  'project.maintenance_work_opened': ['crm:announceMaintenanceWorkOpened'],
  /** PM8-C02: project.maintenance_qa_failed. */
  'project.maintenance_qa_failed': ['crm:announceMaintenanceQaFailed'],
  /** PM8-C03: project.maintenance_release_requested. */
  'project.maintenance_release_requested': ['crm:announceMaintenanceReleaseRequested'],
  /** PM8-C04: project.maintenance_release_approved. */
  'project.maintenance_release_approved': ['crm:announceMaintenanceReleaseApproved'],
  /** PM8-C05: project.maintenance_released. */
  'project.maintenance_released': ['crm:announceMaintenanceReleased'],
  /** PM8-C06: finance.maintenance_billing_proposed. */
  'finance.maintenance_billing_proposed': ['crm:announceMaintenanceBillingProposed'],
  /** PM8-C07: project.maintenance_sla_breached. */
  'project.maintenance_sla_breached': ['crm:announceMaintenanceSlaBreached'],
  /** PM8-C08: project.maintenance_work_stalled. */
  'project.maintenance_work_stalled': ['crm:announceMaintenanceWorkStalled'],
  /** PM6: the source changed after approval; testing is repeated. */
  'project.phase_six_evidence_stale': ['crm:announceQaReverification'],
  /** P601 §41: M4 verified paid in full, recorded once; the PM tells the team. */
  'project.m4_payment_verified': ['crm:announceM4PaymentVerified', 'projects:openPhaseSeven'],
  /** Phase 9: a Finance person or Admin closed the project's finances (NOT project completion); the PM tells the team. */
  'project.financially_closed': ['crm:announceFinanciallyClosed'],
  /** P601 §3: Phase 6 READY (once) -> the QA intake is validated and the PM announces Task 4. */
  'project.phase_six_ready': ['projects:validateQaIntake', 'crm:announcePhaseSixReady'],
  'project.phase_six_completed': ['finance:generateM4Invoice', 'crm:announceTask4Complete', 'projects:openPhaseSeven'],
  /** P701 §14 Phase 7: Phase7Ready -> PM7-M01 (Task 5 start). Emitted once by `open_phase_seven`, only after Phase6Completed + the exact candidate + M4 verified. */
  'project.phase_seven_ready': ['crm:announcePhaseSevenReady'],
  /** P704: DeploymentApproved -> the runner door records the deployment (the executor is NOT configured: it records a blocker) + the PM tells the team approval is not deployment. */
  'project.deployment_approved': ['projects:runDeployment', 'crm:announceDeploymentApproved', 'projects:routePhaseSevenTask'],
  /** P706: after a ROLLBACK recovery is verified and the incident closed, the same approved candidate is redeployed through the same runner door. */
  'project.deployment_incident_closed': ['projects:runDeployment'],
  /** P705: ProductionValidated (QA/Release evidence, never a deployment claim) -> PM7 prepares the handover communication. */
  'project.production_validated': ['crm:announceProductionValidated', 'projects:createDraftHandoverPackage'],
  /** P705/P706: DeploymentValidationFailed -> a controlled, client-safe status; completion is paused. */
  'project.production_validation_failed': ['crm:announceProductionValidationFailed', 'projects:routePhaseSevenTask'],
  /** P707/P708: the Admin-approved package was delivered -> invite the client's formal review. */
  'project.handover_delivered': ['crm:announceHandoverReady'],
  /** P701/P708: ProjectCompleted (gate passed, immutable record written) -> completion + support/warranty message and the Customer Success transition. */
  'project.completed': ['crm:announceProjectCompleted', 'projects:fillPhaseEightIntake'],
  /** P703: a Phase 7 failure is triaged by the Orchestrator's recorded routing decision (held while the agents are disabled). Completion pause and the incident are the database's. */
  'project.deployment_failed': ['projects:routePhaseSevenTask'],
  /**
   * Audit 1.2/1.3 (docs/AGENCYOS_BUSINESS_PHASE_1_4_AUDIT.json), Implementation
   * Plan Phase 1 items 1 and 3 — the two gaps the audit named "no
   * lead-routing algorithm exists" and "no automatic identity classification
   * exists anywhere."
   *
   * `crm.emit_lead_created` (20261030300000) fires this for every path that
   * inserts crm.leads, not only the WhatsApp ingest wired today. Two
   * independent subscribers on the one fact, the same shape `scope.frozen`
   * fans out to two designers: routing decides WHO owns the lead, identity
   * classification decides WHAT the lead already is, and neither reads the
   * other's answer. Both handlers call a SECURITY DEFINER door
   * (crm.route_lead / crm.classify_lead_identity) that re-reads the lead row
   * rather than trusting this event's payload, and both refuse rather than
   * guess when the fact they need (an assignment already made, a
   * classification already written) already exists — so a replayed event is
   * a no-op, not a second decision.
   */
  'lead.created': ['crm:routeLead', 'crm:classifyLeadIdentity'],
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
  'projects:startPhaseTwo': 'phase_two.start',
  'projects:startPhaseThree': 'phase_three.start',
  'projects:announcePhaseThree': 'pm.phase3_announce',
  'projects:askFinalDesignConfirmation': 'pm.design_final_ask',
  'projects:startPhaseFour': 'phase_four.start',
  'orchestrator:routeTask2Design': 'phase_four.route_task2_design',
  'orchestrator:routeDevelopmentPlan': 'development.route_plan',
  'orchestrator:routeQaOutcome': 'development.route_qa_outcome',
  'quality_assurance:reviewUIVersion': 'ui_version.qa_review',
  'orchestrator:requestUIVersionAdminReview': 'ui_version.request_admin_review',
  'ui_prototype:build': 'prototype.build',
  'ui_prototype:reviseBuild': 'prototype.build_revise',
  'quality_assurance:reviewPrototypeBuild': 'prototype.qa_review',
  'projects:completePhaseFourOnPrototypeApproval': 'phase_four.complete',
  'projects:startPhaseFive': 'phase_five.start',
  'projects:recordM3Verified': 'm3.record_verified',
  'projects:startPhaseSix': 'phase_six.start',
  'projects:scheduleQaJobs': 'qa.schedule_jobs',
  'projects:reopenOnSourceChange': 'qa.reopen_on_source_change',
  'crm:announceTestingStarted': 'testing_started.announce',
  'crm:announceQaClarification': 'qa_clarification.announce',
  'crm:announceQaDefectProgress': 'qa_defect_progress.announce',
  'projects:recordM4Verified': 'm4.record_verified',
  'crm:announceReleaseCandidateApproved': 'release_candidate_approved.announce',
  'crm:announceReleaseCandidateReady': 'release_candidate_ready.announce',
  'crm:announceReleaseExceptionRequested': 'release_exception_requested.announce',
  'crm:announcePhaseEightStarted': 'phase_eight_started.announce',
  'crm:announceSupportTicketEscalated': 'support_ticket_escalated.announce',
  'crm:announceSupportSlaBreached': 'support_sla_breached.announce',
  'crm:announceRetentionRecoveryRequired': 'retention_recovery_required.announce',
  'crm:announceMaintenanceRenewalDue': 'maintenance_renewal_due.announce',
  'crm:announceMaintenanceWorkOpened': 'maintenance_work_opened.announce',
  'crm:announceMaintenanceQaFailed': 'maintenance_qa_failed.announce',
  'crm:announceMaintenanceReleaseRequested': 'maintenance_release_requested.announce',
  'crm:announceMaintenanceReleaseApproved': 'maintenance_release_approved.announce',
  'crm:announceMaintenanceReleased': 'maintenance_released.announce',
  'crm:announceMaintenanceBillingProposed': 'maintenance_billing_proposed.announce',
  'crm:announceMaintenanceSlaBreached': 'maintenance_sla_breached.announce',
  'crm:announceMaintenanceWorkStalled': 'maintenance_work_stalled.announce',
  'crm:announceQaReverification': 'qa_reverification.announce',
  'crm:announceM4PaymentVerified': 'm4_verified.announce',
  'crm:announceFinanciallyClosed': 'financially_closed.announce',
  'projects:validateQaIntake': 'phase_six.validate_intake',
  'crm:announcePhaseSixReady': 'phase_six_ready.announce',
  'crm:announceM3PaymentVerified': 'm3_verified.announce',
  'crm:announceBuildFeedbackRouted': 'build_feedback_routed.announce',
  'finance:generateM1Invoice': 'invoice.generate_m1',
  'finance:deliverIssuedInvoice': 'invoice.deliver',
  'finance:raiseFreeMaintenance': 'invoice.free_maintenance',
  'project_planning:draftBlueprint': 'planning.blueprint',
  'projects:askClarification': 'pm.clarify',
  'projects:readClarificationAnswer': 'pm.clarification_answer',
  'projects:welcomeClient': 'pm.welcome',
  'projects:askGstDetails': 'pm.gst_details',
  'projects:updateClientOnPayment': 'pm.payment_update',
  'projects:readBillingReply': 'pm.billing_reply',
  'finance:generateM2Invoice': 'invoice.generate_m2',
  'finance:generateM3Invoice': 'invoice.generate_m3',
  'finance:generateM4Invoice': 'invoice.generate_m4',
  'projects:openChangeRequestFromScopeEscalation': 'change_request.open_from_scope_escalation',
  'crm:announceApproval': 'approval.announce',
  'crm:announceEscalation': 'escalation.announce',
  'crm:acknowledgeHandover': 'handover.acknowledge',
  'crm:deliverFollowUp': 'followup.deliver',
  'support:triageTicket': 'maintenance.triage',
  'project_manager:planBreakdown': 'plan.breakdown',
  'ui_designer:designDirections': 'design.directions',
  'ui_designer:screenInventory': 'ui.inventory',
  'ui_designer:draftUIVersion': 'ui.version_draft',
  'ui_designer:reviseUIVersion': 'ui.version_revise',
  'project_manager:classifyClientFeedback': 'ui_version.classify_client_feedback',
  'project_manager:suggestBuildFeedbackClass': 'build_feedback.suggest_classification',
  'project_manager:readDesignReply': 'design.read_reply',
  'sales:readIntent': 'message.intent',
  'sales:readMeetingRequest': 'meeting.request_read',
  'sales:readLeadOutcome': 'lead.outcome_read',
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
  'sales:syncDiscountDecision': 'discount_decision.sync',
  'crm:announceOfferApplied': 'offer.announce',
  'crm:announceRevisionLimitEscalated': 'revision_limit.announce',
  'crm:announcePhaseThreeCompleted': 'phase_three_completed.announce',
  'crm:announcePhaseFourStarted': 'phase_four_started.announce',
  'crm:announceUiVersionAdminReviewed': 'ui_version_admin_reviewed.announce',
  'crm:announceUiVersionChangeRequested': 'ui_version_change_requested.announce',
  'crm:announceUiVersionLocked': 'ui_version_locked.announce',
  'crm:announcePrototypeSubmitted': 'prototype_submitted.announce',
  'crm:announcePrototypeChangeRequested': 'prototype_change_requested.announce',
  'crm:announceTask2Complete': 'task2_complete.announce',
  'crm:announceTask3Complete': 'task3_complete.announce',
  'crm:announcePhaseFiveStarted': 'phase_five_started.announce',
  'crm:announceBuildShared': 'build_shared.announce',
  'crm:announceBuildFeedbackReceived': 'build_feedback.announce',
  'crm:announceBuildApproved': 'build_approved.announce',
  'crm:announceBuildReadyForAdmin': 'build_ready_for_admin.announce',
  'crm:announceDevelopmentEscalated': 'development_escalated.announce',
  'crm:announceModuleCompleted': 'module_completed.announce',
  'crm:announceDevClarification': 'dev_clarification.announce',
  'crm:announceTask4Complete': 'task4_complete.announce',
  'crm:announceM2PaymentVerified': 'm2_payment_verified.announce',
  'crm:routeLead': 'lead.route',
  'crm:classifyLeadIdentity': 'lead.identity_classify',
  'projects:openPhaseSeven': 'phase_seven.open',
  'projects:runDeployment': 'phase_seven.run_deployment',
  'crm:announcePhaseSevenReady': 'phase_seven_ready.announce',
  'crm:announceDeploymentApproved': 'deployment_approved.announce',
  'crm:announceProductionValidated': 'production_validated.announce',
  'crm:announceProductionValidationFailed': 'production_validation_failed.announce',
  'crm:announceHandoverReady': 'handover_ready.announce',
  'crm:announceProjectCompleted': 'project_completed.announce',
  'projects:fillPhaseEightIntake': 'phase_eight_intake.fill',
  'projects:routePhaseSevenTask': 'phase_seven.route_task',
  'projects:openSupportTicketFromMessage': 'support_ticket.open_from_message',
  'projects:createDraftHandoverPackage': 'handover.create_draft',
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
  /** The chain this event belongs to, when something upstream set one. */
  correlation_id?: string | null;
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
  // `project.deliverable_submitted` / `_decided` fire for every deliverable kind: only a development build is these handlers' business. Like the
  // filters below, this decides only whether to SPEND a job; each handler re-checks the row itself.
  'projects:reopenOnSourceChange': (event) => (event.payload as { kind?: string } | null)?.kind === 'build',
  'crm:announceBuildShared': (event) => (event.payload as { kind?: string } | null)?.kind === 'build',
  'crm:announceBuildApproved': (event) => (event.payload as { kind?: string } | null)?.kind === 'build',
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
  // Business Phase 1-4 audit step 1.27: the same cheap filter, scoped to the
  // one subject type this handler carries a decision onto.
  'sales:syncDiscountDecision': (event) =>
    (event.payload as { subjectType?: string } | null)?.subjectType === 'discount_decision',
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
