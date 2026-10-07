/** Pure presentation for the Phase 9B screens. No figure is computed here. */

export const LIFECYCLE_STATES = ['not_invoiced', 'invoiced', 'partially_verified', 'fully_verified', 'waived', 'refunded', 'overdue', 'disputed'] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export function lifecycleLabel(state: string): string {
  switch (state) {
    case 'not_invoiced': return 'Not invoiced';
    case 'invoiced': return 'Invoiced';
    case 'partially_verified': return 'Partly verified';
    case 'fully_verified': return 'Fully verified';
    case 'waived': return 'Waived';
    case 'refunded': return 'Refunded';
    case 'overdue': return 'Overdue';
    case 'disputed': return 'Disputed';
    default: return state.replace(/_/g, ' ');
  }
}

export function lifecycleTone(state: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (state === 'fully_verified') return 'success';
  if (state === 'overdue' || state === 'disputed') return 'danger';
  if (state === 'partially_verified' || state === 'refunded' || state === 'waived') return 'warning';
  return 'neutral';
}

export function cadenceSentence(unit: string, count: number): string {
  return count === 1 ? `every ${unit}` : `every ${count} ${unit}s`;
}
