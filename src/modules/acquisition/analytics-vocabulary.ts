/** Client-safe words for the Performance tab. The numbers come from `crm.acquisition_*`; these are labels. */
export const FUNNEL_CHANNEL_LABEL: Record<string, string> = {
  meta_ads: 'Meta / Facebook Ads', email: 'Email outreach', social: 'Social', google_ads: 'Google Ads', b2b: 'B2B marketplaces', other: 'Everything else (WhatsApp, website, referral, import)',
};

export const WINDOWS = [{ days: 30, label: '30 days' }, { days: 90, label: '90 days' }, { days: 365, label: 'A year' }] as const;
export const DEFAULT_WINDOW = 90;
export const windowFrom = (raw: string | undefined): number => WINDOWS.find((w) => String(w.days) === raw)?.days ?? DEFAULT_WINDOW;

/** What a failure row's `kind` means, in words. Kinds with a suffix (execution_failed, connection_degraded, campaign_*) match by prefix. */
export function failureTitle(kind: string): string {
  if (kind.startsWith('campaign_')) return `Campaign problem: ${kind.slice('campaign_'.length).replaceAll('_', ' ')}`;
  const words: Record<string, string> = {
    execution_failed: 'An action failed', execution_unknown: 'An action may or may not have happened', execution_stalled: 'An action is stuck',
    approved_not_applied: 'Approved, but nobody has applied it', landing_not_verified: 'A landing page is not verified',
    connection_degraded: 'A connection is degraded', connection_revoked: 'A connection was revoked', subtask_failed: 'A hand-off task failed',
    worker_alert: 'An alert from a worker', channel_paused: 'A channel is paused', duplicate_reviews_open: 'Possible duplicate people',
  };
  return words[kind] ?? kind.replaceAll('_', ' ');
}

export const RECOMMENDATION_TITLE: Record<string, string> = {
  behind_pace_for_the_monthly_goal: 'Behind the pace for this month\'s goal',
  budget_nearly_used: 'The monthly budget is nearly used',
  cost_per_qualified_far_above_its_sibling: 'Costs far more per qualified lead than the other ad channel',
  acting_without_producing_a_lead_check_tracking: 'Acting, but producing no leads: check the tracking',
  too_early_to_judge: 'Too early to judge',
};

export function recommendationLine(recommendation: string, basis: Record<string, unknown>): string {
  const n = (k: string) => (basis[k] === undefined || basis[k] === null ? '?' : String(basis[k]));
  switch (recommendation) {
    case 'behind_pace_for_the_monthly_goal': return `${n('qualified_so_far')} qualified so far against a goal of ${n('target')}; at this pace the month ends at ${n('pace_pct')}% of it (day ${n('days_elapsed')}). Review the targeting or volume - nothing has been changed.`;
    case 'budget_nearly_used': return `${n('budget_used_pct')}% of the monthly budget is spent on day ${n('days_elapsed')} of ${n('days_in_month')}. Decide whether to pause or ask for a higher budget; the cap holds either way.`;
    case 'cost_per_qualified_far_above_its_sibling': return 'Its cost per qualified lead is more than twice the other ad channel\'s. Look at the audience and creative before changing the budget.';
    case 'acting_without_producing_a_lead_check_tracking': return `${n('actions')} actions in 30 days and ${n('leads')} leads. Check that the tracking reference and the WhatsApp handoff reach the CRM.`;
    case 'too_early_to_judge': return `Only ${n('leads')} lead${basis.leads === 1 ? '' : 's'} so far - too few to judge. Wait before changing anything.`;
    default: return recommendation.replaceAll('_', ' ');
  }
}

/** Money in minor units, kept in its own currency: a total across currencies would be a number that means nothing. */
export function revenueLine(revenue: Record<string, unknown> | null): string {
  const entries = Object.entries(revenue ?? {}).filter(([, v]) => typeof v === 'number');
  if (entries.length === 0) return '-';
  return entries.map(([cur, v]) => `${cur} ${((v as number) / 100).toLocaleString('en-IN')}`).join(' + ');
}
