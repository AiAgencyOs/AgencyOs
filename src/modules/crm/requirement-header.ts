/**
 * The two header facts SCR-007 asks Lead 360 to show beside the identity:
 * "Requirement version status" and "Human-handoff state". Both are read from
 * rows the page already holds; neither is typed or guessed.
 *
 * Pure, so the wording is tested with real inputs and the page only places it.
 */

export type RequirementVersionBrief = {
  version: number;
  status: string;
  sent_for_confirmation_at: string | null;
};

const STATUS_WORD: Record<string, string> = {
  proposed: 'Proposed, awaiting a decision',
  accepted: 'Accepted',
  rejected: 'Rejected',
  superseded: 'Superseded',
  failed: 'Extraction failed',
};

/** "v3 · Accepted, client-confirmed" — the newest version, said in one line. */
export function requirementHeaderValue(versions: readonly RequirementVersionBrief[]): string {
  if (versions.length === 0) return 'No version yet';
  const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
  const word = STATUS_WORD[latest.status] ?? latest.status.replace(/_/g, ' ');
  if (latest.status === 'accepted') {
    return `v${latest.version} · ${word}${latest.sent_for_confirmation_at ? ', client-confirmed' : ', not yet shown to the client'}`;
  }
  return `v${latest.version} · ${word}`;
}

/** Who is answering this thread: the agent, or a person who took it over. */
export function handoffHeaderValue(conversation: { agent_paused_at: string | null } | null): string | null {
  if (!conversation) return null;
  return conversation.agent_paused_at ? 'With a person — agent paused' : 'Agent replying';
}
