/**
 * What each unmet kickoff gate means — Master §5.10.
 *
 * §5.10's second line is *"create explicit blocker/owner for any missing
 * gate"*. The door returns machine names; these are the sentences a person
 * reads, and they live in their own module with no database and no
 * `server-only` so a surface, a test or a job can all use the same words.
 *
 * Two of these names come from `projects.start_readiness` rather than from the
 * Phase 2 gate — ADM-13's conditions are not §5.10's, so a project can pass
 * the kickoff gate and still be refused ACTIVE. That difference is surfaced
 * rather than hidden, which is why their sentences are here too.
 */
export const KICKOFF_BLOCKERS: Record<string, string> = {
  onboarding_incomplete: 'The onboarding checklist still has open items.',
  whatsapp_group_not_mapped: 'The WhatsApp group has not been created and mapped yet.',
  advance_not_verified: 'The advance payment has not been verified by an Admin.',
  no_active_plan: 'There is no live operational plan for this project.',
  // From start_readiness (ADM-13), reachable through `project_would_not_start`.
  no_approved_requirement: 'No requirement version has been accepted for this deal.',
  no_whatsapp_group: 'No WhatsApp group is linked to this project.',
};

/** The gaps as sentences, falling back to the raw name rather than dropping it. */
export function describeBlockers(unmet: readonly string[]): string[] {
  return unmet.map((name) => KICKOFF_BLOCKERS[name] ?? name);
}
