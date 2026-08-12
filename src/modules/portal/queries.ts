import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type {
  ClientDeliverable,
  ClientHandover,
  ClientInvoice,
  ClientModule,
  ClientProject,
  ClientProjectDetail,
} from './types';

/**
 * Reads for the client portal — gap G-057.
 *
 * Every one of these is the same query an internal page would run. There is no
 * `client_account_id` predicate anywhere in this file, and that is deliberate:
 * the scoping is RLS's, proved by `scripts/verify-client-portal.mjs` against a
 * real database. A predicate here would be a second copy of the rule that
 * could drift from the first, and the copy in the database is the one that
 * runs when somebody calls the API directly.
 *
 * What that proof established, and what these pages therefore rely on:
 * a project marked `internal` is invisible along with everything under it, a
 * draft deliverable is invisible until it is put in front of the client, a
 * handover appears only once delivered, and another account's work is not
 * there at all.
 */

export async function listClientProjects(): Promise<ClientProject[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name, status, created_at')
    .order('created_at', { ascending: false });

  if (error) unreadable('listClientProjects', error);

  return data ?? [];
}

/**
 * One read per function, and each one guards its own `error`.
 *
 * An earlier version fetched the three child collections in one `Promise.all`
 * and checked `modules.error`, `deliverables.error`, `handover.error`. That
 * reads fine and it broke the repository's own sweep in
 * `tests/read-failure-semantics.test.ts`, which counts plain unqualified
 * error guards against refusals — a qualified one is invisible to it, so a file
 * could stop refusing and nothing would notice. Splitting them is the
 * conforming shape and the clearer one.
 */
async function readProjectRow(projectId: string): Promise<ClientProject | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name, status, created_at')
    .eq('id', projectId)
    .maybeSingle();

  if (error) unreadable('readClientProject', error);

  return data ?? null;
}

async function readModules(projectId: string): Promise<ClientModule[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('modules')
    .select('id, name, status, position')
    .eq('project_id', projectId)
    .order('position', { ascending: true });

  if (error) unreadable('readClientProject.modules', error);

  return data ?? [];
}

async function readSharedDeliverables(projectId: string): Promise<ClientDeliverable[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('deliverables')
    .select('id, kind, version, title, artifact_url, changelog, known_issues, test_access_method, status, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (error) unreadable('readClientProject.deliverables', error);

  return data ?? [];
}

async function readHandover(projectId: string): Promise<ClientHandover | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('handovers')
    .select('id, status, summary, delivered_at, accepted_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) unreadable('readClientProject.handover', error);

  return data ?? null;
}

export async function readClientProject(projectId: string): Promise<ClientProjectDetail | null> {
  const project = await readProjectRow(projectId);

  // Absent means RLS did not return it: not theirs, or not shared. The page
  // turns that into notFound() rather than a message that would confirm it
  // exists somewhere.
  if (!project) return null;

  const [modules, deliverables, handover] = await Promise.all([
    readModules(projectId),
    readSharedDeliverables(projectId),
    readHandover(projectId),
  ]);

  return { ...project, modules, deliverables, handover };
}

/**
 * Their bills.
 *
 * `invoices_select` has admitted client roles to non-draft invoices since the
 * schema was written, and nothing has ever shown them one. This is that.
 */
export async function listClientInvoices(): Promise<ClientInvoice[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('finance')
    .from('invoices')
    .select('id, number, status, currency, total_minor, paid_minor, due_at, issued_at, project_id')
    .order('issued_at', { ascending: false });

  if (error) unreadable('listClientInvoices', error);

  return data ?? [];
}
