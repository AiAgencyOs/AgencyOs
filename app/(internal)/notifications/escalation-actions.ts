'use server';

import { revalidatePath } from 'next/cache';

import { acknowledgeEscalation, escalate } from '@/lib/admin/escalations';
import type { FormState } from '@/modules/identity/types';

/**
 * The two escalation doors as Server Actions — SCR-001 "Acknowledge /
 * escalate an operational item" and SCR-003 "Escalate to owner or ops
 * admin" (bucket F, stream F-A). One component (`escalate-form.tsx`) posts
 * to them from the dashboard feed, the inbox row and the notification
 * drawer alike: the same door wherever the PDF puts the button.
 */
export async function escalateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await escalate({
    subjectType: String(formData.get('subjectType') ?? ''),
    subjectKey: String(formData.get('subjectKey') ?? ''),
    title: String(formData.get('title') ?? ''),
    toRole: String(formData.get('toRole') ?? '') as 'owner' | 'ops_admin',
    reason: String(formData.get('reason') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/notifications');
  revalidatePath('/dashboard');
  return {
    status: 'success',
    message: result.data.alreadyOpen ? 'Already escalated — the open escalation stands.' : 'Escalated and recorded.',
  };
}

export async function acknowledgeEscalationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const state = String(formData.get('state') ?? '');
  const result = await acknowledgeEscalation({
    escalationId: String(formData.get('escalationId') ?? ''),
    state: state === 'resolved' ? 'resolved' : 'acknowledged',
    note: String(formData.get('note') ?? '').trim() || null,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/notifications');
  revalidatePath('/dashboard');
  return { status: 'success', message: result.data.state === 'resolved' ? 'Resolved and recorded.' : 'Acknowledged and recorded.' };
}
