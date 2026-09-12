import 'server-only';

import { z } from 'zod';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  MEETING_DOORS,
  interpretAnalysis,
  interpretCancel,
  interpretComplete,
  interpretEvidence,
  interpretNoShow,
  type CommandDecision,
} from './meeting-commands-eval';

/**
 * The meeting commands — G-237. Thin on purpose: the state machine is at the
 * row (`crm.enforce_meeting_transition`), the rules are in the SECURITY
 * DEFINER doors, and the audit rows are written in their transactions. This
 * layer checks the capability, validates the shape, calls the door under the
 * caller's own session (so `auth.uid()` is the person who concluded the
 * meeting) and turns the answer into a sentence. Every door returns the
 * row's `lead_id`, and that — never a field a form carried — is what the
 * lead's page is revalidated from.
 *
 * Gated on `lead.write`: the sales team's own write capability, held by the
 * owner and ops_admin. The database independently demands `core.can_write()`
 * (owner, ops_admin, delivery_lead, member) — the row policies' own rule;
 * app stricter than the database is the safe direction.
 */

const meetingId = z.string().uuid();
const note = z.string().max(20000).optional();

export const COMPLETION_OUTCOMES = ['completed', 'failed', 'follow_up_required'] as const;
export const EVIDENCE_KINDS_OFFERED = ['notes', 'summary'] as const;
export const EVIDENCE_VISIBILITIES = ['internal', 'client_visible'] as const;

export type Concluded = { message: string; leadId: string | null };

type Row = { outcome: string; lead_id?: string | null; provider_event_id?: string | null; analysis?: string | null };

function first(data: unknown): Row | undefined {
  return (Array.isArray(data) ? data[0] : data) as Row | undefined;
}

async function authorise(): Promise<Result<true>> {
  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'Your role cannot conclude a meeting; the owner or an ops admin can.');
  }
  return ok(true);
}

/** One door, one call, one sentence — the shape every command below shares. */
async function throughDoor(
  door: keyof typeof MEETING_DOORS,
  args: Record<string, string>,
  failure: string,
  interpret: (row: Row | undefined) => CommandDecision,
): Promise<Result<Concluded>> {
  const auth = await authorise();
  if (!auth.ok) return auth;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc(MEETING_DOORS[door].rpc, args as never);
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: door, detail: error.message }));
    return err('INTERNAL', failure);
  }
  const row = first(data);
  const decision = interpret(row);
  if (decision.kind === 'error') return err(decision.code, decision.message);
  return ok({ message: decision.message, leadId: row?.lead_id ?? null });
}

export async function cancelMeeting(id: string, reason: string | undefined): Promise<Result<Concluded>> {
  const parsed = z.object({ id: meetingId, reason: note }).safeParse({ id, reason });
  if (!parsed.success) return err('VALIDATION', 'That is not a valid meeting id, or the reason is too long.');
  return throughDoor(
    'crm.cancel_meeting',
    { p_meeting_id: parsed.data.id, ...(parsed.data.reason ? { p_reason: parsed.data.reason } : {}) },
    'Could not cancel the meeting.',
    (row) => interpretCancel(row?.outcome, row?.provider_event_id),
  );
}

export async function completeMeeting(id: string, outcome: string, noteText: string | undefined): Promise<Result<Concluded>> {
  const parsed = z
    .object({ id: meetingId, outcome: z.enum(COMPLETION_OUTCOMES), note })
    .safeParse({ id, outcome, note: noteText });
  if (!parsed.success) return err('VALIDATION', 'The outcome must be completed, failed or follow-up required, and the note under 20,000 characters.');
  return throughDoor(
    'crm.complete_meeting',
    { p_meeting_id: parsed.data.id, p_outcome: parsed.data.outcome, ...(parsed.data.note ? { p_note: parsed.data.note } : {}) },
    'Could not mark the meeting completed.',
    (row) => interpretComplete(row?.outcome, row?.analysis),
  );
}

export async function recordNoShow(id: string, noteText: string | undefined): Promise<Result<Concluded>> {
  const parsed = z.object({ id: meetingId, note }).safeParse({ id, note: noteText });
  if (!parsed.success) return err('VALIDATION', 'That is not a valid meeting id, or the note is too long.');
  return throughDoor(
    'crm.record_no_show',
    { p_meeting_id: parsed.data.id, ...(parsed.data.note ? { p_note: parsed.data.note } : {}) },
    'Could not record the no-show.',
    (row) => interpretNoShow(row?.outcome),
  );
}

/**
 * Typed text only. The door accepts a reference, but no store signs one
 * (G-229), so the application offers exactly what it can keep honestly:
 * notes and a structured summary, internal unless said otherwise.
 */
export async function addMeetingEvidence(id: string, kind: string, visibility: string, body: string): Promise<Result<Concluded>> {
  const parsed = z
    .object({ id: meetingId, kind: z.enum(EVIDENCE_KINDS_OFFERED), visibility: z.enum(EVIDENCE_VISIBILITIES), body: z.string().max(20000) })
    .safeParse({ id, kind, visibility, body });
  if (!parsed.success) return err('VALIDATION', 'Evidence here is notes or a summary, internal or client-visible, under 20,000 characters.');
  return throughDoor(
    'crm.add_meeting_evidence',
    { p_meeting_id: parsed.data.id, p_kind: parsed.data.kind, p_body: parsed.data.body, p_visibility: parsed.data.visibility },
    'Could not attach the evidence.',
    (row) => interpretEvidence(row?.outcome),
  );
}

/**
 * §9.3's last step, asked again. A completion with no note answers
 * `no_evidence`; once evidence exists the gate can be asked from the page —
 * review found the first draft leaving a settled meeting with no way back
 * to the chain. G-229's door returns no lead_id; the page revalidates itself.
 */
export async function requestMeetingAnalysis(id: string): Promise<Result<Concluded>> {
  const parsed = meetingId.safeParse(id);
  if (!parsed.success) return err('VALIDATION', 'That is not a valid meeting id.');
  return throughDoor('crm.request_meeting_analysis', { p_meeting_id: parsed.data }, 'Could not request the analysis.', (row) => interpretAnalysis(row?.outcome));
}
