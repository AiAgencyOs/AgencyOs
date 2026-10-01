'use server';

import { revalidatePath } from 'next/cache';

import { createClient } from '@/lib/db/server';
import { getAgencyTimeZone } from '@/lib/admin/agency-clock';
import { zonedDateTimeToIso } from '@/lib/admin/zoned-time';
import { requestMeeting } from '@/lib/scheduler/meeting-commands';
import type { FormState } from '@/modules/identity/types';

/**
 * SCR-022 — "Propose a meeting on this day", from the project calendar.
 *
 * The same door the lead page's "the client asked for a meeting" uses
 * (`crm.request_meeting`), with the day pre-filled as the requested start.
 * It records a REQUEST at that time on one of the project's client leads;
 * it books nothing — an offer and a confirmation are the steps that follow
 * on the meeting page, from what the calendar actually has free. The zone is
 * the agency's own, read here rather than carried by the form.
 */
export async function proposeMeetingOnDayAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const field = (name: string) => {
    const value = String(formData.get(name) ?? '').trim();
    return value.length > 0 ? value : undefined;
  };

  const projectId = String(formData.get('projectId') ?? '');
  const zone = await getAgencyTimeZone();
  if (!zone) return { status: 'error', message: 'The agency has no timezone set, so a time on this day cannot be named. Set it on the Settings page.' };

  const startAt = zonedDateTimeToIso(String(formData.get('date') ?? ''), String(formData.get('time') ?? ''), zone);
  if (!startAt) return { status: 'error', message: 'That day and time could not be read.' };

  const result = await requestMeeting({
    leadId: String(formData.get('leadId') ?? ''),
    mode: String(formData.get('mode') ?? ''),
    timezone: zone,
    purpose: field('purpose'),
    conversationId: null,
    requestedStartAt: startAt,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  // SCR-022: a meeting made from a project belongs to it, so it shows on this calendar.
  let attached = true;
  if (projectId && result.data.meetingId) {
    const supabase = await createClient();
    const { data, error } = await supabase.schema('projects').rpc('attach_meeting_to_project', { p_meeting_id: result.data.meetingId, p_project_id: projectId });
    attached = !error && ['attached', 'unchanged'].includes((Array.isArray(data) ? data[0] : data)?.outcome ?? '');
  }
  if (projectId) revalidatePath(`/projects/${projectId}/calendar`);
  if (projectId) revalidatePath(`/projects/${projectId}`);
  if (result.data.leadId) revalidatePath(`/leads/${result.data.leadId}`);
  revalidatePath('/meetings');
  return {
    status: 'success',
    message: result.data.meetingId ? `${result.data.message} Open it under Meetings to offer times.${attached ? '' : ' It could not be linked to this project, so it will not show on this calendar.'}` : result.data.message,
  };
}
