/**
 * The project Communication tab — pure helpers (no I/O).
 *
 * The tab reads the conversations the project already has (its WhatsApp
 * group, and the client's own thread) and the messages in them. Nothing is
 * classified that the data does not say: a conversation is CLIENT-facing when
 * a client is on it (the project group, the client thread) and INTERNAL when
 * it is the agency's own group; "unread" is never claimed, "waiting on you"
 * is — a thread whose newest message is the client's and has no answer.
 */

export type ConversationKind = 'direct' | 'project_group' | 'internal_group' | 'internal_direct' | 'client_account';
export type ThreadTab = 'all' | 'client' | 'internal' | 'waiting';

export type ThreadRow = {
  id: string;
  kind: ConversationKind;
  title: string;
  channel: string;
  messages: number;
  lastAt: string | null;
  lastPreview: string | null;
  /** 'client' | 'user' | 'agent' | 'system' — who wrote the newest message. */
  lastAuthor: string | null;
};

export function tabOf(kind: ConversationKind): 'client' | 'internal' {
  return kind === 'internal_group' || kind === 'internal_direct' ? 'internal' : 'client';
}

/** A thread is waiting on the agency when the client spoke last. */
export function isWaiting(t: Pick<ThreadRow, 'lastAuthor'>): boolean {
  return t.lastAuthor === 'client';
}

export function filterThreads(threads: readonly ThreadRow[], tab: ThreadTab, q: string): ThreadRow[] {
  const needle = q.trim().toLowerCase();
  return threads.filter((t) => {
    if (tab === 'waiting' ? !isWaiting(t) : tab !== 'all' && tabOf(t.kind) !== tab) return false;
    return needle === '' || `${t.title} ${t.lastPreview ?? ''}`.toLowerCase().includes(needle);
  });
}

/** Newest activity first; a thread with no message sinks. */
export function sortThreads<T extends { lastAt: string | null }>(threads: readonly T[]): T[] {
  return [...threads].sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
}

export function conversationTitle(row: { kind: ConversationKind; title: string | null }, names: { project: string; client: string | null }): string {
  if (row.title?.trim()) return row.title.trim();
  if (row.kind === 'project_group') return `${names.project} — project group`;
  if (row.kind === 'client_account') return names.client ? `${names.client} — client thread` : 'Client thread';
  if (row.kind === 'internal_group') return 'Internal team group';
  return 'Conversation';
}

export type MessageCounts = { total: number; thisWeek: number; client: number; team: number };

/** Whole-thread figures from the messages' author types and dates. */
export function messageCounts(rows: readonly { author_type: string; occurred_at: string }[], now: number): MessageCounts {
  const weekAgo = now - 7 * 86_400_000;
  return {
    total: rows.length,
    thisWeek: rows.filter((r) => new Date(r.occurred_at).getTime() >= weekAgo).length,
    client: rows.filter((r) => r.author_type === 'client').length,
    team: rows.filter((r) => r.author_type === 'user' || r.author_type === 'agent').length,
  };
}

export function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%';
}

/** The last line of a message for a list: its text, or what kind of file it was. */
export function previewOf(body: string, mediaType: unknown): string {
  const text = body.replace(/\s+/g, ' ').trim();
  if (text) return text.length > 90 ? `${text.slice(0, 87)}…` : text;
  return typeof mediaType === 'string' && mediaType ? `[${mediaType}]` : '';
}
