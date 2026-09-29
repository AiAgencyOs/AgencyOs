'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import type { INCIDENT_KINDS, INCIDENT_SEVERITIES } from './incidents-schema';
import { openIncident, resolveIncident } from './incidents-service';

/** SCR-069 — the security incidents page's two doors, as forms. Refusals are shown as written. */

export async function openIncidentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auditRaw = String(formData.get('auditEntryId') ?? '').trim();
  const auditEntryId = /^[0-9]+$/.test(auditRaw) ? Number(auditRaw) : undefined;
  const result = await openIncident({
    kind: String(formData.get('kind') ?? '') as (typeof INCIDENT_KINDS)[number],
    severity: String(formData.get('severity') ?? '') as (typeof INCIDENT_SEVERITIES)[number],
    summary: String(formData.get('summary') ?? ''),
    evidence: String(formData.get('evidence') ?? ''),
    ...(auditEntryId !== undefined ? { auditEntryId } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/security/incidents');
  revalidatePath('/security');
  return { status: 'success', message: `Incident ${result.data.id.slice(0, 8)} opened. Audited.` };
}

export async function resolveIncidentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await resolveIncident({
    incidentId: String(formData.get('incidentId') ?? ''),
    resolution: String(formData.get('resolution') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/security/incidents');
  revalidatePath('/security');
  return { status: 'success', message: 'Resolved, with the resolution recorded. Audited.' };
}
