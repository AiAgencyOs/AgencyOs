/**
 * Where a conversation row opens. A direct thread lives on its lead; a
 * project group on its project's Communication tab; an internal group has no
 * page of its own, so the row is not a link (null) rather than `/leads/null`.
 */
export function conversationHref(c: { leadId: string | null; projectId: string | null }): string | null {
  if (c.leadId) return `/leads/${c.leadId}`;
  if (c.projectId) return `/projects/${c.projectId}/communication`;
  return null;
}
