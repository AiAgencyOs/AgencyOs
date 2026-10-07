import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The delivered handover, as the client sees it (P707 §9, P708 §5, P711 §9). Every read is a database function: the function decides what a client may see
 * (only the current DELIVERED version, only its ready items, access RECEIPTS with no reference value, the acceptance state), and nothing here widens it.
 * A failed read is `unreadable`, never "nothing delivered yet".
 */

type Row = Record<string, unknown>;
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

async function projectsRpc(): Promise<Rpc> {
  const supabase = await createClient();
  return (fn, args) => (supabase.schema('projects') as unknown as { rpc: Rpc }).rpc(fn, args);
}

const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export type ClientHandoverOverview = {
  packageId: string;
  version: number;
  deliveredAt: string | null;
  productionUrl: string | null;
  supportTerms: string | null;
  warrantyEndsOn: string | null;
  emergencyContacts: string | null;
  /** awaiting | accepted | changes_requested | disputed | not_required */
  acceptanceState: string;
  decisionRecordedAt: string | null;
  /** none | awaiting_confirmation: a request the client made that a person has not yet confirmed. */
  requestState: string;
  /** open | read_only | expired */
  portalAccess: string;
  projectCompleted: boolean;
};
export type ClientHandoverItem = { kind: string; label: string; artifactRef: string | null; required: boolean };
export type ClientAccessReceipt = { systemName: string; kind: string; method: string; status: string; fromParty: string | null; toParty: string | null; credentialsRotated: boolean; supportAccessRetained: boolean };
export type ClientCompletedState = { lifecycle: string; portalAccess: string; completedAt: string | null; archivedAt: string | null; acceptedVersion: number | null; acceptedAt: string | null };

export async function readClientHandoverOverview(projectId: string): Promise<ClientHandoverOverview | null> {
  const rpc = await projectsRpc();
  const { data, error } = await rpc('client_handover_overview', { p_project_id: projectId });
  if (error) unreadable('readClientHandoverOverview', error);
  const r = rows(data)[0];
  if (!r) return null;
  return {
    packageId: String(r.package_id),
    version: Number(r.version),
    deliveredAt: str(r.delivered_at),
    productionUrl: str(r.production_url),
    supportTerms: str(r.support_terms),
    warrantyEndsOn: str(r.warranty_ends_on),
    emergencyContacts: str(r.emergency_contacts),
    acceptanceState: String(r.acceptance_state),
    decisionRecordedAt: str(r.decision_recorded_at),
    requestState: String(r.request_state),
    portalAccess: String(r.portal_access),
    projectCompleted: r.project_completed === true,
  };
}

export async function readClientHandoverItems(projectId: string): Promise<ClientHandoverItem[]> {
  const rpc = await projectsRpc();
  const { data, error } = await rpc('client_handover_items', { p_project_id: projectId });
  if (error) unreadable('readClientHandoverItems', error);
  return rows(data).map((r) => ({ kind: String(r.kind), label: String(r.label), artifactRef: str(r.artifact_ref), required: r.required === true }));
}

export async function readClientAccessReceipts(projectId: string): Promise<ClientAccessReceipt[]> {
  const rpc = await projectsRpc();
  const { data, error } = await rpc('client_handover_access_receipts', { p_project_id: projectId });
  if (error) unreadable('readClientAccessReceipts', error);
  return rows(data).map((r) => ({
    systemName: String(r.system_name),
    kind: String(r.kind),
    method: String(r.method),
    status: String(r.status),
    fromParty: str(r.from_party),
    toParty: str(r.to_party),
    credentialsRotated: r.credentials_rotated === true,
    supportAccessRetained: r.support_access_retained === true,
  }));
}

export async function readClientCompletedState(projectId: string): Promise<ClientCompletedState | null> {
  const rpc = await projectsRpc();
  const { data, error } = await rpc('client_completed_state', { p_project_id: projectId });
  if (error) unreadable('readClientCompletedState', error);
  const r = rows(data)[0];
  if (!r) return null;
  return {
    lifecycle: String(r.lifecycle),
    portalAccess: String(r.portal_access),
    completedAt: str(r.completed_at),
    archivedAt: str(r.archived_at),
    acceptedVersion: typeof r.accepted_version === 'number' ? r.accepted_version : null,
    acceptedAt: str(r.accepted_at),
  };
}

/** The four reads for the handover page, each guarded by its own reader (a failed read throws; it is never an empty page). */
export async function readClientHandover(projectId: string): Promise<{ overview: ClientHandoverOverview | null; items: ClientHandoverItem[]; receipts: ClientAccessReceipt[]; state: ClientCompletedState | null }> {
  const state = await readClientCompletedState(projectId);
  const overview = await readClientHandoverOverview(projectId);
  const items = overview ? await readClientHandoverItems(projectId) : [];
  const receipts = overview ? await readClientAccessReceipts(projectId) : [];
  return { overview, items, receipts, state };
}
