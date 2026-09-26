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
  'projects:startPhaseFour',
  'orchestrator:routeTask2Design',
  'quality_assurance:reviewUIVersion',
  'orchestrator:requestUIVersionAdminReview',
  'ui_prototype:build',
  'quality_assurance:reviewPrototypeBuild',
  'projects:completePhaseFourOnPrototypeApproval',
  'finance:generateM1Invoice',
  'finance:generateM2Invoice',
  'projects:openChangeRequestFromScopeEscalation',
  'crm:announceApproval',
  'crm:announceEscalation',
  'crm:deliverFollowUp',
  'support:triageTicket',
  'project_manager:planBreakdown',
  'ui_designer:designDirections',
  'ui_designer:screenInventory',
  'ui_designer:draftUIVersion',
  'ui_designer:reviseUIVersion',
  'sales:readIntent',
  'sales:readMeetingRequest',
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
  'crm:announceRevisionLimitEscalated',
  'crm:announcePhaseThreeCompleted',
  'crm:announcePhaseFourStarted',
  'crm:announceUiVersionAdminReviewed',
  'crm:announceUiVersionChangeRequested',
  'crm:announceUiVersionLocked',
  'crm:announcePrototypeSubmitted',
  'crm:announcePrototypeChangeRequested',
  'crm:announceTask2Complete',
  'crm:announceM2PaymentVerified',
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
  'invoice.paid': ['projects:unlockNextMilestone', 'crm:announceM2PaymentVerified'],
  /**
   * Phase 2 Master Flow §5.1 — the receiver PH1-CLS-002 said would arrive.
   *
   * Not `opportunity.handed_off`, which fires at the WIN with no project:
   * conversion is a separate human act that may come hours later or never,
   * and Master §5.3's workspace IS the project. So Phase 2 starts at the
   * BINDING, which `ai.handoffs` now emits for itself.
   */
  'project.handoff_bound': ['projects:startPhaseTwo'],
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
  /**
   * Phase 2 Master Flow §5–§6 — GST/Non-GST confirmation → Finance Agent →
   * M1 invoice, as one automated step rather than a person opening the
   * project page. `finance.confirm_billing_mode` emits this once the profile
   * is complete; the handler re-checks completeness itself rather than
   * trusting the payload, and skips quietly for a project whose payment plan
   * was configured by hand instead of the locked structure.
   */
  'project.billing_mode_confirmed': ['finance:generateM1Invoice'],
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
  'message.received': ['sales:readIntent', 'sales:readQualification', 'sales:summariseThread', 'sales:readMeetingRequest'],
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
  'project.ui_version_qa_reviewed': ['orchestrator:requestUIVersionAdminReview'],
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
   * inside the handler.
   */
  'project.ui_version_admin_reviewed': ['crm:announceUiVersionAdminReviewed'],
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
  'project.ui_version_client_decided': ['crm:announceUiVersionChangeRequested', 'ui_designer:reviseUIVersion'],
  /**
   * QAP §7 — Prototype QA, decided by quality_assurance, never by
   * ui_prototype whose build it reviews (ADM-82). Off the fact
   * `record_prototype_build` already emits.
   */
  'project.prototype_build_ready': ['quality_assurance:reviewPrototypeBuild'],
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
  ],
  /**
   * PM4-M05, Impl §8 — off the same event `submit_deliverable` (any kind)
   * always emitted starting `20260923160000_m2_and_the_gate_it_actually_
   * needs.sql`; the handler filters to `kind = 'prototype'` itself.
   */
  'project.deliverable_submitted': ['crm:announcePrototypeSubmitted'],
  /**
   * Finance §2, §5 — the M2 (20%) invoice, off the fact
   * `projects.complete_phase_four` already emits. PM4-M07 (Task 2 Complete)
   * fans out from the same event, independent of the invoicing chain.
   */
  'project.phase_four_completed': ['finance:generateM2Invoice', 'crm:announceTask2Complete'],
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
  'projects:startPhaseFour': 'phase_four.start',
  'orchestrator:routeTask2Design': 'phase_four.route_task2_design',
  'quality_assurance:reviewUIVersion': 'ui_version.qa_review',
  'orchestrator:requestUIVersionAdminReview': 'ui_version.request_admin_review',
  'ui_prototype:build': 'prototype.build',
  'quality_assurance:reviewPrototypeBuild': 'prototype.qa_review',
  'projects:completePhaseFourOnPrototypeApproval': 'phase_four.complete',
  'finance:generateM1Invoice': 'invoice.generate_m1',
  'finance:generateM2Invoice': 'invoice.generate_m2',
  'projects:openChangeRequestFromScopeEscalation': 'change_request.open_from_scope_escalation',
  'crm:announceApproval': 'approval.announce',
  'crm:announceEscalation': 'escalation.announce',
  'crm:deliverFollowUp': 'followup.deliver',
  'support:triageTicket': 'maintenance.triage',
  'project_manager:planBreakdown': 'plan.breakdown',
  'ui_designer:designDirections': 'design.directions',
  'ui_designer:screenInventory': 'ui.inventory',
  'ui_designer:draftUIVersion': 'ui.version_draft',
  'ui_designer:reviseUIVersion': 'ui.version_revise',
  'sales:readIntent': 'message.intent',
  'sales:readMeetingRequest': 'meeting.request_read',
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
  'crm:announceRevisionLimitEscalated': 'revision_limit.announce',
  'crm:announcePhaseThreeCompleted': 'phase_three_completed.announce',
  'crm:announcePhaseFourStarted': 'phase_four_started.announce',
  'crm:announceUiVersionAdminReviewed': 'ui_version_admin_reviewed.announce',
  'crm:announceUiVersionChangeRequested': 'ui_version_change_requested.announce',
  'crm:announceUiVersionLocked': 'ui_version_locked.announce',
  'crm:announcePrototypeSubmitted': 'prototype_submitted.announce',
  'crm:announcePrototypeChangeRequested': 'prototype_change_requested.announce',
  'crm:announceTask2Complete': 'task2_complete.announce',
  'crm:announceM2PaymentVerified': 'm2_payment_verified.announce',
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
