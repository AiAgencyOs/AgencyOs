'use server';

import { revalidatePath } from 'next/cache';

import { setNotificationState } from '@/lib/admin/notification-state';
import type { FormState } from '@/modules/identity/types';

/**
 * SCR-003's four doors — mark read (one or many), snooze until, resolve with
 * a note, assign to a member — as one Server Action over
 * `setNotificationState`. Every `key` field in the form is one inbox row, so
 * the batch bar and a single row's buttons post the same shape.
 */
export async function setNotificationStateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const itemKeys = formData.getAll('key').map((k) => String(k)).filter(Boolean);
  const state = String(formData.get('state') ?? '');
  const snoozedUntil = String(formData.get('snoozedUntil') ?? '').trim();
  const assignedTo = String(formData.get('assignedTo') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();

  if (itemKeys.length === 0) return { status: 'error', message: 'Select at least one notification.' };

  const result = await setNotificationState({
    itemKeys,
    state: state as 'unread' | 'read' | 'snoozed' | 'resolved',
    snoozedUntil: snoozedUntil || null,
    assignedTo: assignedTo || null,
    note: note || null,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/notifications');
  const n = result.data.count;
  const what = n === 1 ? 'notification' : `${n} notifications`;
  const said =
    assignedTo ? `Assigned ${what}.` :
    state === 'read' ? `Marked ${what} read.` :
    state === 'unread' ? `Marked ${what} unread.` :
    state === 'snoozed' ? `Snoozed ${what}.` :
    `Resolved ${what}.`;
  return { status: 'success', message: said };
}
