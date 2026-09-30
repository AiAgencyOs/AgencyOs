import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-017's two communication reads that `clients.ts` did not have.
 *
 * **Unread client replies.** There is no read-receipt table for internal
 * users, so "unread" is derived the only honest way the message log allows:
 * an inbound message that arrived AFTER the last outbound one on the same
 * conversation is a reply nobody has answered. A thread whose last message
 * is ours counts zero. Both the client's project groups (`project_id`) and
 * the lead threads it is reachable from (`lead_id`) are counted, because a
 * client who writes on the old sales thread has still written.
 *
 * **Meeting notes and decisions.** `crm.meeting_evidence` rows of kind
 * `notes` or `summary` on the client's leads' meetings — typed notes and the
 * meeting summary, the two kinds that carry a body rather than a reference.
 */

export type UnreadReplyThread = {
  conversationId: string;
  title: string | null;
  kind: string;
  unread: number;
  latestAt: string;
  latestBody: string | null;
};

export type ClientUnreadReplies = {
  total: number;
  threads: UnreadReplyThread[];
};

function directionOf(metadata: unknown): 'inbound' | 'outbound' | null {
  const d = (metadata as Record<string, unknown> | null)?.direction;
  return d === 'inbound' || d === 'outbound' ? d : null;
}

/** How many recent messages, across all of a client's threads, the derivation reads. */
const UNREAD_SCAN_LIMIT = 1000;

export async function readClientUnreadReplies(input: {
  projectIds: string[];
  leadIds: string[];
}): Promise<ClientUnreadReplies> {
  const supabase = await createClient();

  const [groups, leadThreads] = await Promise.all([
    input.projectIds.length > 0
      ? supabase
          .schema('crm')
          .from('conversations')
          .select('id, title, kind')
          .in('project_id', input.projectIds)
          .neq('status', 'abandoned')
      : Promise.resolve({ data: [], error: null }),
    input.leadIds.length > 0
      ? supabase
          .schema('crm')
          .from('conversations')
          .select('id, title, kind')
          .in('lead_id', input.leadIds)
          .neq('status', 'abandoned')
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (groups.error) unreadable('readClientUnreadReplies.groups', groups.error);
  if (leadThreads.error) unreadable('readClientUnreadReplies.leadThreads', leadThreads.error);

  const conversations = new Map<string, { title: string | null; kind: string }>();
  for (const c of [...(groups.data ?? []), ...(leadThreads.data ?? [])]) {
    conversations.set(c.id, { title: c.title, kind: c.kind });
  }
  if (conversations.size === 0) return { total: 0, threads: [] };

  const { data: messages, error } = await supabase
    .schema('crm')
    .from('conversation_messages')
    .select('conversation_id, seq, body, occurred_at, metadata')
    .in('conversation_id', [...conversations.keys()])
    .order('occurred_at', { ascending: false })
    .limit(UNREAD_SCAN_LIMIT);
  if (error) unreadable('readClientUnreadReplies.messages', error);

  // Newest first: every inbound message seen before the first outbound one
  // on its thread is unanswered; the first outbound closes the thread.
  const state = new Map<string, { unread: number; closed: boolean; latestAt: string; latestBody: string | null }>();
  for (const m of messages ?? []) {
    const entry = state.get(m.conversation_id) ?? { unread: 0, closed: false, latestAt: m.occurred_at, latestBody: m.body };
    if (!entry.closed) {
      const direction = directionOf(m.metadata);
      if (direction === 'outbound') entry.closed = true;
      else if (direction === 'inbound') {
        entry.unread += 1;
        if (entry.unread === 1) {
          entry.latestAt = m.occurred_at;
          entry.latestBody = m.body;
        }
      }
    }
    state.set(m.conversation_id, entry);
  }

  const threads: UnreadReplyThread[] = [];
  for (const [conversationId, entry] of state) {
    if (entry.unread === 0) continue;
    const meta = conversations.get(conversationId);
    threads.push({
      conversationId,
      title: meta?.title ?? null,
      kind: meta?.kind ?? 'direct',
      unread: entry.unread,
      latestAt: entry.latestAt,
      latestBody: entry.latestBody,
    });
  }
  threads.sort((a, b) => b.latestAt.localeCompare(a.latestAt));

  return { total: threads.reduce((sum, t) => sum + t.unread, 0), threads };
}

export type ClientMeetingNote = {
  id: string;
  meetingId: string;
  leadId: string;
  kind: 'notes' | 'summary';
  visibility: string;
  body: string | null;
  artifactRef: string | null;
  uploadedAt: string;
  meetingStatus: string;
  meetingOutcome: string | null;
  meetingAt: string | null;
  meetingMode: string | null;
};

export async function listClientMeetingNotes(leadIds: string[], limit = 50): Promise<ClientMeetingNote[]> {
  if (leadIds.length === 0) return [];
  const supabase = await createClient();

  const { data: evidence, error } = await supabase
    .schema('crm')
    .from('meeting_evidence')
    .select('id, meeting_id, lead_id, kind, visibility, body, artifact_ref, uploaded_at')
    .in('lead_id', leadIds)
    .in('kind', ['notes', 'summary'])
    .order('uploaded_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listClientMeetingNotes.evidence', error);

  const rows = evidence ?? [];
  if (rows.length === 0) return [];

  const meetingIds = [...new Set(rows.map((r) => r.meeting_id))];
  const { data: meetings, error: meetingsError } = await supabase
    .schema('crm')
    .from('meetings')
    .select('id, status, outcome, confirmed_start_at, requested_start_at, booked_mode, requested_mode')
    .in('id', meetingIds);
  if (meetingsError) unreadable('listClientMeetingNotes.meetings', meetingsError);
  const meetingById = new Map((meetings ?? []).map((m) => [m.id, m]));

  return rows.map((r) => {
    const meeting = meetingById.get(r.meeting_id);
    return {
      id: r.id,
      meetingId: r.meeting_id,
      leadId: r.lead_id,
      kind: r.kind as 'notes' | 'summary',
      visibility: r.visibility,
      body: r.body,
      artifactRef: r.artifact_ref,
      uploadedAt: r.uploaded_at,
      meetingStatus: meeting?.status ?? 'unknown',
      meetingOutcome: meeting?.outcome ?? null,
      meetingAt: meeting?.confirmed_start_at ?? meeting?.requested_start_at ?? null,
      meetingMode: meeting?.booked_mode ?? meeting?.requested_mode ?? null,
    };
  });
}

export type UnansweredReply = {
  conversationId: string;
  title: string | null;
  kind: string;
  unread: number;
  latestAt: string;
  latestBody: string | null;
  projectId: string | null;
  leadId: string | null;
};

/**
 * SCR-003's "client responses": every conversation whose newest messages are
 * inbound (the same derivation as `readClientUnreadReplies`, portfolio-wide
 * rather than per client). Reads the newest messages RLS lets the caller see;
 * a failed read throws, it never renders as "no replies".
 */
export async function listUnansweredClientReplies(limit = 20): Promise<UnansweredReply[]> {
  const supabase = await createClient();
  const { data: messages, error } = await supabase
    .schema('crm')
    .from('conversation_messages')
    .select('conversation_id, body, occurred_at, metadata')
    .order('occurred_at', { ascending: false })
    .limit(UNREAD_SCAN_LIMIT);
  if (error) unreadable('listUnansweredClientReplies.messages', error);

  const state = new Map<string, { unread: number; closed: boolean; latestAt: string; latestBody: string | null }>();
  for (const m of messages ?? []) {
    const entry = state.get(m.conversation_id) ?? { unread: 0, closed: false, latestAt: m.occurred_at, latestBody: m.body };
    if (!entry.closed) {
      const direction = directionOf(m.metadata);
      if (direction === 'outbound') entry.closed = true;
      else if (direction === 'inbound') {
        entry.unread += 1;
        if (entry.unread === 1) {
          entry.latestAt = m.occurred_at;
          entry.latestBody = m.body;
        }
      }
    }
    state.set(m.conversation_id, entry);
  }
  const open = [...state.entries()].filter(([, e]) => e.unread > 0).sort((a, b) => b[1].latestAt.localeCompare(a[1].latestAt)).slice(0, limit);
  if (open.length === 0) return [];

  const { data: conversations, error: convError } = await supabase
    .schema('crm')
    .from('conversations')
    .select('id, title, kind, project_id, lead_id, status')
    .in('id', open.map(([id]) => id))
    .neq('status', 'abandoned');
  if (convError) unreadable('listUnansweredClientReplies.conversations', convError);
  const byId = new Map((conversations ?? []).map((c) => [c.id, c]));
  return open.flatMap(([id, e]) => {
    const c = byId.get(id);
    if (!c) return [];
    return [{ conversationId: id, title: c.title, kind: c.kind, unread: e.unread, latestAt: e.latestAt, latestBody: e.latestBody, projectId: c.project_id ?? null, leadId: c.lead_id ?? null }];
  });
}
