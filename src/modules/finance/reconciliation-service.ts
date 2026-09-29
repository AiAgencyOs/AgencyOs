import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  addReconciliationItemSchema,
  closeReconciliationSchema,
  openReconciliationSchema,
  resolveReconciliationItemSchema,
  type AddReconciliationItemInput,
  type CloseReconciliationInput,
  type OpenReconciliationInput,
  type ResolveReconciliationItemInput,
} from './reconciliation-schema';

/**
 * The doors over finance.reconciliations — Doc 15 §15 and §29; gap row 053.
 *
 * The tables (20260822260000) carried the rules and no code. What this adds
 * is the four acts §29 names: open a period against a statement, enter its
 * lines (IMPORT, by hand — there is no gateway), work the exception queue
 * (MATCH / ADJUSTMENT WITH REASON), and close.
 *
 * Nothing here touches a payment. `payment_id` on an item is a pointer,
 * `propose_match` only proposes, and the refusal to close over an
 * unexplained item is the database's (`refuse_unresolved_close`), answered
 * here as a count rather than an exception.
 *
 * `invoice.issue` (owner, ops_admin) throughout: the same pair that
 * verifies payments and that `reconciliations_write` admits.
 */

function gate(context: { role: Parameters<typeof can>[0] }, what: string): Result<null> {
  if (!can(context.role, 'invoice.issue')) return err('FORBIDDEN', `You do not have permission to ${what}.`);
  return ok(null);
}

type OpenRow = { outcome: string; reconciliation_id: string | null };
type CloseRow = { outcome: string; reconciliation_id: string | null; unresolved: number };

export async function openReconciliation(
  input: OpenReconciliationInput,
): Promise<Result<{ reconciliationId: string; alreadyOpen: boolean }>> {
  const parsed = openReconciliationSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid period.');

  const context = await requireInternal();
  const allowed = gate(context, 'open a reconciliation');
  if (!allowed.ok) return allowed;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc('open_reconciliation', {
    p_period_start: parsed.data.periodStart,
    p_period_end: parsed.data.periodEnd,
    p_source: parsed.data.source,
    ...(parsed.data.accountId ? { p_account_id: parsed.data.accountId } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'openReconciliation', detail: error.message }));
    return err('INTERNAL', 'Could not open the reconciliation.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as OpenRow | undefined;
  if (!row) return err('INTERNAL', 'Could not open the reconciliation.');

  switch (row.outcome) {
    case 'opened':
      if (!row.reconciliation_id) return err('INTERNAL', 'Could not open the reconciliation.');
      return ok({ reconciliationId: row.reconciliation_id, alreadyOpen: false });
    case 'already_open':
      if (!row.reconciliation_id) return err('INTERNAL', 'Could not open the reconciliation.');
      return ok({ reconciliationId: row.reconciliation_id, alreadyOpen: true });
    case 'not_a_period':
      return err('VALIDATION', 'The period must end after it starts.');
    case 'no_source':
      return err('VALIDATION', 'Say which statement this is.');
    case 'no_actor':
      return err('UNAUTHORIZED', 'No signed-in person to record this against.');
    default:
      console.error(JSON.stringify({ level: 'error', scope: 'openReconciliation', detail: `unrecognised outcome "${row.outcome}"` }));
      return err('INTERNAL', 'Could not open the reconciliation.');
  }
}

export async function addReconciliationItem(
  input: AddReconciliationItemInput,
): Promise<Result<{ itemId: string }>> {
  const parsed = addReconciliationItemSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid statement line.');

  const context = await requireInternal();
  const allowed = gate(context, 'enter statement lines');
  if (!allowed.ok) return allowed;
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();

  const { data: recon, error: reconError } = await supabase
    .schema('finance')
    .from('reconciliations')
    .select('id, status')
    .eq('id', parsed.data.reconciliationId)
    .maybeSingle();
  if (reconError) {
    console.error(JSON.stringify({ level: 'error', scope: 'addReconciliationItem', detail: reconError.message }));
    return err('INTERNAL', 'The reconciliation could not be read.');
  }
  if (!recon) return err('NOT_FOUND', 'That reconciliation is not visible to you.');
  if (recon.status === 'closed') return err('CONFLICT', 'This period is closed. Open a new one to enter more lines.');

  const { data, error } = await supabase
    .schema('finance')
    .from('reconciliation_items')
    .insert({
      organization_id: context.organizationId,
      reconciliation_id: parsed.data.reconciliationId,
      statement_line: parsed.data.statementLine,
      statement_date: parsed.data.statementDate,
      amount_minor: parsed.data.amountMinor,
      reference: parsed.data.reference || null,
      finding: parsed.data.finding,
      payment_id: parsed.data.paymentId ?? null,
      reason: parsed.data.reason || null,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error(JSON.stringify({ level: 'error', scope: 'addReconciliationItem', detail: error?.message }));
    return err('INTERNAL', error?.message ?? 'Could not record the statement line.');
  }
  return ok({ itemId: data.id });
}

/**
 * Work one line of the exception queue. The statement line itself cannot
 * change (the database freezes it, §29); only our reading of it can.
 */
export async function resolveReconciliationItem(
  input: ResolveReconciliationItemInput,
): Promise<Result<{ itemId: string }>> {
  const parsed = resolveReconciliationItemSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid finding.');

  const context = await requireInternal();
  const allowed = gate(context, 'resolve statement lines');
  if (!allowed.ok) return allowed;

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('finance')
    .from('reconciliation_items')
    .update({
      finding: parsed.data.finding,
      payment_id: parsed.data.paymentId ?? null,
      reason: parsed.data.reason || null,
    })
    .eq('id', parsed.data.itemId)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'resolveReconciliationItem', detail: error.message }));
    return err('INTERNAL', error.message);
  }
  if (!data) return err('NOT_FOUND', 'That statement line is not visible to you.');
  return ok({ itemId: data.id });
}

export async function closeReconciliation(
  input: CloseReconciliationInput,
): Promise<Result<{ reconciliationId: string; alreadyClosed: boolean }>> {
  const parsed = closeReconciliationSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Not a reconciliation id.');

  const context = await requireInternal();
  const allowed = gate(context, 'close a reconciliation');
  if (!allowed.ok) return allowed;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc('close_reconciliation', {
    p_reconciliation_id: parsed.data.reconciliationId,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'closeReconciliation', detail: error.message }));
    return err('INTERNAL', error.message);
  }
  const row = (Array.isArray(data) ? data[0] : data) as CloseRow | undefined;
  if (!row) return err('INTERNAL', 'Could not close the reconciliation.');

  switch (row.outcome) {
    case 'closed':
      return ok({ reconciliationId: parsed.data.reconciliationId, alreadyClosed: false });
    case 'already_closed':
      return ok({ reconciliationId: parsed.data.reconciliationId, alreadyClosed: true });
    case 'unresolved':
      return err(
        'CONFLICT',
        `This period still has ${row.unresolved} item${row.unresolved === 1 ? '' : 's'} nobody has explained. Review each one, give it a reason, then close.`,
      );
    case 'not_found':
      return err('NOT_FOUND', 'That reconciliation is not visible to you.');
    case 'no_actor':
      return err('UNAUTHORIZED', 'No signed-in person to record this against.');
    default:
      console.error(JSON.stringify({ level: 'error', scope: 'closeReconciliation', detail: `unrecognised outcome "${row.outcome}"` }));
      return err('INTERNAL', 'Could not close the reconciliation.');
  }
}
