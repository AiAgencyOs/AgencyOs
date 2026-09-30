'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { CONTRACT_STATUS_LABEL, CONTRACT_STATUSES, type ContractStatus } from './contract-schema';
import { createContract, updateContractStatus } from './contract-service';

const field = (fd: FormData, k: string) => String(fd.get(k) ?? '');
const asStatus = (v: string): ContractStatus => ((CONTRACT_STATUSES as readonly string[]).includes(v) ? (v as ContractStatus) : 'draft');

function revalidateContracts(leadId: string, clientId: string) {
  revalidatePath('/contracts');
  if (leadId) revalidatePath(`/leads/${leadId}`);
  if (clientId) revalidatePath(`/clients/${clientId}`);
}

/** Sales & CRM › Contracts — record a contract on a won deal (decision 10). */
export async function createContractAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await createContract({
    opportunityId: field(formData, 'opportunityId'),
    title: field(formData, 'title'),
    fileUrl: field(formData, 'fileUrl'),
    signerName: field(formData, 'signerName'),
    signedOn: field(formData, 'signedOn'),
    status: asStatus(field(formData, 'status')),
  });
  if (!result.ok) return { status: 'error', message: result.error.message, ...(result.error.details ? { fieldErrors: result.error.details } : {}) };
  revalidateContracts(field(formData, 'leadId'), field(formData, 'clientId'));
  return { status: 'success', message: 'Contract recorded.' };
}

/** Move a contract draft → sent → signed. */
export async function updateContractStatusAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const status = asStatus(field(formData, 'status'));
  const result = await updateContractStatus({
    contractId: field(formData, 'contractId'),
    status,
    fileUrl: field(formData, 'fileUrl'),
    signerName: field(formData, 'signerName'),
    signedOn: field(formData, 'signedOn'),
  });
  if (!result.ok) return { status: 'error', message: result.error.message, ...(result.error.details ? { fieldErrors: result.error.details } : {}) };
  revalidateContracts(field(formData, 'leadId'), field(formData, 'clientId'));
  return { status: 'success', message: result.data.unchanged ? 'Nothing changed.' : `Contract marked ${CONTRACT_STATUS_LABEL[status].toLowerCase()}.` };
}
