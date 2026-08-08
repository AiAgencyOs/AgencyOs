import { z } from 'zod';

/** Input validation for the authentication flows. */

export const magicLinkSchema = z.object({
  email: z.email({ message: 'Enter a valid email address' }).max(320),
  next: z.string().startsWith('/').max(512).optional(),
});
export type MagicLinkInput = z.infer<typeof magicLinkSchema>;

export const oauthSchema = z.object({
  next: z.string().startsWith('/').max(512).optional(),
});
export type OAuthInput = z.infer<typeof oauthSchema>;

// safeRedirectPath lives in @/lib/url — it is generic URL safety, not domain
// logic, and route handlers need it without reaching into this module.
