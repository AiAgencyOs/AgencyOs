/**
 * Pairing a privileged change with the reason its author gave.
 *
 * The three membership doors (`core.set_membership_status`,
 * `core.grant_secondary_role`, `core.revoke_secondary_role`) audit the change
 * itself — who, what, before and after — but take no reason. The server action
 * in front of them therefore appends a second entry, `membership.change_reason`,
 * naming the same membership, the same author and which kind of change it
 * explains. This pairs them: a change takes the EARLIEST reason of its kind,
 * by the same author, for the same membership, recorded at or after it and
 * before the next change of that kind to that membership. A change with none
 * is left without one — the list says "No reason recorded", never a guess.
 */

export const CHANGE_REASON_ACTION = 'membership.change_reason';

type Row = {
  id: number;
  action: string;
  subjectId: string | null;
  actorId: string | null;
  createdAt: string;
  after: Record<string, unknown> | null;
};

/** The short kind a reason entry names: `status_changed`, `secondary_role_granted`, `secondary_role_revoked`. */
export function changeKind(action: string): string {
  return action.replace(/^membership\./, '');
}

export function attachReasons<T extends Row>(changes: readonly T[], reasons: readonly Row[]): Map<number, string> {
  const byChange = new Map<number, string>();
  const time = (r: Row) => Date.parse(r.createdAt);
  const candidates = reasons
    .filter((r) => r.action === CHANGE_REASON_ACTION && typeof r.after?.reason === 'string' && (r.after.reason as string).trim() !== '')
    .sort((a, b) => time(a) - time(b) || a.id - b.id);
  const used = new Set<number>();

  for (const change of [...changes].sort((a, b) => time(a) - time(b) || a.id - b.id)) {
    const kind = changeKind(change.action);
    const nextChange = changes
      .filter((c) => c.id !== change.id && c.subjectId === change.subjectId && c.action === change.action && (time(c) > time(change) || (time(c) === time(change) && c.id > change.id)))
      .sort((a, b) => time(a) - time(b) || a.id - b.id)[0];
    const match = candidates.find(
      (r) =>
        !used.has(r.id) &&
        r.subjectId === change.subjectId &&
        r.actorId === change.actorId &&
        r.after?.kind === kind &&
        (time(r) > time(change) || (time(r) === time(change) && r.id > change.id)) &&
        (!nextChange || time(r) < time(nextChange) || (time(r) === time(nextChange) && r.id < nextChange.id)),
    );
    if (match) {
      used.add(match.id);
      byChange.set(change.id, String(match.after?.reason).trim());
    }
  }
  return byChange;
}
