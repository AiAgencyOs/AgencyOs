import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { probeStorage, safeObjectName } from '@/lib/files/storage';
import { err, ok, type Result } from '@/lib/result';

import { setOwnPreferencesSchema, updateOwnProfileSchema, type SetOwnPreferencesInput, type UpdateOwnProfileInput } from './profile-schema';
import { AVATAR_CONTENT_TYPES, AVATARS_BUCKET, MAX_AVATAR_BYTES } from './profile-types';

/**
 * The person's own profile and preferences — bucket E, decision E3 (A32).
 *
 * No capability check beyond `requireInternal`: these doors act on the
 * caller's OWN row and nothing else, and the database says so twice —
 * `users_update_self` / the own-row policies on core.user_preferences, and
 * the two functions, which read `auth.uid()` rather than an argument, so
 * there is no id to pass and no id to get wrong. Both write audit.audit_log
 * in the acting organisation through core.record_audit; a caller with no
 * acting organisation is refused by the database with 'no_organization',
 * and the refusal is printed as written.
 */

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

function outcomeOf(data: unknown): string | undefined {
  return (Array.isArray(data) ? (data[0] as { outcome?: string } | undefined)?.outcome : undefined) as string | undefined;
}

const NO_ORGANIZATION = 'Your session has no active organisation, so the change could not be recorded — nothing was saved.';

export async function updateOwnProfile(input: UpdateOwnProfileInput): Promise<Result<{ fullName: string }>> {
  const parsed = updateOwnProfileSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid profile.');

  await requireInternal();
  const supabase = await createClient();

  // The avatar is not part of this form; the door keeps what is stored.
  const { data: current, error: readError } = await supabase.schema('core').from('users').select('avatar_url').limit(1).maybeSingle();
  if (readError) {
    log('updateOwnProfile.read', readError.message);
    return err('INTERNAL', 'Could not read your profile.');
  }

  const { data, error } = await supabase
    .schema('core')
    .rpc('update_own_profile', { p_full_name: parsed.data.fullName, p_avatar_url: current?.avatar_url ?? '' });
  if (error) {
    log('updateOwnProfile', error.message);
    return err('INTERNAL', 'Could not update your profile.');
  }

  switch (outcomeOf(data)) {
    case 'updated':
      break;
    case 'no_organization':
      return err('FORBIDDEN', NO_ORGANIZATION);
    case 'unauthenticated':
      return err('UNAUTHORIZED', 'You are not signed in.');
    case 'not_found':
      return err('NOT_FOUND', 'Your profile row does not exist yet; sign out and in again to provision it.');
    case 'invalid':
      return err('VALIDATION', 'The name must be 1 to 120 characters.');
    default:
      return err('INTERNAL', 'Could not update your profile.');
  }

  // The shell reads the name from the sign-in record's metadata
  // (src/lib/auth/session.ts), so the same name goes there. The profile row
  // is already written and audited; if this half fails the header catches
  // up at the next sign-in, and the message says exactly that.
  const { error: metaError } = await supabase.auth.updateUser({ data: { full_name: parsed.data.fullName } });
  if (metaError) {
    log('updateOwnProfile.metadata', metaError.message);
    return ok({ fullName: parsed.data.fullName });
  }

  return ok({ fullName: parsed.data.fullName });
}

export async function setOwnPreferences(input: SetOwnPreferencesInput): Promise<Result<{ timezone: string | null }>> {
  const parsed = setOwnPreferencesSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid preferences.');

  await requireInternal();
  const supabase = await createClient();

  const { data, error } = await supabase.schema('core').rpc('set_own_preferences', {
    p_timezone: parsed.data.timezone,
    p_locale: parsed.data.locale,
    p_date_format: parsed.data.dateFormat,
    p_notification_email: parsed.data.notificationEmail,
    p_notification_whatsapp: parsed.data.notificationWhatsapp,
    p_digest: parsed.data.digest,
  });
  if (error) {
    log('setOwnPreferences', error.message);
    return err('INTERNAL', 'Could not save your preferences.');
  }

  switch (outcomeOf(data)) {
    case 'saved':
      return ok({ timezone: parsed.data.timezone.length > 0 ? parsed.data.timezone : null });
    case 'invalid_timezone':
      return err('VALIDATION', `"${parsed.data.timezone}" is not a timezone Postgres knows. Try one like "Asia/Kolkata".`);
    case 'invalid':
      return err('VALIDATION', 'One of the values is not one the panel accepts.');
    case 'no_organization':
      return err('FORBIDDEN', NO_ORGANIZATION);
    case 'unauthenticated':
      return err('UNAUTHORIZED', 'You are not signed in.');
    default:
      return err('INTERNAL', 'Could not save your preferences.');
  }
}

/**
 * Replaces the person's avatar in the `avatars` bucket and points
 * core.users.avatar_url at the object. Probes storage first and refuses with
 * the probe's own sentence when it cannot be reached — an avatar that
 * "uploaded" into nowhere is the one outcome this must never produce.
 */
export async function uploadOwnAvatar(file: File | null): Promise<Result<{ path: string }>> {
  if (!file || typeof file.arrayBuffer !== 'function' || file.size === 0) return err('VALIDATION', 'Choose an image to upload.');
  if (file.size > MAX_AVATAR_BYTES) {
    return err('VALIDATION', `That image is ${Math.round(file.size / 1024)} KB; the limit is ${MAX_AVATAR_BYTES / 1024 / 1024} MB.`);
  }
  if (!(AVATAR_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return err('VALIDATION', 'An avatar is a PNG, JPEG or WebP image.');
  }

  const context = await requireInternal();
  const supabase = await createClient();

  const storage = await probeStorage(supabase, context.userId, AVATARS_BUCKET);
  if (!storage.reachable) return err('PROVIDER_ERROR', `Storage is not reachable, so nothing was uploaded. ${storage.reason}`);

  const { data: current, error: readError } = await supabase.schema('core').from('users').select('full_name').limit(1).maybeSingle();
  if (readError) {
    log('uploadOwnAvatar.read', readError.message);
    return err('INTERNAL', 'Could not read your profile.');
  }
  const fullName = (current?.full_name ?? context.fullName ?? context.email).trim() || context.email;

  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${context.userId}/${safeObjectName(`avatar.${ext}`)}`;

  const { error: uploadError } = await supabase.storage.from(AVATARS_BUCKET).upload(path, file, {
    contentType: file.type,
    upsert: true,
  });
  if (uploadError) {
    log('uploadOwnAvatar.storage', uploadError.message);
    return err('PROVIDER_ERROR', `Storage refused the upload, so nothing was saved: ${uploadError.message}`);
  }

  const { data, error } = await supabase.schema('core').rpc('update_own_profile', { p_full_name: fullName, p_avatar_url: path });
  if (error) {
    log('uploadOwnAvatar.profile', error.message);
    return err('INTERNAL', 'The image was stored, but your profile could not be pointed at it. Try again.');
  }
  switch (outcomeOf(data)) {
    case 'updated':
      return ok({ path });
    case 'no_organization':
      return err('FORBIDDEN', `The image was stored, but ${NO_ORGANIZATION.charAt(0).toLowerCase()}${NO_ORGANIZATION.slice(1)}`);
    default:
      return err('INTERNAL', 'The image was stored, but your profile could not be pointed at it. Try again.');
  }
}
