'use server';

import { revalidatePath } from 'next/cache';

import { requestMeeting } from '@/lib/scheduler/meeting-commands';
import type { FormState } from '@/modules/identity/types';

/**
 * The Server Action behind the lead page's "the client asked for a meeting"
 * control — Scheduler §3.1, §4.
 *
 * Thin, like the meeting page's actions: the capability check, the tenancy
 * guard and the audit row all live in `crm.request_meeting` and the library
 * above it. The lead's page is revalidated from the lead id the DOOR returned,
 * never from the form field — the same rule the review of G-237 established,
 * for the same reason: a form can say anything.
 */
export async function requestMeetingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const field = (name: string) => {
    const value = String(formData.get(name) ?? '').trim();
    return value.length > 0 ? value : undefined;
  };

  const result = await requestMeeting({
    leadId: String(formData.get('leadId') ?? ''),
    mode: String(formData.get('mode') ?? ''),
    timezone: String(formData.get('timezone') ?? '') || (await agencyZone()),
    purpose: field('purpose'),
    conversationId: field('conversationId') ?? null,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  if (result.data.leadId) revalidatePath(`/leads/${result.data.leadId}`);
  revalidatePath('/meetings');
  return { status: 'success', message: result.data.message };
}

/**
 * The agency's own zone, read here rather than carried in the form.
 *
 * A hidden field holding the timezone is a field somebody can edit, and §4.4's
 * zone decides what hour a client is told to turn up at. The form shows the
 * zone so nobody is surprised; the value comes from the settings.
 */
async function agencyZone(): Promise<string> {
  const { getAgencyTimeZone } = await import('@/lib/admin/agency-clock');
  return (await getAgencyTimeZone()) ?? '';
}
