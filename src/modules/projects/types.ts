import type { Database } from '@/lib/db/types';

type ProjectRow = Database['projects']['Tables']['projects']['Row'];
type MilestoneRow = Database['projects']['Tables']['milestones']['Row'];

export type ProjectListItem = Pick<
  ProjectRow,
  'id' | 'name' | 'code' | 'status' | 'currency' | 'budget_minor' | 'created_at'
>;

export type ProjectDetail = ProjectListItem &
  Pick<ProjectRow, 'description' | 'client_account_id' | 'opportunity_id' | 'starts_on' | 'ends_on'>;

/** A milestone as the payment plan renders it. */
export type PaymentPlanMilestone = Pick<
  MilestoneRow,
  'id' | 'name' | 'position' | 'status' | 'payment_percent' | 'amount_minor' | 'currency' | 'due_on'
>;

/**
 * A milestone with the project context another module needs to bill it.
 *
 * Flattened rather than nested because the consumer (finance) cares about one
 * question — who is being billed, for how much, in which currency — and should
 * not have to know how delivery models a project to answer it.
 *
 * `amountMinor` and `currency` are copied from the milestone, which is the
 * authority on both. Nothing downstream recomputes them from the percentage.
 */
export type BillableMilestone = {
  milestoneId: string;
  organizationId: string;
  projectId: string;
  clientAccountId: string;
  name: string;
  description: string | null;
  position: number;
  status: string;
  paymentPercent: number | null;
  amountMinor: number;
  currency: string;
  dueOn: string | null;
  projectName: string;
  projectStatus: string;
};

/** Just enough of a milestone to reason about billing order. */
export type MilestoneBillingSummary = Pick<
  MilestoneRow,
  'id' | 'name' | 'position' | 'payment_percent' | 'amount_minor' | 'currency'
>;

type DeliverableTableRow = Database['projects']['Tables']['deliverables']['Row'];

/** One version of something shown to the client. */
export type DeliverableRow = Pick<
  DeliverableTableRow,
  | 'id'
  | 'kind'
  | 'version'
  | 'title'
  | 'artifact_url'
  | 'changelog'
  | 'known_issues'
  | 'status'
  | 'approval_request_id'
  | 'created_at'
>;

/** Directive §23's end-of-project summary. Every figure a read, none a gate. */
export type CompletionSummary = {
  project_id: string;
  name: string;
  status: string;
  budget_minor: number | null;
  invoiced_minor: number;
  paid_minor: number;
  outstanding_minor: number;
  started_at: string;
  completed_at: string | null;
  duration_days: number | null;
  milestones_total: number;
  milestones_met: number;
  deliverables: number;
  revisions: number;
  final_version: string | null;
  defects_total: number;
  defects_open: number;
  handover_status: string | null;
};

type OnboardingItemRow = Database['projects']['Tables']['onboarding_items']['Row'];

/** One line of Document 10 §6's checklist (G-017). */
export type OnboardingItem = Pick<
  OnboardingItemRow,
  'id' | 'position' | 'key' | 'label' | 'status' | 'note' | 'completed_at' | 'completed_by'
>;
