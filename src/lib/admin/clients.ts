import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * `core.client_accounts` has no owning module (ARCHITECTURE.md §2 — core
 * tables with no business module of their own are read directly, the same
 * way finance/queries.ts reads client_accounts for an invoice's billed name
 * and settings/page.tsx reads organizations). This file is that direct read
 * for the Admin Panel's own Clients screen — the PDF's Clients module (§014-017)
 * had no route at all before this: a client existed only implicitly inside
 * leads, projects and invoices.
 *
 * Rollups (project/invoice counts and totals) are computed here from the
 * owning modules' own tables rather than duplicated as columns on
 * client_accounts, so this can never disagree with what /projects or
 * /invoices already show. No cross-schema embed (PostgREST cannot resolve
 * one — PGRST200): three reads, joined in memory by client_account_id.
 */

export type ClientListItem = {
  id: string;
  name: string;
  billingEmail: string | null;
  currency: string;
  status: 'active' | 'archived';
  createdAt: string;
  projectsActive: number;
  projectsTotal: number;
  invoicedMinor: number;
  paidMinor: number;
  outstandingMinor: number;
};

export type ClientFile = {
  id: string;
  projectId: string;
  projectName: string;
  category: string;
  title: string;
  url: string;
};

export type ClientMessage = {
  id: string;
  seq: number;
  authorType: string;
  body: string | null;
  occurredAt: string;
  direction: 'inbound' | 'outbound' | null;
};

export type ClientCommunicationThread = {
  projectId: string;
  projectName: string;
  conversationId: string;
  title: string | null;
  messages: ClientMessage[];
};

export type ClientDetail = ClientListItem & {
  projects: { id: string; name: string; status: string; budgetMinor: number | null; currency: string }[];
  invoices: { id: string; number: string; status: string; totalMinor: number; paidMinor: number; currency: string }[];
  files: ClientFile[];
  communication: ClientCommunicationThread[];
};

/** How many of a project group's most recent messages the client page previews. */
const COMMUNICATION_PREVIEW_LIMIT = 20;

/**
 * Just the `direction` axis of `crm/types.ts`'s `deliveryOf` — that helper
 * cannot be imported here (`lib/` must not depend on `modules/`,
 * ARCHITECTURE.md §3.2), and duplicating the whole thing for one field this
 * file does not need (delivery/wire/media) would be worse than this.
 */
function directionOf(metadata: unknown): 'inbound' | 'outbound' | null {
  const d = (metadata as Record<string, unknown> | null)?.direction;
  return d === 'inbound' || d === 'outbound' ? d : null;
}

const ACTIVE_PROJECT_STATUSES = new Set(['planning', 'active', 'on_hold']);

export async function listClients(limit = 200): Promise<ClientListItem[]> {
  const supabase = await createClient();

  const { data: accounts, error: accountsError } = await supabase
    .schema('core')
    .from('client_accounts')
    .select('id, name, billing_email, currency, status, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (accountsError) unreadable('listClients.accounts', accountsError);
  const accountRows = accounts ?? [];
  if (accountRows.length === 0) return [];

  const ids = accountRows.map((a) => a.id);

  const { data: projects, error: projectsError } = await supabase
    .schema('projects')
    .from('projects')
    .select('client_account_id, status')
    .in('client_account_id', ids)
    .is('deleted_at', null);
  if (projectsError) unreadable('listClients.projects', projectsError);

  const { data: invoices, error: invoicesError } = await supabase
    .schema('finance')
    .from('invoices')
    .select('client_account_id, total_minor, paid_minor')
    .in('client_account_id', ids);
  if (invoicesError) unreadable('listClients.invoices', invoicesError);

  return accountRows.map((a) => {
    const clientProjects = (projects ?? []).filter((p) => p.client_account_id === a.id);
    const clientInvoices = (invoices ?? []).filter((i) => i.client_account_id === a.id);
    const invoicedMinor = clientInvoices.reduce((sum, i) => sum + i.total_minor, 0);
    const paidMinor = clientInvoices.reduce((sum, i) => sum + i.paid_minor, 0);
    return {
      id: a.id,
      name: a.name,
      billingEmail: a.billing_email,
      currency: a.currency,
      status: a.status as 'active' | 'archived',
      createdAt: a.created_at,
      projectsActive: clientProjects.filter((p) => ACTIVE_PROJECT_STATUSES.has(p.status)).length,
      projectsTotal: clientProjects.length,
      invoicedMinor,
      paidMinor,
      outstandingMinor: invoicedMinor - paidMinor,
    };
  });
}

export async function getClient(clientAccountId: string): Promise<ClientDetail | null> {
  const supabase = await createClient();

  const { data: account, error: accountError } = await supabase
    .schema('core')
    .from('client_accounts')
    .select('id, name, billing_email, currency, status, created_at')
    .eq('id', clientAccountId)
    .maybeSingle();
  if (accountError) unreadable('getClient.account', accountError);
  if (!account) return null;

  const { data: projects, error: projectsError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name, status, budget_minor, currency')
    .eq('client_account_id', clientAccountId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (projectsError) unreadable('getClient.projects', projectsError);

  const { data: invoices, error: invoicesError } = await supabase
    .schema('finance')
    .from('invoices')
    .select('id, number, status, total_minor, paid_minor, currency')
    .eq('client_account_id', clientAccountId)
    .order('created_at', { ascending: false });
  if (invoicesError) unreadable('getClient.invoices', invoicesError);

  const projectRows = projects ?? [];
  const invoiceRows = invoices ?? [];
  const invoicedMinor = invoiceRows.reduce((sum, i) => sum + i.total_minor, 0);
  const paidMinor = invoiceRows.reduce((sum, i) => sum + i.paid_minor, 0);

  // SCR-017's files half — rolled up here rather than duplicated as a
  // client-scoped table, the same "read from the owning module" rule the
  // rest of this file follows. A client has no files of its own; it has
  // projects, and projects have files (`projects.project_files`, SCR-024).
  const projectIds = projectRows.map((p) => p.id);
  const projectNameById = new Map(projectRows.map((p) => [p.id, p.name]));
  let fileRows: ClientFile[] = [];
  if (projectIds.length > 0) {
    const { data: files, error: filesError } = await supabase
      .schema('projects')
      .from('project_files')
      .select('id, project_id, category, title, url')
      .in('project_id', projectIds)
      .order('created_at', { ascending: false });
    if (filesError) unreadable('getClient.files', filesError);
    fileRows = (files ?? []).map((f) => ({
      id: f.id,
      projectId: f.project_id,
      projectName: projectNameById.get(f.project_id) ?? 'Unknown project',
      category: f.category,
      title: f.title,
      url: f.url,
    }));
  }

  // SCR-017's communication half. A client has no thread of its own; each of
  // its projects has at most one, `crm.conversations` where
  // `kind = 'project_group'` (`conversations_kind_shape`), the same "read
  // from the owning module" rule `files` above follows. Deliberately NOT the
  // client's pre-conversion lead history — `crm.conversations.lead_id` is
  // null for a project_group, so there is no ambiguous trace through
  // `sales.opportunities` to get wrong; this is the client's own ongoing
  // project channel, the direct analogue of the Files card.
  let communication: ClientCommunicationThread[] = [];
  if (projectIds.length > 0) {
    const { data: groups, error: groupsError } = await supabase
      .schema('crm')
      .from('conversations')
      .select('id, project_id, title')
      .in('project_id', projectIds)
      .eq('kind', 'project_group')
      .neq('status', 'abandoned');
    if (groupsError) unreadable('getClient.communicationGroups', groupsError);

    const groupRows = groups ?? [];
    if (groupRows.length > 0) {
      const conversationIds = groupRows.map((g) => g.id);
      const { data: messages, error: messagesError } = await supabase
        .schema('crm')
        .from('conversation_messages')
        .select('id, conversation_id, seq, author_type, body, occurred_at, metadata')
        .in('conversation_id', conversationIds)
        .order('seq', { ascending: false });
      if (messagesError) unreadable('getClient.communicationMessages', messagesError);

      const messagesByConversation = new Map<string, ClientMessage[]>();
      for (const m of messages ?? []) {
        const list = messagesByConversation.get(m.conversation_id) ?? [];
        if (list.length < COMMUNICATION_PREVIEW_LIMIT) {
          list.push({
            id: m.id,
            seq: m.seq,
            authorType: m.author_type,
            body: m.body,
            occurredAt: m.occurred_at,
            direction: directionOf(m.metadata),
          });
          messagesByConversation.set(m.conversation_id, list);
        }
      }

      // project_id is nullable on the table (null for a direct/internal_group
      // thread) but `conversations_kind_shape` requires it for every
      // project_group row, which is the only kind this query fetches.
      communication = groupRows
        .filter((g): g is typeof g & { project_id: string } => g.project_id !== null)
        .map((g) => ({
          projectId: g.project_id,
          projectName: projectNameById.get(g.project_id) ?? 'Unknown project',
          conversationId: g.id,
          title: g.title,
          // Oldest first for reading, newest-first is only how they were fetched.
          messages: (messagesByConversation.get(g.id) ?? []).slice().reverse(),
        }));
    }
  }

  return {
    id: account.id,
    name: account.name,
    billingEmail: account.billing_email,
    currency: account.currency,
    status: account.status as 'active' | 'archived',
    createdAt: account.created_at,
    projectsActive: projectRows.filter((p) => ACTIVE_PROJECT_STATUSES.has(p.status)).length,
    projectsTotal: projectRows.length,
    invoicedMinor,
    paidMinor,
    outstandingMinor: invoicedMinor - paidMinor,
    projects: projectRows.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      budgetMinor: p.budget_minor,
      currency: p.currency,
    })),
    invoices: invoiceRows.map((i) => ({
      id: i.id,
      number: i.number,
      status: i.status,
      totalMinor: i.total_minor,
      paidMinor: i.paid_minor,
      currency: i.currency,
    })),
    files: fileRows,
    communication,
  };
}
