import type { Database } from '@/lib/db/types';

type OpportunityRow = Database['sales']['Tables']['opportunities']['Row'];
type ProposalRow = Database['sales']['Tables']['proposals']['Row'];
type ProposalItemRow = Database['sales']['Tables']['proposal_items']['Row'];

export type ProposalListItem = Pick<
  ProposalRow,
  | 'id'
  | 'opportunity_id'
  | 'version'
  | 'title'
  | 'status'
  | 'currency'
  | 'subtotal_minor'
  | 'discount_minor'
  | 'tax_minor'
  | 'total_minor'
  | 'valid_until'
  | 'approval_request_id'
  | 'sent_at'
  | 'decided_at'
  | 'created_at'
  // A member of a plan-set is an ordinary proposal with three extra facts
  // (G-166, ADM-97). Carried on the list item so the panel can group the
  // ladder and show each rung's name rather than its version number.
  | 'plan_set_id'
  | 'plan_slot'
  | 'plan_label'
>;

/**
 * The 2-3 plan offer above the proposals — G-166, ADM-97; G-305.
 *
 * Read as one row plus its members, because every control on the panel needs
 * both: the set carries the status the whole ladder moves in, and the members
 * carry the prices somebody is comparing.
 */
/**
 * One row of the cross-deal quotations list (SCR-011) — a `ProposalListItem`
 * with just enough of its parent opportunity/lead to be findable without
 * opening it first.
 */
export type ProposalListRow = ProposalListItem & {
  opportunityName: string;
  leadId: string;
  leadTitle: string;
};

export type PlanSetView = {
  id: string;
  status: string;
  recommendedProposalId: string | null;
  chosenProposalId: string | null;
  sentAt: string | null;
  decidedAt: string | null;
  members: ProposalListItem[];
};

export type ProposalItem = Pick<
  ProposalItemRow,
  'id' | 'position' | 'description' | 'quantity' | 'unit_price_minor' | 'amount_minor'
>;

/** A quotation with the lines behind its total — what a page needs to show one. */
export type ProposalDetail = ProposalListItem & {
  body: string | null;
  items: ProposalItem[];
};

export type OpportunityListItem = Pick<
  OpportunityRow,
  | 'id'
  | 'name'
  | 'stage'
  | 'currency'
  | 'value_minor'
  | 'lead_id'
  | 'client_account_id'
  | 'expected_close_on'
  | 'created_at'
>;
