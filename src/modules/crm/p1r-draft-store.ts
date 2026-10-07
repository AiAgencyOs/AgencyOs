import type { createAdminClient } from '@/lib/db/admin';
import type { DraftLanguage } from '@/lib/scheduling/p1r-messages';

/**
 * Round 4, Scheduler: the job runner's way to KEEP a scheduling draft (P1-SCHED-011, the clarification question). A draft is a row, not a message: nothing here writes
 * to a conversation or calls a provider, and the database refuses the service role the door that records a send. No session imports, so a job handler can use it.
 */
type Admin = ReturnType<typeof createAdminClient>;
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export type DraftStoreResult = { ok: true; draftId: string; replaced: boolean } | { ok: false; reason: string };

export async function saveSchedulingDraftAsService(
  admin: Admin,
  input: { meetingId: string; kind: 'proposal' | 'confirmation' | 'no_availability' | 'clarification'; language: DraftLanguage; body: string; flagId?: string | null },
): Promise<DraftStoreResult> {
  const { data, error } = await (admin.schema('crm' as never) as unknown as { rpc: Rpc }).rpc('p1r_save_scheduling_draft', {
    p_meeting_id: input.meetingId, p_kind: input.kind, p_language: input.language, p_body: input.body, p_flag_id: input.flagId ?? null,
  });
  if (error) return { ok: false, reason: error.message };
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; draft_id?: string } | null;
  if (row?.outcome === 'saved' || row?.outcome === 'replaced') return { ok: true, draftId: String(row.draft_id ?? ''), replaced: row.outcome === 'replaced' };
  return { ok: false, reason: String(row?.outcome ?? 'no answer') };
}
