'use client';

import { useActionState } from 'react';

import { setOwnPreferencesAction, updateOwnProfileAction, uploadOwnAvatarAction } from '@/modules/identity/profile-actions';
import {
  AVATAR_CONTENT_TYPES,
  COMMON_TIME_ZONES,
  DATE_FORMAT_LABELS,
  DATE_FORMAT_OPTIONS,
  DIGEST_OPTIONS,
  MAX_AVATAR_BYTES,
  type OwnPreferences,
} from '@/modules/identity/profile-types';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, Field, FormMessage, humanize, inputClass, selectClass } from '@/ui';

/**
 * The three forms on /profile — name, avatar, preferences. Each goes through
 * its `'use server'` action and prints the outcome as written; a refusal
 * from the database ("not a zone Postgres knows", "no acting organisation")
 * is shown verbatim, never softened into a success.
 */

export function ProfileNameForm({ fullName }: { fullName: string | null }) {
  const [state, action, pending] = useActionState(updateOwnProfileAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-3">
      <Field label="Your name" htmlFor="profile-full-name" hint="Shown in the header, on tasks you own and in the audit trail.">
        <input id="profile-full-name" name="fullName" type="text" required maxLength={120} defaultValue={fullName ?? ''} className={inputClass} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Save name'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function AvatarUploadForm({ storage }: { storage: { reachable: true; bucket: string } | { reachable: false; bucket: string; reason: string } }) {
  const [state, action, pending] = useActionState(uploadOwnAvatarAction, IDLE_STATE);
  if (!storage.reachable) {
    return (
      <p className="text-[13px] leading-relaxed text-muted">
        Avatars cannot be changed right now: storage is not reachable, so nothing would be uploaded. {storage.reason}
      </p>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-3">
      <Field label="New avatar" htmlFor="profile-avatar" hint={`PNG, JPEG or WebP, up to ${MAX_AVATAR_BYTES / 1024 / 1024} MB. Replaces the current one in the "${storage.bucket}" bucket.`}>
        <input id="profile-avatar" name="avatar" type="file" required accept={AVATAR_CONTENT_TYPES.join(',')} className={inputClass} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Uploading…' : 'Upload avatar'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function PreferencesForm({ preferences, organizationTimeZone }: { preferences: OwnPreferences; organizationTimeZone: string }) {
  const [state, action, pending] = useActionState(setOwnPreferencesAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Timezone"
          htmlFor="pref-timezone"
          hint={`Leave empty to follow the organisation (${organizationTimeZone}). Any IANA zone is accepted; the database refuses one it does not know.`}
        >
          <input
            id="pref-timezone"
            name="timezone"
            type="text"
            list="pref-timezone-suggestions"
            defaultValue={preferences.timezone ?? ''}
            placeholder={organizationTimeZone}
            maxLength={64}
            className={inputClass}
          />
          <datalist id="pref-timezone-suggestions">
            {COMMON_TIME_ZONES.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </Field>
        <Field label="Locale" htmlFor="pref-locale" hint="A BCP-47 tag such as en-IN or en-GB.">
          <input id="pref-locale" name="locale" type="text" defaultValue={preferences.locale} maxLength={16} pattern="[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?" className={inputClass} />
        </Field>
        <Field label="Date format" htmlFor="pref-date-format">
          <select id="pref-date-format" name="dateFormat" defaultValue={preferences.dateFormat} className={selectClass}>
            {DATE_FORMAT_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {humanize(f)} — {DATE_FORMAT_LABELS[f]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Digest" htmlFor="pref-digest" hint="How often a summary of what needs you is sent.">
          <select id="pref-digest" name="digest" defaultValue={preferences.digest} className={selectClass}>
            {DIGEST_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {humanize(d)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-semibold uppercase tracking-wider text-muted">Notifications</legend>
        <label className="flex items-center gap-2 text-[13px] text-foreground">
          <input type="checkbox" name="notificationEmail" defaultChecked={preferences.notificationEmail} className="h-4 w-4 rounded border-line" />
          Email me about approvals, mentions and assignments
        </label>
        <label className="flex items-center gap-2 text-[13px] text-foreground">
          <input type="checkbox" name="notificationWhatsapp" defaultChecked={preferences.notificationWhatsapp} className="h-4 w-4 rounded border-line" />
          Send the same on WhatsApp
        </label>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Save preferences'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
