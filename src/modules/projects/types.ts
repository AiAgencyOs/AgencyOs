import type { Database } from '@/lib/db/types';

type ProjectRow = Database['projects']['Tables']['projects']['Row'];
type MilestoneRow = Database['projects']['Tables']['milestones']['Row'];

export type ProjectListItem = Pick<
  ProjectRow,
  'id' | 'name' | 'code' | 'status' | 'currency' | 'budget_minor' | 'created_at'
>;

export type ProjectDetail = ProjectListItem &
  Pick<
    ProjectRow,
    | 'description'
    | 'client_account_id'
    | 'opportunity_id'
    // G-114: the accepted quotation, whose absence ADM-72 requires to be visible.
    | 'proposal_id'
    | 'starts_on'
    | 'ends_on'
    | 'visibility'
    | 'delivery_lead_id'
    // SCR-018: why it was last paused, resumed or cancelled, and when.
    | 'status_reason'
    | 'status_changed_at'
    // SCR-018/027 (20261001120000): the archive mark, and the template followed.
    | 'archived_at'
    | 'template_id'
  >;

/** A milestone as the payment plan renders it. */
export type PaymentPlanMilestone = Pick<
  MilestoneRow,
  'id' | 'name' | 'position' | 'status' | 'payment_percent' | 'amount_minor' | 'currency' | 'due_on' | 'met_at'
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

/**
 * One row of Doc 12 §9's screen coverage matrix.
 *
 * `blocking` separates the three conditions Doc 12 §20 states exactly — every
 * included scope item has a screen, every screen maps to scope, and nothing
 * excluded is designed — from the ones that are judgement nobody has
 * configured. The database refuses the first three and reports the rest.
 */
export type UiCoverageFlag = {
  flag: string;
  blocking: boolean;
  subject_id: string;
  subject: string;
};

/**
 * One project's row on the org-wide Design & Prototype index (SCR-032 at
 * portfolio level): where Phase 3 stands, how many revisions the client has
 * used, and how many design/prototype deliverables sit at each status.
 */
export type DesignPortfolioRow = ProjectListItem & {
  phaseThreeState: string | null;
  reviewerAssigned: boolean;
  clientRevisionsUsed: number;
  clientRevisionLimit: number | null;
  designs: { total: number; inReview: number; approved: number };
  prototypes: { total: number; inReview: number; approved: number };
  designUpdatedAt: string | null;
};

/**
 * One project's row on the org-wide Development index (SCR-039 at
 * portfolio level): module and task counts by state, plus the latest build.
 */
export type DevelopmentPortfolioRow = ProjectListItem & {
  modules: { total: number; done: number };
  tasks: { total: number; todo: number; inProgress: number; blocked: number; inReview: number; done: number };
  builds: { total: number; latestStatus: string | null; latestVersion: number | null };
};
