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
>;

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
