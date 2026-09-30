import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';
import { deliveryOf } from '@/modules/crm/types';

import { conversationTitle, previewOf, sortThreads, type ConversationKind, type MessageCounts, type ThreadRow } from './project-communication';

/**
 * The project Discussion tab's reads — the conversations a project has
 * (its WhatsApp group, and its client's own thread), each with its newest
 * message, and the queries a project has open. RLS is the boundary: every
 * read runs as the signed-in person. Counts are exact head counts over the
 * project's conversation ids, never a sample.
 */
export async function readProjectThreads(projectId: string, clientAccountId: string | null, names: { project: string; client: string | null }): Promise<ThreadRow[]> {
  const supabase = await createClient();
  const byProject = supabase.schema('crm').from('conversations').select('id, kind, title, channel').eq('project_id', projectId).neq('status', 'abandoned');
  const byClient = clientAccountId
    ? supabase.schema('crm').from('conversations').select('id, kind, title, channel').eq('client_account_id', clientAccountId).eq('kind', 'client_account').neq('status', 'abandoned')
    : Promise.resolve({ data: [], error: null });
  const [a, b] = await Promise.all([byProject, byClient]);
  if (a.error) unreadable('readProjectThreads.project', a.error);
  if (b.error) unreadable('readProjectThreads.client', b.error);
  const convs = [...(a.data ?? []), ...(b.data ?? [])].filter((c, i, all) => all.findIndex((x) => x.id === c.id) === i);

  const rows = await Promise.all(
    convs.map(async (c): Promise<ThreadRow> => {
      const [last, count] = await Promise.all([
        supabase.schema('crm').from('conversation_messages').select('body, author_type, occurred_at, metadata').eq('conversation_id', c.id).order('seq', { ascending: false }).limit(1).maybeSingle(),
        supabase.schema('crm').from('conversation_messages').select('id', { count: 'exact', head: true }).eq('conversation_id', c.id),
      ]);
      if (last.error) unreadable('readProjectThreads.last', last.error);
      if (count.error) unreadable('readProjectThreads.count', count.error);
      const meta = (last.data?.metadata ?? {}) as Record<string, unknown>;
      return {
        id: c.id,
        kind: c.kind as ConversationKind,
        title: conversationTitle({ kind: c.kind as ConversationKind, title: c.title }, names),
        channel: c.channel,
        messages: count.count ?? 0,
        lastAt: last.data?.occurred_at ?? null,
        lastPreview: last.data ? previewOf(last.data.body, meta.media_type) : null,
        lastAuthor: last.data?.author_type ?? null,
      };
    }),
  );
  return sortThreads(rows);
}

/** Exact counts over all the project's conversations. */
export async function readProjectMessageCounts(conversationIds: readonly string[], now: number): Promise<MessageCounts> {
  if (conversationIds.length === 0) return { total: 0, thisWeek: 0, client: 0, team: 0 };
  const supabase = await createClient();
  const weekAgo = new Date(now - 7 * 86_400_000).toISOString();
  const head = () => supabase.schema('crm').from('conversation_messages').select('id', { count: 'exact', head: true }).in('conversation_id', conversationIds as string[]);
  const [total, week, client, team] = await Promise.all([head(), head().gte('occurred_at', weekAgo), head().eq('author_type', 'client'), head().in('author_type', ['user', 'agent'])]);
  for (const r of [total, week, client, team]) if (r.error) unreadable('readProjectMessageCounts', r.error);
  return { total: total.count ?? 0, thisWeek: week.count ?? 0, client: client.count ?? 0, team: team.count ?? 0 };
}

/**
 * Questions the project has asked and not had answered / has had answered:
 * the PM agent's clarification requests and the plan's clarifications.
 */
export async function readProjectQueries(projectId: string): Promise<{ open: number; resolved: number }> {
  const supabase = await createClient();
  const plans = await supabase.schema('projects').from('project_plans').select('id').eq('project_id', projectId);
  if (plans.error) unreadable('readProjectQueries.plans', plans.error);
  const planIds = (plans.data ?? []).map((p) => p.id);
  const count = (table: 'clarification_requests' | 'plan_clarifications', filter: (q: any) => any) => // eslint-disable-line @typescript-eslint/no-explicit-any
    filter(supabase.schema('projects').from(table).select('id', { count: 'exact', head: true }));
  const [reqOpen, reqDone, planOpen, planDone] = await Promise.all([
    count('clarification_requests', (q) => q.eq('project_id', projectId).eq('status', 'open')),
    count('clarification_requests', (q) => q.eq('project_id', projectId).eq('status', 'answered')),
    planIds.length > 0 ? count('plan_clarifications', (q) => q.in('plan_id', planIds).eq('status', 'asked')) : Promise.resolve({ count: 0, error: null }),
    planIds.length > 0 ? count('plan_clarifications', (q) => q.in('plan_id', planIds).in('status', ['answered', 'resolved', 'routed_to_change_request'])) : Promise.resolve({ count: 0, error: null }),
  ]);
  for (const r of [reqOpen, reqDone, planOpen, planDone]) if (r.error) unreadable('readProjectQueries', r.error);
  return { open: (reqOpen.count ?? 0) + (planOpen.count ?? 0), resolved: (reqDone.count ?? 0) + (planDone.count ?? 0) };
}

export type ThreadMessage = {
  id: string;
  authorType: string;
  authorName: string | null;
  body: string;
  occurredAt: string;
  incoming: boolean;
  delivery: 'pending' | 'sent' | 'failed' | null;
  wire: 'sent' | 'delivered' | 'read' | 'failed' | null;
  mediaKind: ReturnType<typeof deliveryOf>['mediaKind'];
  caption: string | null;
  mediaDescription: string | null;
};

/** The newest `limit` messages of one conversation, oldest first, with the names of the staff who wrote them. */
export async function readThreadMessages(conversationId: string, limit = 200): Promise<ThreadMessage[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('conversation_messages')
    .select('id, author_type, author_id, body, occurred_at, metadata, media_description')
    .eq('conversation_id', conversationId)
    .order('seq', { ascending: false })
    .limit(limit);
  if (error) unreadable('readThreadMessages', error);
  const rows = [...(data ?? [])].reverse();
  const authorIds = [...new Set(rows.map((r) => r.author_id).filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (authorIds.length > 0) {
    const users = await supabase.schema('core').from('users').select('id, full_name, email').in('id', authorIds);
    if (users.error) unreadable('readThreadMessages.authors', users.error);
    for (const u of users.data ?? []) names.set(u.id, u.full_name ?? u.email ?? 'Someone on the team');
  }
  return rows.map((r) => {
    const d = deliveryOf(r.metadata);
    return {
      id: r.id,
      authorType: r.author_type,
      authorName: r.author_type === 'agent' ? 'AgencyOS agent' : r.author_id ? (names.get(r.author_id) ?? null) : null,
      body: r.body,
      occurredAt: r.occurred_at,
      incoming: d.direction === 'inbound' || (d.direction === null && r.author_type === 'client'),
      delivery: d.delivery,
      wire: d.wire,
      mediaKind: d.mediaKind,
      caption: d.caption,
      mediaDescription: r.media_description,
    };
  });
}
