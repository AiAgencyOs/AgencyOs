/**
 * The shape of a staged import as the Admin Panel reads it — pure, so the
 * bucket arithmetic the preview shows can be tested without a database. It
 * mirrors src/lib/import/match.ts's classes and repeats the one invariant that
 * matters on screen: only phone-keyed exact/new rows are committable, and a
 * staged import carries no consent.
 */

export type StagedClassification = 'exact' | 'new' | 'probable' | 'conflict' | 'unmatched';

export type StagedRecord = {
  id: string;
  phone: string | null;
  display_name: string;
  message_count: number;
  source_label: string;
  classification: StagedClassification;
  auto_importable: boolean;
  committed_at: string | null;
  committed_contact_id: string | null;
  committed_lead_id: string | null;
};

export type StagedSummary = {
  total: number;
  exact: number;
  new: number;
  probable: number;
  conflict: number;
  unmatched: number;
  /** exact + new — the rows a commit may act on. */
  autoImportable: number;
  /** probable + conflict + unmatched — rows a human must resolve. */
  manualReview: number;
  committed: number;
  /** Auto-importable rows not yet committed — the work still to do. */
  pending: number;
  /** Always 'none'. A staged import is data, not permission. */
  consentProvenance: 'none';
};

export type ReactivationStatus =
  | { applicable: false } // not committed yet — no lead exists to reactivate
  | { applicable: true; eligible: true }
  | { applicable: true; eligible: false; reason: string };

/**
 * Whether a committed import lead may enter the reactivation pilot — decided by
 * the SAME rule the send gate uses, never re-derived: its contact must hold a
 * granted WhatsApp consent row. An import sets no consent, so a freshly imported
 * lead is always blocked here until consent is separately recorded. This does
 * not grant anything; it reports the existing gate's verdict and its reason.
 */
export function reactivationStatus(record: StagedRecord, committedContactHasConsent: boolean): ReactivationStatus {
  if (record.committed_at === null || record.committed_contact_id === null) return { applicable: false };
  if (committedContactHasConsent) return { applicable: true, eligible: true };
  return {
    applicable: true,
    eligible: false,
    reason: 'no granted WhatsApp consent — record consent before enrolling (a message is not consent)',
  };
}

export function summarizeStaged(records: readonly StagedRecord[]): StagedSummary {
  const count = (k: StagedClassification) => records.filter((r) => r.classification === k).length;
  const autoImportable = records.filter((r) => r.auto_importable).length;
  const committed = records.filter((r) => r.committed_at !== null).length;
  return {
    total: records.length,
    exact: count('exact'),
    new: count('new'),
    probable: count('probable'),
    conflict: count('conflict'),
    unmatched: count('unmatched'),
    autoImportable,
    manualReview: records.length - autoImportable,
    committed,
    pending: records.filter((r) => r.auto_importable && r.committed_at === null).length,
    consentProvenance: 'none',
  };
}
