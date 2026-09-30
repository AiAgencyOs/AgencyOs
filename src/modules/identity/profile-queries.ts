import 'server-only';

import { getAgencyTimeZone } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { probeStorage, SIGNED_URL_SECONDS } from '@/lib/files/storage';
import { unreadable } from '@/lib/result';

import { AVATARS_BUCKET, DEFAULT_PREFERENCES, type DateFormat, type Digest, type OwnPreferences, type OwnProfile } from './profile-types';

/**
 * Reads for /profile — the person's own core.users row, their own
 * core.user_preferences row (RLS admits exactly that one), and whether the
 * avatars bucket can be reached. A failed read of either row refuses
 * (`unreadable`); a storage that does not answer is NOT a refusal — the page
 * renders and says in words that avatars cannot be changed right now.
 */
export async function readOwnProfile(): Promise<OwnProfile> {
  const context = await requireInternal('/profile');
  const supabase = await createClient();

  const [userResult, preferencesResult, organizationTimeZone] = await Promise.all([
    supabase.schema('core').from('users').select('id, email, full_name, avatar_url').eq('id', context.userId).maybeSingle(),
    supabase
      .schema('core')
      .from('user_preferences')
      .select('timezone, locale, date_format, notification_email, notification_whatsapp, digest, updated_at')
      .eq('user_id', context.userId)
      .maybeSingle(),
    getAgencyTimeZone(),
  ]);

  if (userResult.error) unreadable('readOwnProfile.user', userResult.error);
  if (preferencesResult.error) unreadable('readOwnProfile.preferences', preferencesResult.error);

  const row = preferencesResult.data;
  const preferences: OwnPreferences = row
    ? {
        timezone: row.timezone,
        locale: row.locale,
        dateFormat: row.date_format as DateFormat,
        notificationEmail: row.notification_email,
        notificationWhatsapp: row.notification_whatsapp,
        digest: row.digest as Digest,
        updatedAt: row.updated_at,
      }
    : DEFAULT_PREFERENCES;

  const avatarUrl = userResult.data?.avatar_url ?? null;
  const storage = await probeStorage(supabase, context.userId, AVATARS_BUCKET);

  // A stored avatar is an object path (`<user_id>/avatar.png`); an external
  // URL (from a sign-in provider) is shown as it is. Signing needs storage.
  let avatarSignedUrl: string | null = null;
  if (avatarUrl && /^https?:\/\//i.test(avatarUrl)) {
    avatarSignedUrl = avatarUrl;
  } else if (avatarUrl && storage.reachable) {
    const { data } = await supabase.storage.from(AVATARS_BUCKET).createSignedUrl(avatarUrl, SIGNED_URL_SECONDS);
    avatarSignedUrl = data?.signedUrl ?? null;
  }

  return {
    userId: context.userId,
    email: userResult.data?.email ?? context.email,
    fullName: userResult.data?.full_name ?? context.fullName,
    avatarUrl,
    avatarSignedUrl,
    role: context.role,
    organizationTimeZone,
    preferences,
    storage,
  };
}
