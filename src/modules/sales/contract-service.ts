import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

import {
  createContractSchema,
  updateContractStatusSchema,
  type ContractStatus,
  type CreateContractInput,
  type UpdateContractStatusInput,
} from './contract-schema';

export type ContractRow = {
  id: string;
  opportunityId: string;
  dealName: string;
  leadId: string | null;
  clientAccountId: string | null;
  clientName: string | null;
  title: string;
  fileUrl: string | null;
  signerName: string | null;
  signedOn: string | null;
  status: ContractStatus;
  createdAt: string;
};

const asStatus = (s: string): ContractStatus => (s === 'sent' || s === 'signed' ? s : 'draft');

/**
 * Contracts, newest first — every internal role reads (RLS decides). Optional
 * narrowing to one deal or one client (the lists on the deal and the client).
 * A failed read refuses; it never renders as "no contracts".
 */
export async function listContracts(filter: { opportunityIds?: readonly string[]; clientAccountId?: string } = {}): Promise<ContractRow[]> {
  const supabase = await createClient();
  let query = supabase
    .schema('sales')
    .from('contracts')
    .select('id, opportunity_id, client_account_id, title, file_url, signer_name, signed_on, status, created_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (filter.opportunityIds) {
    if (filter.opportunityIds.length === 0) return [];
    query = query.in('opportunity_id', [...filter.opportunityIds]);
  }
  const { data, error } = await query;
  if (error) unreadable('listContracts', error);
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const oppIds = [...new Set(rows.map((r) => r.opportunity_id))];
  const { data: opps, error: oppError } = await supabase.schema('sales').from('opportunities').select('id, name, lead_id, client_account_id').in('id', oppIds);
  if (oppError) unreadable('listContracts.deals', oppError);
  const oppById = new Map((opps ?? []).map((o) => [o.id, o]));

  // The contract remembers its client from the moment it was written; a deal
  // converted afterwards names its client on the deal, which fills the gap.
  const clientIds = [...new Set(rows.map((r) => r.client_account_id ?? oppById.get(r.opportunity_id)?.client_account_id).filter((id): id is string => Boolean(id)))];
  const { data: clients, error: clientError } =
    clientIds.length > 0
      ? await supabase.schema('core').from('client_accounts').select('id, name').in('id', clientIds)
      : { data: [] as { id: string; name: string }[], error: null };
  if (clientError) unreadable('listContracts.clients', clientError);
  const clientName = new Map((clients ?? []).map((c) => [c.id, c.name]));

  const out = rows.map((r): ContractRow => {
    const opp = oppById.get(r.opportunity_id);
    const clientId = r.client_account_id ?? opp?.client_account_id ?? null;
    return {
      id: r.id,
      opportunityId: r.opportunity_id,
      dealName: opp?.name ?? 'Deal',
      leadId: opp?.lead_id ?? null,
      clientAccountId: clientId,
      clientName: clientId ? (clientName.get(clientId) ?? null) : null,
      title: r.title,
      fileUrl: r.file_url,
      signerName: r.signer_name,
      signedOn: r.signed_on,
      status: asStatus(r.status),
      createdAt: r.created_at,
    };
  });
  return filter.clientAccountId ? out.filter((c) => c.clientAccountId === filter.clientAccountId) : out;
}

/** Won deals a contract can be recorded on — the picker on the Contracts screen. */
export async function listWonDeals(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('sales').from('opportunities').select('id, name').eq('stage', 'won').order('closed_at', { ascending: false }).limit(200);
  if (error) unreadable('listWonDeals', error);
  return data ?? [];
}

const CREATE_REFUSALS: Record<string, [Parameters<typeof err>[0], string]> = {
  no_actor: ['FORBIDDEN', 'Sign in again to record a contract.'],
  not_authorized: ['FORBIDDEN', 'Only an owner or ops admin can record a contract.'],
  not_found: ['NOT_FOUND', 'Deal not found.'],
  not_won: ['CONFLICT', 'Only a won deal can have a contract.'],
  invalid_title: ['VALIDATION', 'A contract needs a title of up to 200 characters.'],
  invalid_url: ['VALIDATION', 'Paste a full link starting with https://'],
  invalid_status: ['VALIDATION', 'A contract is draft, sent or signed.'],
  invalid_signature: ['VALIDATION', 'A signed contract names who signed it and the day (not in the future); other statuses carry no signed date.'],
};

export async function createContract(input: CreateContractInput): Promise<Result<{ contractId: string }>> {
  const parsed = createContractSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid contract.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }
  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'You do not have permission to record a contract.');

  const v = parsed.data;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('sales').rpc('create_contract', {
    p_opportunity_id: v.opportunityId,
    p_title: v.title,
    ...(v.fileUrl ? { p_file_url: v.fileUrl } : {}),
    ...(v.signerName ? { p_signer_name: v.signerName } : {}),
    ...(v.signedOn ? { p_signed_on: v.signedOn } : {}),
    p_status: v.status,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'createContract', detail: error.message }));
    return err('INTERNAL', 'Could not record the contract.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; contract_id?: string | null } | undefined;
  if (row?.outcome === 'created' && row.contract_id) return ok({ contractId: row.contract_id });
  const refusal = CREATE_REFUSALS[row?.outcome ?? ''];
  return refusal ? err(refusal[0], refusal[1]) : err('INTERNAL', 'Could not record the contract.');
}

const UPDATE_REFUSALS: Record<string, [Parameters<typeof err>[0], string]> = {
  no_actor: ['FORBIDDEN', 'Sign in again to change a contract.'],
  not_authorized: ['FORBIDDEN', 'Only an owner or ops admin can change a contract.'],
  not_found: ['NOT_FOUND', 'Contract not found.'],
  invalid_status: ['VALIDATION', 'A contract is draft, sent or signed.'],
  invalid_transition: ['CONFLICT', 'That move is not allowed: a signed contract is a record and does not change.'],
  invalid_signature: ['VALIDATION', 'A signed contract names who signed it and the day (not in the future); other statuses carry no signed date.'],
  invalid_url: ['VALIDATION', 'Paste a full link starting with https://'],
};

export async function updateContractStatus(input: UpdateContractStatusInput): Promise<Result<{ status: ContractStatus; unchanged: boolean }>> {
  const parsed = updateContractStatusSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid contract.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }
  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'You do not have permission to change a contract.');

  const v = parsed.data;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('sales').rpc('update_contract_status', {
    p_contract_id: v.contractId,
    p_status: v.status,
    ...(v.signerName ? { p_signer_name: v.signerName } : {}),
    ...(v.signedOn ? { p_signed_on: v.signedOn } : {}),
    ...(v.fileUrl ? { p_file_url: v.fileUrl } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'updateContractStatus', detail: error.message }));
    return err('INTERNAL', 'Could not change the contract.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  if (row?.outcome === 'updated') return ok({ status: v.status, unchanged: false });
  if (row?.outcome === 'unchanged') return ok({ status: v.status, unchanged: true });
  const refusal = UPDATE_REFUSALS[row?.outcome ?? ''];
  return refusal ? err(refusal[0], refusal[1]) : err('INTERNAL', 'Could not change the contract.');
}
