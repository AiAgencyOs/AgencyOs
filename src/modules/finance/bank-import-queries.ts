import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Reads over finance.bank_statement_lines — SCR-053, owner decision
 * 2026-09-29. Every read refuses on failure (G-054): an unreadable upload
 * must not render as a period with nothing imported.
 */

export type BankStatementLineRow = {
  id: string;
  reconciliationId: string;
  importBatch: string;
  sourceFilename: string | null;
  lineNo: number;
  statementDate: string;
  description: string;
  amountMinor: number;
  reference: string | null;
  status: 'pending' | 'confirmed' | 'ignored';
  itemId: string | null;
  ignoredReason: string | null;
  createdAt: string;
};

/** Every uploaded line of one period, in statement order. */
export async function listBankStatementLines(reconciliationId: string): Promise<BankStatementLineRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('finance')
    .from('bank_statement_lines')
    .select('id, reconciliation_id, import_batch, source_filename, line_no, statement_date, description, amount_minor, reference, status, item_id, ignored_reason, created_at')
    .eq('reconciliation_id', reconciliationId)
    .order('statement_date', { ascending: true })
    .order('line_no', { ascending: true });
  if (error) unreadable('listBankStatementLines', error);

  return (data ?? []).map((l) => ({
    id: l.id,
    reconciliationId: l.reconciliation_id,
    importBatch: l.import_batch,
    sourceFilename: l.source_filename,
    lineNo: l.line_no,
    statementDate: l.statement_date,
    description: l.description,
    amountMinor: Number(l.amount_minor),
    reference: l.reference,
    status: l.status === 'confirmed' ? 'confirmed' : l.status === 'ignored' ? 'ignored' : 'pending',
    itemId: l.item_id,
    ignoredReason: l.ignored_reason,
    createdAt: l.created_at,
  }));
}
