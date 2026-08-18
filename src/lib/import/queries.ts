import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { summarizeStaged, type StagedRecord, type StagedSummary } from './staged';

/**
 * Reads for the Admin import screen — RLS-scoped, so an owner sees only their
 * own organization's batches (import_batches_select / import_records_select
 * admit an internal role of the row's own org). `unreadable()` on a failed read
 * for the G-054 reason: an empty preview because the database did not answer
 * would invite a commit against nothing.
 */

export type ImportBatchListItem = {
  id: string;
  source_label: string;
  note: string | null;
  created_at: string;
  summary: StagedSummary;
};

const RECORD_COLUMNS =
  'id, phone, display_name, message_count, source_label, classification, auto_importable, committed_at, committed_contact_id, committed_lead_id';

export async function listImportBatches(): Promise<ImportBatchListItem[]> {
  const supabase = await createClient();

  const { data: batches, error: batchesError } = await supabase
    .schema('crm')
    .from('import_batches')
    .select('id, source_label, note, created_at')
    .order('created_at', { ascending: false });
  if (batchesError) unreadable('listImportBatches', batchesError);
  if (!batches || batches.length === 0) return [];

  const { data: records, error: recordsError } = await supabase
    .schema('crm')
    .from('import_records')
    .select('batch_id, classification, auto_importable, committed_at');
  if (recordsError) unreadable('listImportBatches', recordsError);

  const byBatch = new Map<string, StagedRecord[]>();
  for (const r of records ?? []) {
    const list = byBatch.get(r.batch_id) ?? [];
    // Only the fields summarizeStaged reads; the rest are absent by design here.
    list.push(r as unknown as StagedRecord);
    byBatch.set(r.batch_id, list);
  }

  return batches.map((b) => ({
    id: b.id,
    source_label: b.source_label,
    note: b.note,
    created_at: b.created_at,
    summary: summarizeStaged(byBatch.get(b.id) ?? []),
  }));
}

export type ImportBatchDetail = {
  id: string;
  source_label: string;
  note: string | null;
  created_at: string;
  records: StagedRecord[];
  summary: StagedSummary;
  /**
   * Committed contacts that hold a granted WhatsApp consent row — the SAME gate
   * the send path uses, read here so the screen can show which committed leads
   * are reactivation-eligible and why the rest are not. An imported lead has no
   * consent, so this set is empty until consent is separately recorded.
   */
  contactsWithConsent: string[];
};

export async function getImportBatch(batchId: string): Promise<ImportBatchDetail | null> {
  const supabase = await createClient();

  const { data: batch, error: batchError } = await supabase
    .schema('crm')
    .from('import_batches')
    .select('id, source_label, note, created_at')
    .eq('id', batchId)
    .maybeSingle();
  if (batchError) unreadable('getImportBatch', batchError);
  if (!batch) return null;

  const { data: records, error: recordsError } = await supabase
    .schema('crm')
    .from('import_records')
    .select(RECORD_COLUMNS)
    .eq('batch_id', batchId)
    .order('classification', { ascending: true })
    .order('display_name', { ascending: true });
  if (recordsError) unreadable('getImportBatch', recordsError);

  const rows = (records ?? []) as StagedRecord[];

  // Reactivation eligibility is the send gate's rule, not a new one: read which
  // committed contacts hold a granted WhatsApp consent row. Empty for a fresh
  // import (it sets no consent), so every committed lead reads as blocked.
  const committedContactIds = [...new Set(rows.map((r) => r.committed_contact_id).filter((v): v is string => v !== null))];
  let contactsWithConsent: string[] = [];
  if (committedContactIds.length > 0) {
    const { data: consent, error: consentError } = await supabase
      .schema('crm')
      .from('communication_consent')
      .select('contact_id')
      .in('contact_id', committedContactIds)
      .eq('channel', 'whatsapp')
      .eq('status', 'granted');
    if (consentError) unreadable('getImportBatch', consentError);
    contactsWithConsent = (consent ?? []).map((c) => c.contact_id as string);
  }

  return {
    id: batch.id,
    source_label: batch.source_label,
    note: batch.note,
    created_at: batch.created_at,
    records: rows,
    summary: summarizeStaged(rows),
    contactsWithConsent,
  };
}
