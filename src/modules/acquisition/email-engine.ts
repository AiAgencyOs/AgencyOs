import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import type { Json } from '@/lib/db/types';

import type { QualificationFactor } from './qualification-vocabulary';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The Email engine's decisions (20261018100000), as an agent or a worker calls them. The model that scores, the evaluator that
 * supplies the factor values and the writer that drafts are all OUTSIDE this file by design: what is here is what their output is
 * held to - the weights the Admin set, the rules that outrank a score, and the check that a message says only what the research
 * supports. A refusal here is never overridden by confidence.
 */

const row = <T>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;

export type QualificationDecision = 'qualified' | 'needs_more_info' | 'disqualified';

export type QualificationResult =
  | { ok: true; qualificationId: string; decision: QualificationDecision; score: number; disqualifiers: string[]; missing: string[] }
  | { ok: false; refusal: 'forbidden' | 'invalid' | 'unknown_prospect' };

/** Record a qualification decision. `factors` are 0-100 per factor; anything not supplied is MISSING and lowers the score. */
export async function qualifyProspect(
  admin: Admin,
  input: {
    organizationId: string;
    prospectId: string;
    factors: Partial<Record<QualificationFactor, number>>;
    reasoning?: string;
    signals?: { industry?: string; country?: string; service?: string; [k: string]: unknown };
    evaluatedBy: 'human' | 'agent' | 'rule';
  },
): Promise<QualificationResult> {
  const { data, error } = await admin.schema('crm').rpc('qualify_prospect', {
    p_organization_id: input.organizationId, p_prospect: input.prospectId, p_factors: input.factors as unknown as Json,
    p_reasoning: input.reasoning as never, p_signals: (input.signals ?? {}) as unknown as Json, p_evaluated_by_type: input.evaluatedBy,
  });
  if (error) throw new Error(`qualifyProspect failed: ${error.message}`);
  const r = row<{ outcome?: string; qualification_id?: string | null; decision?: string | null; score?: number | null; disqualifiers?: Json | null; missing?: Json | null }>(data);
  if (r?.outcome === 'recorded' && r.qualification_id && r.decision && r.score !== null && r.score !== undefined) {
    return {
      ok: true, qualificationId: r.qualification_id, decision: r.decision as QualificationDecision, score: r.score,
      disqualifiers: Array.isArray(r.disqualifiers) ? (r.disqualifiers as string[]) : [], missing: Array.isArray(r.missing) ? (r.missing as string[]) : [],
    };
  }
  return { ok: false, refusal: (r?.outcome ?? 'invalid') as 'invalid' };
}

export type FactSource = 'website' | 'linkedin' | 'directory' | 'press' | 'manual' | 'email_reply';

/** Record something actually known about a prospect, with where it came from. Only these facts can be cited in a message. */
export async function addProspectFact(
  admin: Admin,
  input: { organizationId: string; prospectId: string; fact: string; sourceKind: FactSource; sourceUrl?: string; recordedBy: 'human' | 'agent' | 'rule' },
): Promise<{ ok: true; factId: string } | { ok: false; refusal: string }> {
  const { data, error } = await admin.schema('crm').rpc('add_prospect_fact', {
    p_organization_id: input.organizationId, p_prospect: input.prospectId, p_fact: input.fact, p_source_kind: input.sourceKind,
    p_source_url: input.sourceUrl as never, p_recorded_by_type: input.recordedBy,
  });
  if (error) throw new Error(`addProspectFact failed: ${error.message}`);
  const r = row<{ outcome?: string; fact_id?: string | null }>(data);
  return r?.outcome === 'recorded' && r.fact_id ? { ok: true, factId: r.fact_id } : { ok: false, refusal: r?.outcome ?? 'invalid' };
}

export type DraftClaim = { text: string; factId: string };

/**
 * Check a drafted message BEFORE it can be used: every personalisation claim must cite a recorded fact about THIS prospect and be
 * present in the text, and there must be no manufactured urgency, guarantee or unearned familiarity. A draft that fails is not sent -
 * whoever or whatever wrote it.
 */
export async function validateOutreachDraft(
  admin: Admin,
  input: { organizationId: string; prospectId: string; subject: string; body: string; claims: DraftClaim[] },
): Promise<{ valid: boolean; problems: string[] }> {
  const { data, error } = await admin.schema('crm').rpc('validate_outreach_draft', {
    p_organization_id: input.organizationId, p_prospect: input.prospectId, p_subject: input.subject, p_body: input.body,
    p_claims: input.claims.map((c) => ({ text: c.text, fact_id: c.factId })) as unknown as Json,
  });
  if (error) throw new Error(`validateOutreachDraft failed: ${error.message}`);
  const r = row<{ valid?: boolean | null; problems?: Json | null }>(data);
  // A missing answer is a failure, never a pass.
  return { valid: r?.valid === true, problems: Array.isArray(r?.problems) ? (r.problems as string[]) : ['no_answer'] };
}
