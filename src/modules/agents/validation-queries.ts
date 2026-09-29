import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { Finding } from './validation-rules';

export type AgentValidationRow = {
  agentKey: string;
  validatedAt: string;
  validatedByName: string | null;
  outcome: 'ok' | 'problems';
  registryRevision: string;
  findings: Finding[];
};

function asFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (f): f is Finding => typeof f === 'object' && f !== null && 'check' in f && 'ok' in f && 'detail' in f,
  );
}

async function namesFor(userIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (userIds.length === 0) return names;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', userIds);
  if (error) unreadable('agentValidations.users', error);
  for (const u of data ?? []) names.set(u.id, u.full_name ?? u.email);
  return names;
}

/** The most recent validation a person recorded for one agent, with its findings — SCR-062. */
export async function latestAgentValidation(agentKey: string): Promise<AgentValidationRow | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('ai')
    .from('agent_validations')
    .select('agent_key, validated_at, validated_by, outcome, registry_revision, findings')
    .eq('agent_key', agentKey)
    .order('validated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) unreadable('latestAgentValidation', error);
  if (!data) return null;

  const names = await namesFor(data.validated_by ? [data.validated_by] : []);
  return {
    agentKey: data.agent_key,
    validatedAt: data.validated_at,
    validatedByName: data.validated_by ? (names.get(data.validated_by) ?? data.validated_by.slice(0, 8)) : null,
    outcome: data.outcome === 'ok' ? 'ok' : 'problems',
    registryRevision: data.registry_revision,
    findings: asFindings(data.findings),
  };
}

export type LatestValidationSummary = {
  validatedAt: string;
  validatedByName: string | null;
  outcome: 'ok' | 'problems';
};

/** The latest person-made validation per agent, for the registry's "last validated by a person" column. */
export async function listLatestAgentValidations(): Promise<Map<string, LatestValidationSummary>> {
  const supabase = await createClient();

  // Newest first; the first row seen per key wins. Bounded, since a tenant
  // pressing the button a thousand times is still a thousand small rows.
  const { data, error } = await supabase
    .schema('ai')
    .from('agent_validations')
    .select('agent_key, validated_at, validated_by, outcome')
    .order('validated_at', { ascending: false })
    .limit(500);
  if (error) unreadable('listLatestAgentValidations', error);

  const latest = new Map<string, { validatedAt: string; validatedBy: string | null; outcome: 'ok' | 'problems' }>();
  for (const r of data ?? []) {
    if (!latest.has(r.agent_key)) {
      latest.set(r.agent_key, { validatedAt: r.validated_at, validatedBy: r.validated_by, outcome: r.outcome === 'ok' ? 'ok' : 'problems' });
    }
  }

  const names = await namesFor([...new Set([...latest.values()].map((v) => v.validatedBy).filter((v): v is string => v !== null))]);

  return new Map(
    [...latest.entries()].map(([key, v]) => [
      key,
      {
        validatedAt: v.validatedAt,
        validatedByName: v.validatedBy ? (names.get(v.validatedBy) ?? v.validatedBy.slice(0, 8)) : null,
        outcome: v.outcome,
      },
    ]),
  );
}
