import { SUBSCRIPTIONS } from './catalog';

/**
 * P4-INFRA-04 — the spec-name → real-event-name mapping.
 *
 * Impl §8 and ORCH §19 name ten-plus Phase 4 events (`UIDesignReady`,
 * `M2PaymentVerified`, and so on) that do not exist as literal strings
 * anywhere in this codebase, and never will: `src/lib/events/catalog.ts`'s
 * own rule is "only list what's real" — a producer/consumer pair this
 * codebase actually has, under the name its own migrations gave it. Renaming
 * a real, already-firing event string to match a spec's vocabulary would be
 * a breaking, migration-adjacent change (every producer, every `HANDLERS`
 * entry, every `core.event_types` row, and every already-recorded
 * `core.outbox_events` row would need to agree on the new name at once) for
 * a purely cosmetic win. This module is the alternative: a small, explicit,
 * testable table saying which real event answers each spec name, so a
 * reader (or an Orchestrator implementation) who starts from the spec's
 * vocabulary has one place to translate it, instead of grepping the catalog
 * and guessing.
 *
 * ── what "documented" means here ──────────────────────────────────────────
 *
 * Most rows point at an event that is both a real `core.emit_event` producer
 * AND a key of `catalog.ts`'s `SUBSCRIPTIONS` (i.e. it has at least one
 * consumer wired through the job runner). `documentedInCatalog: true` means
 * exactly that, and the drift guard below re-proves it on every test run.
 *
 * One row (`PrototypeQAPassed`) is the honest exception: the underlying
 * event (`project.prototype_qa_reviewed`) is a real producer —
 * `projects.record_prototype_qa_verdict`, migration
 * `20260928100000_a_ui_version_moves_only_where_the_doors_lead.sql` — but has
 * never been given a `SUBSCRIPTIONS` entry, the same "producer with nobody
 * listening" shape `project.phase_four_ready` was in before
 * `20260923100000` gave it one. `documentedInCatalog: false` says so plainly
 * rather than silently mapping to a name the catalog does not actually
 * carry — this is a genuine, separate gap (worth its own follow-up), not
 * something this mapping module should paper over.
 *
 * ── several rows share one real event on purpose ──────────────────────────
 *
 * The specs describe finer-grained events than the schema currently fires.
 * `AdminUIApproved` and the `admin_edit` branch of the same decision are one
 * event (`project.ui_version_admin_reviewed`) whose payload's `decision`
 * field is what a consumer actually branches on — see
 * `crm:announceUiVersionAdminReviewed`/`ui_designer:reviseUIVersion`'s
 * docblocks in `catalog.ts`. Likewise `AdminPrototypeApproved` and
 * `ClientPrototypeApproved` both resolve to `project.deliverable_decided`:
 * unlike the UI version stage, the prototype stage's deliverable does not
 * (yet) have a distinct two-step Admin-then-Client review — it has one
 * generic decision event shared by every `deliverables.kind`, filtered by
 * each consumer to `kind = 'prototype'` and the outcome it cares about. That
 * is a real, load-bearing difference in shape between the two stages, not a
 * numbering error in this table.
 */
export type Phase4EventMapEntry = {
  /** The literal name Impl §8 / ORCH §19 use. */
  readonly specName: string;
  /** Which spec section named it. */
  readonly sourceDoc: string;
  /** The real `core.emit_event` type string this codebase actually fires, or null if none exists at all yet. */
  readonly realEventName: string | null;
  /** True when `realEventName` is a key of `catalog.ts`'s `SUBSCRIPTIONS` (has a real consumer). */
  readonly documentedInCatalog: boolean;
  /** Why the mapping is what it is — especially where it is not 1:1. */
  readonly note: string;
};

export const PHASE_FOUR_EVENT_MAP: readonly Phase4EventMapEntry[] = [
  {
    specName: 'UIDesignReady',
    sourceDoc: 'Impl §8; UID §19',
    realEventName: 'project.ui_version_drafted',
    documentedInCatalog: true,
    note: 'Fired by projects.record_ui_version_draft the moment a draft exists; consumed by quality_assurance:reviewUIVersion (Design QA), which is the "ready for review" moment the spec names.',
  },
  {
    specName: 'UIDesignQAPassed',
    sourceDoc: 'Impl §8; QAP §7',
    realEventName: 'project.ui_version_qa_reviewed',
    documentedInCatalog: true,
    note: 'Fires for EVERY verdict, qa_changes_required included, not only a pass — the consumer (orchestrator:requestUIVersionAdminReview) reads the row, not the event name, to decide whether admin review is actually raised. The event name is broader than the spec name; there is no separate pass-only event.',
  },
  {
    specName: 'AdminUIApproved',
    sourceDoc: 'Impl §8; UID §19',
    realEventName: 'project.ui_version_admin_reviewed',
    documentedInCatalog: true,
    note: "Fires for both admin outcomes (admin_approved and admin_edit); crm:announceUiVersionAdminReviewed filters to admin_approved and ui_designer:reviseUIVersion filters to admin_edit, each reading sync_ui_version_decision's row rather than trusting the event name.",
  },
  {
    specName: 'ClientUIApproved',
    sourceDoc: 'Impl §8; UID §19',
    realEventName: 'project.ui_version_client_decided',
    documentedInCatalog: true,
    note: 'Fires for both client outcomes (change_requested and final_confirmed). The actual lock (UID §19\'s "LOCK") is a separate, later event — project.ui_version_locked — fired by lock_ui_version once the client-approved version is actually frozen.',
  },
  {
    specName: 'PrototypeBuildReady',
    sourceDoc: 'Impl §8; PROTO §4',
    realEventName: 'project.prototype_build_ready',
    documentedInCatalog: true,
    note: 'Fired by record_prototype_build; consumed by quality_assurance:reviewPrototypeBuild (Prototype QA).',
  },
  {
    specName: 'PrototypeQAPassed',
    sourceDoc: 'Impl §8; QAP §7',
    realEventName: 'project.prototype_qa_reviewed',
    documentedInCatalog: false,
    note: 'Genuine gap, not a naming difference: projects.record_prototype_qa_verdict emits this event (20260928100000_a_ui_version_moves_only_where_the_doors_lead.sql) but catalog.ts has never given it a SUBSCRIPTIONS entry, so nothing consumes it today. The human "submit for review" click on the existing prototype Admin Panel page remains the real next gate, informed by the stored qa_findings the event carries but does not itself route anywhere yet.',
  },
  {
    specName: 'AdminPrototypeApproved',
    sourceDoc: 'Impl §8; PROTO §13',
    realEventName: 'project.deliverable_decided',
    documentedInCatalog: true,
    note: "Shared with ClientPrototypeApproved below: the prototype stage reuses projects.deliverables' single generic decision event (any kind, any decider) rather than a UI-version-style two-step Admin-then-Client review. Each consumer filters to kind = 'prototype' and the decision/status it cares about.",
  },
  {
    specName: 'ClientPrototypeApproved',
    sourceDoc: 'Impl §8; PROTO §13',
    realEventName: 'project.deliverable_decided',
    documentedInCatalog: true,
    note: "Same real event as AdminPrototypeApproved — see that row's note. projects:completePhaseFourOnPrototypeApproval filters to kind = 'prototype' and status = 'approved' specifically, which is the moment PROTO §13's 'ClientPrototypeApproved' names.",
  },
  {
    specName: 'Phase4Completed',
    sourceDoc: 'Impl §8; FIN §5',
    realEventName: 'project.phase_four_completed',
    documentedInCatalog: true,
    note: 'Fired by projects.complete_phase_four once the final prototype is client-approved; consumed by finance:generateM2Invoice and crm:announceTask2Complete.',
  },
  {
    specName: 'M2PaymentVerified',
    sourceDoc: 'Impl §8; FIN §12-17',
    realEventName: 'invoice.paid',
    documentedInCatalog: true,
    note: "No M2-specific event string exists, deliberately: invoice.paid already fires for any milestone position once finance.verify_payment_submission (a real, human-only Admin action) marks it paid. crm:announceM2PaymentVerified re-reads the milestone row and filters to position = 2 itself, rather than trusting a payload claim — see that handler's docblock in crm/handlers.ts.",
  },
];

/** Convenience lookup, matching `definitionFor`'s shape in the agent registry. */
export function phase4EventFor(specName: string): Phase4EventMapEntry | null {
  return PHASE_FOUR_EVENT_MAP.find((e) => e.specName === specName) ?? null;
}

/**
 * True when `realEventName` is a key `catalog.ts` currently knows about
 * (i.e. has at least one subscriber for). Exported so the drift-guard test
 * can assert it without duplicating the `SUBSCRIPTIONS` lookup, and so a
 * future caller can ask the same question at runtime.
 */
export function isEventLiveInCatalog(realEventName: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUBSCRIPTIONS, realEventName);
}
