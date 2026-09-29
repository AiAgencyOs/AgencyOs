'use server';

import { revalidatePath } from 'next/cache';

import { setOwnPreferences, updateOwnProfile, uploadOwnAvatar } from './profile-service';
import type { FormState } from './types';

/**
 * Server Actions for /profile — thin: read the form, call the door, print
 * the outcome as written. The whole internal shell is revalidated because
 * the header shows the name and every page formats dates in the chosen zone.
 */

export async function updateOwnProfileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await updateOwnProfile({ fullName: String(formData.get('fullName') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/', 'layout');
  return { status: 'success', message: `Saved. You are "${result.data.fullName}" on every screen.` };
}

export async function setOwnPreferencesAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setOwnPreferences({
    timezone: String(formData.get('timezone') ?? ''),
    locale: String(formData.get('locale') ?? 'en-IN'),
    dateFormat: String(formData.get('dateFormat') ?? 'medium') as 'medium' | 'long' | 'numeric',
    notificationEmail: formData.get('notificationEmail') === 'on',
    notificationWhatsapp: formData.get('notificationWhatsapp') === 'on',
    digest: String(formData.get('digest') ?? 'off') as 'off' | 'daily' | 'weekly',
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/', 'layout');
  return {
    status: 'success',
    message: result.data.timezone
      ? `Saved. Dates and times now show in ${result.data.timezone}.`
      : 'Saved. Dates and times follow the organisation’s timezone.',
  };
}

export async function uploadOwnAvatarAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const file = formData.get('avatar');
  const result = await uploadOwnAvatar(file instanceof File ? file : null);
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/profile');
  return { status: 'success', message: 'Avatar updated.' };
}
