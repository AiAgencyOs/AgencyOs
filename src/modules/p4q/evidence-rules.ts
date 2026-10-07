/**
 * P4-QAP-043: the pure half of the evidence upload (no session, no storage), so it is tested without either.
 */

export const QA_EVIDENCE_KINDS = ['screenshot', 'recording', 'log', 'report', 'other'] as const;
export type QaEvidenceKind = (typeof QA_EVIDENCE_KINDS)[number];

/** What each refusal of the door says, in words a person can act on. Pure, so it is tested without a database. */
export function evidenceRefusalMessage(outcome: string): string {
  switch (outcome) {
    case 'forbidden':
      return 'You do not have permission to attach evidence.';
    case 'unknown_run':
      return 'That QA run was not found.';
    case 'bad_kind':
      return 'That is not a kind of evidence.';
    case 'bad_size':
      return 'The file is empty or larger than the limit.';
    case 'bad_path':
    case 'bad_file_type':
      return 'The file is not a kind of evidence that can be stored (screenshots, recordings, logs, reports).';
    case 'credential_name':
      return 'The file name looks like it holds a credential, so it was not saved.';
    case 'contains_secret':
      return 'The note looks like it holds a credential, so nothing was saved.';
    case 'unknown_check':
      return 'That check is not part of this run.';
    case 'defect_not_from_this_run':
      return 'That defect was not raised by this run.';
    case 'too_many_files':
      return 'This run already has the most evidence files it can hold.';
    default:
      return 'The evidence could not be recorded.';
  }
}
