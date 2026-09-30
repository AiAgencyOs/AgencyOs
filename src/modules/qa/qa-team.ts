/**
 * The QA Team card — people whose PROJECT role is `qa`.
 *
 * The project roster (`projects.project_members.project_role`) is the only
 * statement of who tests what, so the card is built from it and from nothing
 * else: no presence ("Online") is claimed, because no session data is readable
 * here. One row per person, however many projects they test.
 */

export type QaTeamRow = { userId: string; fullName: string; projectId: string; projectName: string };
export type QaTeamMember = { userId: string; fullName: string; projects: { id: string; name: string }[] };

export function groupQaTeam(rows: readonly QaTeamRow[]): QaTeamMember[] {
  const byUser = new Map<string, QaTeamMember>();
  for (const r of rows) {
    const member = byUser.get(r.userId) ?? { userId: r.userId, fullName: r.fullName, projects: [] };
    if (!member.projects.some((p) => p.id === r.projectId)) member.projects.push({ id: r.projectId, name: r.projectName });
    byUser.set(r.userId, member);
  }
  return [...byUser.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}
