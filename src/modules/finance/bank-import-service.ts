import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { parseBankCsv } from './bank-csv';
import {
  confirmBankLineMatchSchema,
  ignoreBankLineSchema,
  importBankStatementSchema,
  type ConfirmBankLineMatchInput,
  type IgnoreBankLineInput,
  type ImportBankStatementInput,
} from './bank-import-schema';

/**
 * The bank CSV doors — SCR-053, owner decision 2026-09-29.
 *
 * `invoice.issue` (owner, ops_admin) throughout: the pair that reconciles,
 * and the pair `bank_statement_lines_write` admits. Each door is one
 * database function that audits in its own transaction:
 *
 *   import  — the parsed lines, as one batch, on an open period;
 *   confirm — a person accepts a proposed match: the reconciliation_item is
 *             written (finding `matched`, naming the payment), the line is
 *             marked confirmed. The same row the hand-typed path writes.
 *   ignore  — a person sets a line aside with a reason.
 *
 * Nothing here alters a payment (Doc 15 §15).
 */

function gate(context: { role: Parameters<typeof can>[0] }, what: string): Result<null> {
  if (!can(context.role, 'invoice.issue')) return err('FORBIDDEN', `You do not have permission to ${what}.`);
  return ok(null);
}

type ImportRow = { outcome: string; batch_id: string | null; imported: number };
type ConfirmRow = { outcome: string; item_id: string | null };
type IgnoreRow = { outcome: string };

export async function importBankStatement(
  input: ImportBankStatementInput,
): Promise<Result<{ batchId: string; imported: number; skipped: string[] }>> {
  const parsed = importBankStatementSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid upload.');

  const context = await requireInternal();
  const allowed = gate(context, 'import a bank statement');
  if (!allowed.ok) return allowed;

  const read = parseBankCsv(parsed.data.csvText);
  if (read.lines.length === 0) {
    return err('VALIDATION', read.errors[0] ?? 'No statement lines could be read from that file.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc('import_bank_statement_lines', {
    p_reconciliation_id: parsed.data.reconciliationId,
    ...(parsed.data.filename ? { p_source_filename: parsed.data.filename } : {}),
    p_lines: read.lines.map((l) => ({
      line_no: l.lineNo,
      date: l.date,
      description: l.description,
      amount_minor: l.amountMinor,
      reference: l.reference,
    })),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'importBankStatement', detail: error.message }));
    return err('INTERNAL', `The statement could not be filed: ${error.message}`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as ImportRow | undefined;
  if (!row) return err('INTERNAL', 'The statement could not be filed.');

  switch (row.outcome) {
    case 'imported':
      if (!row.batch_id) return err('INTERNAL', 'The statement could not be filed.');
      return ok({ batchId: row.batch_id, imported: row.imported, skipped: read.errors });
    case 'not_found':
      return err('NOT_FOUND', 'That reconciliation is not visible to you.');
    case 'closed':
      return err('CONFLICT', 'This period is closed. Open a new one to import a statement.');
    case 'empty':
      return err('VALIDATION', 'No statement lines could be read from that file.');
    case 'no_actor':
      return err('UNAUTHORIZED', 'No signed-in person to record this against.');
    default:
      console.error(JSON.stringify({ level: 'error', scope: 'importBankStatement', detail: `unrecognised outcome "${row.outcome}"` }));
      return err('INTERNAL', 'The statement could not be filed.');
  }
}

export async function confirmBankLineMatch(input: ConfirmBankLineMatchInput): Promise<Result<{ itemId: string }>> {
  const parsed = confirmBankLineMatchSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid match.');

  const context = await requireInternal();
  const allowed = gate(context, 'confirm a match');
  if (!allowed.ok) return allowed;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc('confirm_bank_line_match', {
    p_line_id: parsed.data.lineId,
    p_payment_id: parsed.data.paymentId,
    ...(parsed.data.reason ? { p_reason: parsed.data.reason } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'confirmBankLineMatch', detail: error.message }));
    return err('INTERNAL', `The match could not be recorded: ${error.message}`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as ConfirmRow | undefined;
  if (!row) return err('INTERNAL', 'The match could not be recorded.');

  switch (row.outcome) {
    case 'matched':
      if (!row.item_id) return err('INTERNAL', 'The match could not be recorded.');
      return ok({ itemId: row.item_id });
    case 'already_resolved':
      return err('CONFLICT', 'This line was already matched or set aside.');
    case 'closed':
      return err('CONFLICT', 'This period is closed.');
    case 'payment_not_found':
      return err('NOT_FOUND', 'That payment is not visible to you.');
    case 'not_found':
      return err('NOT_FOUND', 'That statement line is not visible to you.');
    case 'no_actor':
      return err('UNAUTHORIZED', 'No signed-in person to record this against.');
    default:
      console.error(JSON.stringify({ level: 'error', scope: 'confirmBankLineMatch', detail: `unrecognised outcome "${row.outcome}"` }));
      return err('INTERNAL', 'The match could not be recorded.');
  }
}

export async function ignoreBankLine(input: IgnoreBankLineInput): Promise<Result<{ lineId: string }>> {
  const parsed = ignoreBankLineSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid reason.');

  const context = await requireInternal();
  const allowed = gate(context, 'set a statement line aside');
  if (!allowed.ok) return allowed;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc('ignore_bank_line', {
    p_line_id: parsed.data.lineId,
    p_reason: parsed.data.reason,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'ignoreBankLine', detail: error.message }));
    return err('INTERNAL', `The line could not be set aside: ${error.message}`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as IgnoreRow | undefined;
  if (!row) return err('INTERNAL', 'The line could not be set aside.');

  switch (row.outcome) {
    case 'ignored':
      return ok({ lineId: parsed.data.lineId });
    case 'already_resolved':
      return err('CONFLICT', 'This line was already matched or set aside.');
    case 'no_reason':
      return err('VALIDATION', 'Say why this line is set aside.');
    case 'not_found':
      return err('NOT_FOUND', 'That statement line is not visible to you.');
    case 'no_actor':
      return err('UNAUTHORIZED', 'No signed-in person to record this against.');
    default:
      return err('INTERNAL', 'The line could not be set aside.');
  }
}
