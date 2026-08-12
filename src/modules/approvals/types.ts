import type { Database } from '@/lib/db/types';

type ApprovalRequestRow = Database['approvals']['Tables']['approval_requests']['Row'];
type ApprovalPolicyTableRow = Database['approvals']['Tables']['approval_policies']['Row'];

/**
 * A request as the queue and the decision page render it.
 *
 * `payload` is deliberately absent from the list shape: it is a snapshot of
 * whatever was being approved and can be arbitrarily large, so it is fetched
 * with the one request being looked at rather than with every row in a queue
 * of a hundred.
 *
 * Amounts stay in minor units all the way to the formatter, for the same
 * reason they do in finance — a float this far from the display layer is how
 * currency bugs start.
 */
export type ApprovalListItem = Pick<
  ApprovalRequestRow,
  | 'id'
  | 'subject_type'
  | 'subject_id'
  | 'state'
  | 'audience'
  | 'required_role'
  | 'summary'
  | 'amount_minor'
  | 'sla_due_at'
  | 'requested_by_type'
  | 'requested_by_id'
  | 'decided_at'
  | 'decided_by'
  | 'decision_note'
  | 'evidence_ref'
  | 'client_contact_id'
  | 'correlation_id'
  | 'created_at'
>;

/** The full row, including the snapshot of what was being approved. */
export type ApprovalDetail = ApprovalListItem & Pick<ApprovalRequestRow, 'payload' | 'policy_id' | 'escalated_from'>;

/** One rung of the policy ladder, as the owner would read it. */
export type ApprovalPolicyRow = Pick<
  ApprovalPolicyTableRow,
  | 'id'
  | 'subject_type'
  | 'min_amount_minor'
  | 'required_role'
  | 'sla_hours'
  | 'audience'
  | 'active'
  | 'note'
  | 'updated_at'
>;
