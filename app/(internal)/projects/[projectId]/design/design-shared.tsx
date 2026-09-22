import type { Tone } from '@/ui';

/**
 * Shared across the four Design surfaces (Overview, Themes, Colors, Final
 * selection) — one copy of each label map and layout primitive, so splitting
 * the old single page across routes did not also split the vocabulary into
 * four copies that could drift.
 */

export const PHASE_TONE: Record<string, Tone> = {
  context_loading: 'info',
  screen_baseline: 'info',
  drafting: 'info',
  figma_sync: 'info',
  internal_review: 'info',
  admin_review: 'warning',
  client_review: 'warning',
  waiting_client: 'warning',
  revision: 'warning',
  final_confirmation: 'info',
  locked: 'success',
  completed: 'success',
  blocked_requirement: 'danger',
  scope_escalation: 'danger',
  revision_limit_escalation: 'danger',
};

export const GATE_TONE: Record<string, Tone> = {
  draft: 'neutral',
  not_submitted: 'neutral',
  not_shared: 'neutral',
  in_review: 'info',
  changes_required: 'danger',
  edit_requested: 'danger',
  change_requested: 'danger',
  passed: 'success',
  approved: 'success',
  shared: 'info',
  selected: 'success',
  locked: 'success',
};

export const DECISION_LABEL: Record<string, string> = {
  client_selected: 'Selected a direction',
  design_change_request: 'Asked for a change',
  client_reference: 'Sent a reference',
  possible_scope_change: 'Possible scope change',
  clarification_required: 'Unclear — needs clarification',
  final_confirmed: 'Confirmed the final direction',
};

export const ORIGIN_LABEL: Record<string, string> = {
  internal_review: 'Internal review',
  admin_edit: 'Admin edit',
  client_revision: 'Client',
};

export const when = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace('T', ' ');

export function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
      {hint ? <p className="max-w-2xl text-[13px] text-muted">{hint}</p> : null}
      {children}
    </section>
  );
}

export function Nothing({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-muted">{children}</p>;
}
