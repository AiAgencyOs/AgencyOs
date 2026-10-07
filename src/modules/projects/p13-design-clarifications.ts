import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { asRows, looseSchema } from '@/lib/p13/loose-client';
import { err, ok, unreadable, type Result } from '@/lib/result';

export type DesignClarification = {
  id: string;
  screen_ref: string | null;
  question: string;
  status: 'open' | 'asked' | 'answered' | 'cancelled';
  raised_by_type: 'designer_agent' | 'user';
  asked_via: string | null;
  asked_evidence: string | null;
  answer: string | null;
  answer_evidence: string | null;
  created_at: string;
};

/** P3-PM-005: the clarifications of one project's Phase 3, newest first (RLS-scoped, internal only). */
export async function listDesignClarifications(projectId: string): Promise<DesignClarification[]> {
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'projects')
    .from('p13_design_clarifications')
    .select('id, screen_ref, question, status, raised_by_type, asked_via, asked_evidence, answer, answer_evidence, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) unreadable('listDesignClarifications', error);
  return asRows(data) as unknown as DesignClarification[];
}

const REFUSAL: Record<string, string> = {
  not_authorized: 'Only a delivery lead or admin may record this.',
  evidence_required: 'Say where this can be read or checked (a message reference).',
  answer_required: 'The answer is empty.',
  not_open: 'This question has already been asked.',
  not_asked: 'Record that the client was asked before recording an answer.',
  not_found: 'That clarification does not exist.',
  invalid_channel: 'Unknown channel.',
  fields_must_be_an_object: 'Structured fields must be a JSON object.',
};

async function guarded(): Promise<Result<null>> {
  const context = await requireInternal();
  return can(context, 'project.write') ? ok(null) : err('FORBIDDEN', 'You do not have permission to change this project.');
}

export async function markClarificationAsked(input: { id: string; via: string; evidence: string }): Promise<Result<null>> {
  const g = await guarded();
  if (!g.ok) return g;
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'projects').rpc('p13_mark_clarification_asked', { p_id: input.id, p_via: input.via, p_evidence: input.evidence });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'markClarificationAsked', detail: error.message }));
    return err('INTERNAL', 'Could not record that.');
  }
  return data === 'asked' ? ok(null) : err('VALIDATION', REFUSAL[String(data)] ?? 'The database refused.');
}

export async function answerClarification(input: { id: string; answer: string; fieldsText: string; evidence: string }): Promise<Result<null>> {
  let fields: Record<string, unknown> | null = null;
  if (input.fieldsText.trim()) {
    try {
      const parsed: unknown = JSON.parse(input.fieldsText);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return err('VALIDATION', REFUSAL.fields_must_be_an_object ?? 'Invalid fields.');
      fields = parsed as Record<string, unknown>;
    } catch {
      return err('VALIDATION', 'The structured fields are not valid JSON.');
    }
  }
  const g = await guarded();
  if (!g.ok) return g;
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'projects').rpc('p13_answer_design_clarification', {
    p_id: input.id,
    p_answer: input.answer,
    p_answer_fields: fields,
    p_evidence: input.evidence,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'answerClarification', detail: error.message }));
    return err('INTERNAL', 'Could not record the answer.');
  }
  return data === 'answered' ? ok(null) : err('VALIDATION', REFUSAL[String(data)] ?? 'The database refused.');
}
