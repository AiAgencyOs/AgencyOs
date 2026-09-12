import 'server-only';

import { z } from 'zod';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

/**
 * Commit one staged import record — the thin app wrapper over
 * `crm.commit_import_record`, which is where the real work and every safety
 * rule live (idempotent, phone-keyed only, no consent, no send, audited,
 * tenant-derived). This adds the app-layer capability check and maps the
 * database's verdict to a Result.
 *
 * Gated on `organization.settings` — the owner capability the rest of the
 * reactivation/import admin surface uses; the database independently admits
 * owner OR ops_admin, so the app is the stricter of the two (safe).
 */

const recordId = z.string().uuid();

type Outcome = {
  outcome: string;
  contact_id: string | null;
  lead_id: string | null;
  messages_imported: number | null;
  messages_skipped: number | null;
};

export async function commitImportRecord(
  id: string,
): Promise<Result<{ contactId: string; leadId: string; messagesImported: number; messagesSkipped: number }>> {
  const parsed = recordId.safeParse(id);
  if (!parsed.success) return err('VALIDATION', 'That is not a valid import record id.');

  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'You do not have permission to commit an import.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('commit_import_record', { p_record_id: parsed.data });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'commitImportRecord', detail: error.message }));
    return err('INTERNAL', 'Could not commit the record.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as Outcome | undefined;
  switch (row?.outcome) {
    case 'committed':
    case 'already_committed':
      return ok({
        contactId: row.contact_id ?? '',
        leadId: row.lead_id ?? '',
        // G-218: how much of their own history came with them, and how much
        // was left behind. An operator reading "0 of 240" needs to know that
        // happened rather than discover it when the agent has no context.
        messagesImported: row.messages_imported ?? 0,
        messagesSkipped: row.messages_skipped ?? 0,
      });
    case 'not_importable':
      return err('VALIDATION', 'This row is not phone-keyed (a name is not enough) — it stays for manual review.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner or ops-admin may commit an import.');
    case 'not_found':
      return err('NOT_FOUND', 'Import record not found.');
    case 'no_timezone':
      // G-137's fact, needed here for G-218's reason: a WhatsApp export states
      // no timezone, and the 24-hour window is computed from these times.
      return err(
        'VALIDATION',
        'Set your agency’s timezone in Settings first — a WhatsApp export does not say which timezone its times are in, and AgencyOS will not guess one.',
      );
    default:
      return err('INTERNAL', 'Could not commit the record.');
  }
}

/**
 * Commit a whole import batch, in one bounded pass — G-224.
 *
 * The single-record door above is the right shape for one row and the wrong
 * shape for a file of hundreds: an operator has already decided "import this
 * export", and making them press Commit once per row is how the hundredth row
 * gets filed without being looked at.
 *
 * Everything the database refuses per record, it refuses here too — the batch
 * function calls the single-record one rather than repeating its rules, so the
 * phone-keyed-only rule and the no-timezone refusal cannot be missing from the
 * bulk path. Committing files a contact and a lead and SENDS NOTHING, so unlike
 * the reactivation batch there is no pilot gate to obey.
 */
export type BatchCommit = {
  committed: number;
  already: number;
  skipped: number;
  uncommitted: number;
  remaining: number;
};

type BatchRow = {
  outcome: string;
  committed: number | null;
  already: number | null;
  skipped: number | null;
  uncommitted: number | null;
  remaining: number | null;
};

export async function commitImportBatch(batchId: string, limit = 100): Promise<Result<BatchCommit>> {
  const parsed = z.string().uuid().safeParse(batchId);
  if (!parsed.success) return err('VALIDATION', 'That is not a valid import batch id.');

  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'You do not have permission to commit an import.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .rpc('commit_import_batch', { p_batch_id: parsed.data, p_limit: limit });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'commitImportBatch', detail: error.message }));
    return err('INTERNAL', 'The batch could not be committed.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as BatchRow | undefined;
  switch (row?.outcome) {
    case 'committed':
      return ok({
        committed: row.committed ?? 0,
        already: row.already ?? 0,
        skipped: row.skipped ?? 0,
        uncommitted: row.uncommitted ?? 0,
        remaining: row.remaining ?? 0,
      });
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner or ops-admin may commit an import.');
    case 'not_found':
      return err('NOT_FOUND', 'That import batch does not exist.');
    default:
      return err('INTERNAL', `The batch could not be committed (${row?.outcome ?? 'no answer'}).`);
  }
}
