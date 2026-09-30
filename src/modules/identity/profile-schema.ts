import { z } from 'zod';

import { DATE_FORMAT_OPTIONS, DIGEST_OPTIONS } from './profile-types';

/**
 * Input shapes for the profile doors. The database validates again
 * (core.set_own_preferences checks the zone against pg_timezone_names); this
 * is the first refusal, with a sentence a form can print.
 */

export const updateOwnProfileSchema = z.object({
  fullName: z.string().trim().min(1, 'Enter your name.').max(120, 'A name is at most 120 characters.'),
});
export type UpdateOwnProfileInput = z.infer<typeof updateOwnProfileSchema>;

export const setOwnPreferencesSchema = z.object({
  /** Empty = follow the organisation. */
  timezone: z.string().trim().max(64).optional().default(''),
  locale: z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/, 'A locale looks like "en-IN" or "en-GB".')
    .default('en-IN'),
  dateFormat: z.enum(DATE_FORMAT_OPTIONS).default('medium'),
  notificationEmail: z.boolean().default(true),
  notificationWhatsapp: z.boolean().default(false),
  digest: z.enum(DIGEST_OPTIONS).default('off'),
});
export type SetOwnPreferencesInput = z.input<typeof setOwnPreferencesSchema>;
