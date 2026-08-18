import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { classifyAll, type ExistingContact, type ImportCandidate } from './match';
import { summarizeStaged } from './staged';
import { parseWhatsAppChat } from './whatsapp-chat';

/**
 * Stage a WhatsApp export uploaded from the Admin Panel — the browser entry to
 * the SAME pipeline the CLI loader uses (parse → classify → stage). There is no
 * second import engine here: it reuses `parseWhatsAppChat` and `classifyAll`,
 * and writes to the same `crm.import_batches` / `crm.import_records`, then the
 * existing preview and `crm.commit_import_record` take over.
 *
 * Two things differ from the CLI and both make it safer, not looser:
 *   • the organization is DERIVED from the authenticated session, never passed
 *     in — so a browser upload cannot target another tenant; and
 *   • the writes go through the RLS-scoped session client, so the
 *     import_records_insert policy (own org, owner/ops_admin) and the
 *     org-consistency guards independently refuse a cross-tenant row.
 *
 * It creates NO contact, NO lead, NO consent, and sends NOTHING — staging only.
 * An owner reviews the batch and commits the phone-keyed rows from /import.
 */

const CONTACT_SCAN_CAP = 100_000;

export type UploadResult = { batchId: string; total: number; autoImportable: number; manualReview: number };

export async function stageUploadedExport(text: string, sourceLabel: string): Promise<Result<UploadResult>> {
  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'You do not have permission to import leads.');
  }
  const org = context.organizationId;
  if (!org) return err('INTERNAL', 'No organization in your session.');

  const label = sourceLabel.trim().slice(0, 200) || 'WhatsApp upload';

  const parsed = parseWhatsAppChat(text);
  if (parsed.meta.messageCount === 0) {
    return err('VALIDATION', 'No WhatsApp messages were recognized — is this an exported _chat.txt? (Extract the .zip first.)');
  }

  const supabase = await createClient();

  // The set identity is decided against — the caller's OWN org, under RLS.
  const { data: contactRows, error: contactsError } = await supabase
    .schema('crm')
    .from('contacts')
    .select('id, phone, full_name')
    .limit(CONTACT_SCAN_CAP);
  if (contactsError) return err('INTERNAL', 'Could not read contacts to match against.');
  const existing: ExistingContact[] = (contactRows ?? []).map((c) => ({ id: c.id, phone: c.phone, fullName: c.full_name }));

  // One candidate per observed person, phone-deduped (a name is never deduped).
  const seenPhone = new Set<string>();
  const candidates: ImportCandidate[] = [];
  for (const p of parsed.participants) {
    if (p.phone && seenPhone.has(p.phone)) continue;
    if (p.phone) seenPhone.add(p.phone);
    candidates.push({ phone: p.phone, displayName: p.displayName, sourceLabel: label, messageCount: p.messageCount });
  }
  const { results } = classifyAll(candidates, existing);

  // Batch — organization_id is the session's org; RLS refuses any other.
  const { data: batch, error: batchError } = await supabase
    .schema('crm')
    .from('import_batches')
    .insert({ organization_id: org, source_label: label, created_by: context.userId })
    .select('id')
    .single();
  if (batchError || !batch) return err('INTERNAL', 'Could not create the import batch.');

  const rows = results.map((r) => ({
    batch_id: batch.id,
    organization_id: org,
    phone: r.candidate.phone,
    display_name: r.candidate.displayName,
    message_count: r.candidate.messageCount,
    source_label: label,
    classification: r.classification,
    auto_importable: r.autoImportable,
    matched_contact_id:
      r.classification === 'exact' || r.classification === 'probable' ? (r.matchedContactIds[0] ?? null) : null,
  }));

  if (rows.length > 0) {
    const { error: recordsError } = await supabase.schema('crm').from('import_records').insert(rows);
    if (recordsError) {
      // Roll back the empty batch so a failed stage leaves nothing partial to review.
      await supabase.schema('crm').from('import_batches').delete().eq('id', batch.id);
      return err('INTERNAL', 'Could not stage the records; the batch was discarded.');
    }
  }

  const summary = summarizeStaged(
    rows.map((r) => ({
      id: '',
      phone: r.phone,
      display_name: r.display_name,
      message_count: r.message_count,
      source_label: r.source_label,
      classification: r.classification,
      auto_importable: r.auto_importable,
      committed_at: null,
      committed_contact_id: null,
      committed_lead_id: null,
    })),
  );

  return ok({ batchId: batch.id, total: summary.total, autoImportable: summary.autoImportable, manualReview: summary.manualReview });
}
