/**
 * Types the /profile page and its client forms share with the profile door.
 * No `server-only` import: a client component reads these.
 *
 * Bucket E, decision E3 (owner, 2026-09-30) — Profile / Preferences (A32).
 */

export const DIGEST_OPTIONS = ['off', 'daily', 'weekly'] as const;
export type Digest = (typeof DIGEST_OPTIONS)[number];

export const DATE_FORMAT_OPTIONS = ['medium', 'long', 'numeric'] as const;
export type DateFormat = (typeof DATE_FORMAT_OPTIONS)[number];

export const DATE_FORMAT_LABELS: Record<DateFormat, string> = {
  medium: '19 Aug 2026',
  long: '19 August 2026',
  numeric: '19/08/2026',
};

/** A few common IANA zones as suggestions; any zone Postgres knows is accepted. */
export const COMMON_TIME_ZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
] as const;

export type OwnPreferences = {
  /** null = follow the organisation's timezone. */
  timezone: string | null;
  locale: string;
  dateFormat: DateFormat;
  notificationEmail: boolean;
  notificationWhatsapp: boolean;
  digest: Digest;
  /** null when the person has never saved preferences — every value above is then the default. */
  updatedAt: string | null;
};

export const DEFAULT_PREFERENCES: OwnPreferences = {
  timezone: null,
  locale: 'en-IN',
  dateFormat: 'medium',
  notificationEmail: true,
  notificationWhatsapp: false,
  digest: 'off',
  updatedAt: null,
};

export type OwnProfile = {
  userId: string;
  email: string;
  fullName: string | null;
  /** The object path in the avatars bucket, or an external URL, as stored on core.users. */
  avatarUrl: string | null;
  /** A short-lived signed URL for the stored avatar, when storage answered; null otherwise. */
  avatarSignedUrl: string | null;
  role: string | undefined;
  /** The organisation's own timezone — what "follow the organisation" resolves to. */
  organizationTimeZone: string;
  preferences: OwnPreferences;
  storage: { reachable: true; bucket: string } | { reachable: false; bucket: string; reason: string };
};

/** The bucket avatars live in. Not configurable: one bucket, keyed `<user_id>/<file>`. */
export const AVATARS_BUCKET = 'avatars';

/** The largest avatar the door accepts — 2 MB is generous for a face. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export const AVATAR_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
