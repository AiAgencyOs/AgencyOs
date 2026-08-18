/**
 * Safe matching — pure, format-independent, and deliberately conservative.
 *
 * Given import candidates (people observed in an export, already normalized) and
 * the existing AgencyOS contacts, it classifies each candidate into exactly one
 * bucket and says whether it may be imported WITHOUT a human. The load-bearing
 * rule: only a **phone** decides identity automatically. A phone is a reliable
 * key; a display name is not (two people share a name; a name is not an
 * identity), so any name-based match is `probable` at best and NEVER
 * auto-importable — it goes to manual review. Nothing here reads or writes
 * consent, and nothing here writes to a database; it decides, a human confirms,
 * and a separate committer acts under RLS.
 */

export type ImportCandidate = {
  /** E.164 iff resolvable — the only key that auto-decides identity. */
  phone: string | null;
  displayName: string;
  /** Provenance: which export file this person was observed in. */
  sourceLabel: string;
  messageCount: number;
};

export type ExistingContact = {
  id: string;
  /** E.164 iff stored — compared exactly. */
  phone: string | null;
  fullName: string | null;
};

export type MatchClass = 'exact' | 'new' | 'probable' | 'conflict' | 'unmatched';

export type MatchResult = {
  candidate: ImportCandidate;
  classification: MatchClass;
  /** Existing contact ids this candidate resolved to (0, 1, or many). */
  matchedContactIds: string[];
  reason: string;
  /**
   * True ONLY for a clean phone decision: an `exact` phone match (update) or a
   * `new` phone-keyed record (create). Everything name-based is false — a human
   * reviews it. This is the one gate the committer trusts.
   */
  autoImportable: boolean;
};

function normName(s: string | null): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function classifyCandidate(candidate: ImportCandidate, contacts: readonly ExistingContact[]): MatchResult {
  // 1) A phone is present → identity is decided by the phone, never the name.
  if (candidate.phone) {
    const byPhone = contacts.filter((c) => c.phone && c.phone === candidate.phone);
    if (byPhone.length === 1) {
      return {
        candidate,
        classification: 'exact',
        matchedContactIds: [byPhone[0]!.id],
        reason: 'phone matches exactly one existing contact',
        autoImportable: true,
      };
    }
    if (byPhone.length > 1) {
      return {
        candidate,
        classification: 'conflict',
        matchedContactIds: byPhone.map((c) => c.id),
        reason: 'phone matches more than one existing contact — a human must resolve it',
        autoImportable: false,
      };
    }
    // Phone present, matches nobody → a clean new record. The phone is a safe,
    // unique key, so creating it cannot duplicate an existing contact.
    return {
      candidate,
      classification: 'new',
      matchedContactIds: [],
      reason: 'phone matches no existing contact — safe to create as new',
      autoImportable: true,
    };
  }

  // 2) No phone → a name is all we have, and a name is not an identity.
  const cn = normName(candidate.displayName);
  const byName = cn ? contacts.filter((c) => normName(c.fullName) === cn) : [];
  if (byName.length === 1) {
    return {
      candidate,
      classification: 'probable',
      matchedContactIds: [byName[0]!.id],
      reason: 'name matches one existing contact, but a name is not proof — needs human confirmation',
      autoImportable: false,
    };
  }
  if (byName.length > 1) {
    return {
      candidate,
      classification: 'conflict',
      matchedContactIds: byName.map((c) => c.id),
      reason: 'name matches several existing contacts — ambiguous, a human must resolve it',
      autoImportable: false,
    };
  }
  // No phone and no name match → cannot be safely created without a key.
  return {
    candidate,
    classification: 'unmatched',
    matchedContactIds: [],
    reason: 'no phone and no name match — cannot be safely imported without a key; manual review',
    autoImportable: false,
  };
}

export type MatchSummary = {
  total: number;
  exact: number;
  new: number;
  probable: number;
  conflict: number;
  unmatched: number;
  /** exact + new — the only rows a commit may act on without a human. */
  autoImportable: number;
  /** probable + conflict + unmatched — everything a human must look at. */
  manualReview: number;
};

export function classifyAll(
  candidates: readonly ImportCandidate[],
  contacts: readonly ExistingContact[],
): { results: MatchResult[]; summary: MatchSummary } {
  const results = candidates.map((c) => classifyCandidate(c, contacts));
  const count = (k: MatchClass) => results.filter((r) => r.classification === k).length;
  const summary: MatchSummary = {
    total: results.length,
    exact: count('exact'),
    new: count('new'),
    probable: count('probable'),
    conflict: count('conflict'),
    unmatched: count('unmatched'),
    autoImportable: results.filter((r) => r.autoImportable).length,
    manualReview: results.filter((r) => !r.autoImportable).length,
  };
  return { results, summary };
}
