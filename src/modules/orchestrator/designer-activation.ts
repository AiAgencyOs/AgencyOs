/**
 * UI Designer conditional activation — Phase 4 UI Designer spec, "VALID ACTIVATION CONDITIONS" A–G and
 * "DESIGNER MUST NOT ACTIVATE FOR".
 *
 * The Designer is not permanently active. Every activation names ONE of seven valid reasons, and a request
 * that names anything else — a prototype code bug, a backend problem, a payment issue, a delivery failure, an ambiguous
 * business rule, an unapproved feature, a replayed event, a Phase 5 coding task — is refused, never guessed at.
 * Pure: no server-only imports, so the routing handler, the revise workflow and the tests all share one rule.
 */

export const DESIGNER_ACTIVATION_REASONS = [
  'initial_phase_four', // A. Phase 4 starts with a valid Phase 3 baseline: create the complete UI
  'missing_approved_ui', // B. the coverage engine confirms a required approved screen/state is missing
  'design_qa_defect', // C. Design QA returned CHANGES_REQUIRED: fix the exact defect
  'admin_edit', // D. Admin returned EDIT
  'client_visual_revision', // E. an allowed visual revision, classified by the PM first
  'approved_scope_change', // F. an approved Change Request reached the UI workflow
  'source_ui_design_defect', // G. the prototype stage proved the approved SOURCE UI itself is defective
] as const;
export type DesignerActivationReason = (typeof DESIGNER_ACTIVATION_REASONS)[number];

/** What must NOT wake the Designer. Each one belongs to another owner. */
export const DESIGNER_REFUSED_TRIGGERS = [
  'prototype_code_bug',
  'backend_api_problem',
  'payment_issue',
  'communication_delivery_issue',
  'ambiguous_business_rule',
  'unapproved_new_feature',
  'duplicate_or_replayed_event',
  'production_logic_problem',
  'phase_five_coding_task',
] as const;
export type DesignerRefusedTrigger = (typeof DESIGNER_REFUSED_TRIGGERS)[number];

export type DesignerActivation =
  | { activate: true; reason: DesignerActivationReason }
  | { activate: false; refusedBecause: string; routeTo: string };

/** Where each refused trigger goes instead. An ambiguous rule is clarified, not guessed: INTERNAL → PM → CLIENT → PM → the original workflow. */
const OWNER: Record<DesignerRefusedTrigger, string> = {
  prototype_code_bug: 'Prototype Agent fixes it',
  backend_api_problem: 'backend / Phase 5 owner',
  payment_issue: 'Finance',
  communication_delivery_issue: 'PM communication retry (never repeats the business transition)',
  ambiguous_business_rule: 'PM clarification: internal → PM → client → PM → the original workflow',
  unapproved_new_feature: 'Requirements / scope Change Request; the Designer activates only after it is approved (reason F)',
  duplicate_or_replayed_event: 'nothing: the existing result is returned',
  production_logic_problem: 'Phase 5 development',
  phase_five_coding_task: 'Phase 5 development',
};

export function decideDesignerActivation(trigger: string): DesignerActivation {
  if ((DESIGNER_ACTIVATION_REASONS as readonly string[]).includes(trigger)) {
    return { activate: true, reason: trigger as DesignerActivationReason };
  }
  if ((DESIGNER_REFUSED_TRIGGERS as readonly string[]).includes(trigger)) {
    return { activate: false, refusedBecause: `${trigger} is not a design condition`, routeTo: OWNER[trigger as DesignerRefusedTrigger] };
  }
  // An unknown trigger is refused too: a model or a caller does not get to invent a seventh reason.
  return { activate: false, refusedBecause: `${trigger} is not one of the valid activation conditions`, routeTo: 'PM, to classify it' };
}

/** The activation reason a revision round carries, from the state the prior version was left in. */
export function reasonForPriorStatus(status: string): DesignerActivationReason | null {
  switch (status) {
    case 'qa_changes_required':
      return 'design_qa_defect';
    case 'admin_edit':
      return 'admin_edit';
    case 'client_change':
      return 'client_visual_revision';
    default:
      return null;
  }
}
