import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { openIncidentSchema, resolveIncidentSchema, type OpenIncidentInput, type ResolveIncidentInput } from './incidents-schema';

/**
 * SCR-069 — a person opens and resolves security incidents. `audit.read`'s
 * two roles (owner, ops_admin) here, `core.is_admin()` again inside both
 * SECURITY DEFINER doors; each audits (security_incident.opened / .resolved).
 */
export async function openIncident(input: OpenIncidentInput): Promise<Result<{ id: string }>> {
  const parsed = openIncidentSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid incident.');

  const context = await requireInternal();
  if (!can(context, 'audit.read')) return err('FORBIDDEN', 'You do not have permission to open a security incident.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('security').rpc('open_incident', {
    p_kind: parsed.data.kind,
    p_severity: parsed.data.severity,
    p_summary: parsed.data.summary,
    p_evidence: {
      notes: parsed.data.evidence,
      ...(parsed.data.auditEntryId ? { audit_entry_id: parsed.data.auditEntryId } : {}),
      opened_from: parsed.data.auditEntryId ? 'audit' : 'form',
    },
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'openIncident', detail: error.message }));
    return err('INTERNAL', 'Could not open the incident.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'opened':
      return ok({ id: row.id as string });
    case 'bad_kind':
      return err('VALIDATION', 'Not a kind of incident this system records.');
    case 'bad_severity':
      return err('VALIDATION', 'Not a severity this system records.');
    case 'no_summary':
      return err('VALIDATION', 'Say what happened.');
    default:
      return err('FORBIDDEN', 'You do not have permission to open a security incident.');
  }
}

export async function resolveIncident(input: ResolveIncidentInput): Promise<Result<{ id: string }>> {
  const parsed = resolveIncidentSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid request.');

  const context = await requireInternal();
  if (!can(context, 'audit.read')) return err('FORBIDDEN', 'You do not have permission to resolve a security incident.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('security').rpc('resolve_incident', {
    p_incident_id: parsed.data.incidentId,
    p_resolution: parsed.data.resolution,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'resolveIncident', detail: error.message }));
    return err('INTERNAL', 'Could not resolve the incident.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'resolved':
      return ok({ id: parsed.data.incidentId });
    case 'already_resolved':
      return err('CONFLICT', 'That incident is already resolved.');
    case 'not_found':
      return err('NOT_FOUND', 'That incident is not in this organisation.');
    case 'no_resolution':
      return err('VALIDATION', 'Say how it was resolved.');
    default:
      return err('FORBIDDEN', 'You do not have permission to resolve a security incident.');
  }
}
