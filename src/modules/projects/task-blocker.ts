/**
 * A blocked task says what it is blocked on, who has to act, and what happens
 * next (SCR-020, "Blocked state must capture blocker type, owner and next
 * action"). Pure: the vocabulary is the CHECK on `projects.tasks.blocker_type`
 * (migration 20261006200000), and `blockerProblem` is the one judge the service
 * and the forms share.
 */
export const BLOCKER_TYPES = ['client_answer', 'payment', 'dependency', 'decision', 'access', 'external_service', 'other'] as const;
export type BlockerType = (typeof BLOCKER_TYPES)[number];

export const BLOCKER_TYPE_LABEL: Record<BlockerType, string> = {
  client_answer: 'Waiting on the client',
  payment: 'Payment',
  dependency: 'Another task or deliverable',
  decision: 'A decision',
  access: 'Access or credentials',
  external_service: 'An outside service',
  other: 'Something else',
};

export type BlockerInput = { reason?: string | null; blockerType?: string | null; blockerOwner?: string | null; nextAction?: string | null };

/** Why a blocker cannot be recorded, in words, or null when it is complete. */
export function blockerProblem(input: BlockerInput): string | null {
  if (!input.reason?.trim()) return 'Say what the task is blocked on before marking it blocked.';
  if (!input.blockerType || !(BLOCKER_TYPES as readonly string[]).includes(input.blockerType)) return 'Pick what kind of blocker this is.';
  const owner = input.blockerOwner?.trim() ?? '';
  if (owner.length === 0) return 'Name who has to act to unblock it.';
  if (owner.length > 120) return 'The blocker’s owner is at most 120 characters.';
  const next = input.nextAction?.trim() ?? '';
  if (next.length === 0) return 'Say what the next action is.';
  if (next.length > 500) return 'The next action is at most 500 characters.';
  return null;
}
