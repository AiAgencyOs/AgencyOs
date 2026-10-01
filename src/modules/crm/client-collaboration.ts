import { isAnalysisNote, parseAnalysisSections } from './analysis-sections';

/**
 * SCR-017 — what the client's collaboration record says at a glance, and the
 * one feed it keeps. Pure functions over rows the Client 360 already reads,
 * so each sentence can be tested with real inputs.
 *
 * Nothing here is invented: a count is a count of stored rows, a decision or
 * an open question is read back out of an analysis note by the headings its
 * renderer owns (`analysis-sections.ts`), and an analysis note is inference,
 * so it is counted as "proposed" and never as agreed.
 */

export type MeetingNoteInput = { id: string; meetingId: string; kind: string; body: string | null; uploadedAt: string; meetingAt: string | null };
export type UploadInput = { id: string; title: string; projectName: string; category: string; uploadedAt: string; uploadedByEmail: string | null; version: number };
export type AnnouncementInput = { id: string; title: string; publishedAt: string | null; projectName: string | null; clientName: string | null };
export type InternalNoteInput = { id: string; body: string; createdAt: string; createdByEmail?: string | null };
export type UnreadThreadInput = { conversationId: string; title: string | null; kind: string; unread: number; latestAt: string; latestBody: string | null };

/** "Meeting decisions/open questions" — counted from the notes the meetings carry. */
export function meetingSignals(notes: readonly Pick<MeetingNoteInput, 'body'>[]): { notes: number; analysed: number; decisions: number; openQuestions: number } {
  let analysed = 0;
  let decisions = 0;
  let openQuestions = 0;
  for (const n of notes) {
    if (!isAnalysisNote(n.body)) continue;
    analysed += 1;
    const sections = parseAnalysisSections(n.body as string);
    decisions += sections.decisions.length;
    openQuestions += sections.openQuestions.length;
  }
  return { notes: notes.length, analysed, decisions, openQuestions };
}

/** "Last announcement" — the newest published one, or null when none was ever published. */
export function lastAnnouncement<T extends Pick<AnnouncementInput, 'publishedAt'>>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (!r.publishedAt) continue;
    if (best === null || (best.publishedAt as string) < r.publishedAt) best = r;
  }
  return best;
}

export type CollaborationKind = 'announcement' | 'upload' | 'meeting_note' | 'internal_note' | 'client_reply';

export type CollaborationEvent = {
  key: string;
  at: string;
  kind: CollaborationKind;
  title: string;
  detail: string | null;
  /** Where it came from — the author or the system that wrote it. */
  by: string | null;
  /** The project or client it is filed against. */
  linkage: string;
  /** Internal items are marked; the client is never sent them. */
  internal: boolean;
};

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const nameOf = (email: string | null | undefined): string | null => (email ? (email.split('@')[0] ?? null) : null);

/** Every collaboration record of one client, newest first, each with its author, time, source and linkage. */
export function collaborationFeed(input: {
  clientName: string;
  announcements: readonly AnnouncementInput[];
  uploads: readonly UploadInput[];
  meetingNotes: readonly MeetingNoteInput[];
  internalNotes: readonly InternalNoteInput[];
  unread: readonly UnreadThreadInput[];
  limit?: number;
}): CollaborationEvent[] {
  const events: CollaborationEvent[] = [];
  for (const a of input.announcements) {
    if (!a.publishedAt) continue;
    events.push({
      key: `announcement-${a.id}`,
      at: a.publishedAt,
      kind: 'announcement',
      title: `Announcement published: ${a.title}`,
      detail: null,
      by: null,
      linkage: a.projectName ? `Project ${a.projectName}` : a.clientName ? input.clientName : 'Agency-wide',
      internal: false,
    });
  }
  for (const u of input.uploads) {
    events.push({
      key: `upload-${u.id}`,
      at: u.uploadedAt,
      kind: 'upload',
      title: `File uploaded: ${u.title}${u.version > 1 ? ` (v${u.version})` : ''}`,
      detail: null,
      by: nameOf(u.uploadedByEmail),
      linkage: `Project ${u.projectName} · ${u.category.replace(/_/g, ' ')}`,
      internal: false,
    });
  }
  for (const m of input.meetingNotes) {
    events.push({
      key: `meeting-note-${m.id}`,
      at: m.uploadedAt,
      kind: 'meeting_note',
      title: isAnalysisNote(m.body) ? 'Meeting analysis recorded (proposed)' : `Meeting ${m.kind} recorded`,
      detail: m.body && !isAnalysisNote(m.body) ? clip(m.body) : null,
      by: null,
      linkage: `${input.clientName} · meeting`,
      internal: false,
    });
  }
  for (const n of input.internalNotes) {
    events.push({
      key: `note-${n.id}`,
      at: n.createdAt,
      kind: 'internal_note',
      title: 'Internal note added',
      detail: clip(n.body),
      by: nameOf(n.createdByEmail),
      linkage: input.clientName,
      internal: true,
    });
  }
  for (const t of input.unread) {
    events.push({
      key: `reply-${t.conversationId}`,
      at: t.latestAt,
      kind: 'client_reply',
      title: `${t.unread} unanswered client repl${t.unread === 1 ? 'y' : 'ies'}`,
      detail: t.latestBody ? clip(t.latestBody) : null,
      by: 'client',
      linkage: t.title ?? t.kind.replace(/_/g, ' '),
      internal: false,
    });
  }
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key.localeCompare(b.key)));
  return events.slice(0, input.limit ?? 40);
}
