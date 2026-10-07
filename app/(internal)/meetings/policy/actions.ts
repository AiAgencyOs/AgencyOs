'use server';

import { revalidatePath } from 'next/cache';

import { saveSchedulingPolicy, type PolicyPatch } from '@/modules/crm/p1o-scheduling-service';
import type { FormState } from '@/modules/identity/types';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Save the scheduling policy. The form is parsed into the patch the database door validates again; a half-filled day is a refusal, not a guess. */
export async function saveSchedulingPolicyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const workingHours: NonNullable<PolicyPatch['working_hours']> = {};
  for (const day of DAYS) {
    const start = String(formData.get(`${day}_start`) ?? '').trim();
    const end = String(formData.get(`${day}_end`) ?? '').trim();
    if (!start && !end) continue;
    if (!HHMM.test(start) || !HHMM.test(end) || start >= end) return { status: 'error', message: `${day.toUpperCase()}: give an opening and a closing time in 24-hour form, closing after opening, or leave both empty for a closed day.` };
    workingHours[day] = [{ start, end }];
  }
  const durations = String(formData.get('durations') ?? '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isInteger(x) && x >= 5 && x <= 480);
  const numberField = (k: string) => {
    const v = String(formData.get(k) ?? '').trim();
    return v === '' ? undefined : Number(v);
  };
  const earliest = String(formData.get('earliest') ?? '').trim();
  const latest = String(formData.get('latest') ?? '').trim();
  if ((earliest && !HHMM.test(earliest)) || (latest && !HHMM.test(latest))) return { status: 'error', message: 'The earliest and latest times must be in 24-hour form, like 10:00.' };

  const patch: PolicyPatch = {
    timezone: String(formData.get('timezone') ?? '').trim() || undefined,
    working_hours: Object.keys(workingHours).length > 0 ? workingHours : null,
    earliest_local_time: earliest || null,
    latest_local_time: latest || null,
    min_notice_minutes: numberField('minNotice'),
    buffer_minutes: numberField('buffer'),
    proposal_ttl_hours: numberField('ttl'),
    enforce_working_hours: formData.get('enforce') === 'on',
    ...(durations.length > 0 ? { durations } : {}),
  };
  const result = await saveSchedulingPolicy(patch);
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/meetings/policy');
  return { status: 'success', message: result.data };
}
