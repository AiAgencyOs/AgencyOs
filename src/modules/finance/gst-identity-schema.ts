import { z } from 'zod';

/**
 * Settings › Finance › GST identity — bucket E5. The agency's own GSTIN,
 * registration state and default SAC. Pure; the service re-checks the GSTIN
 * checksum and the database re-checks shape, owner and org.
 */

/** The SAC the form suggests for an IT-services agency. A suggestion, never a default the database applies. */
export const SUGGESTED_SAC = '998314';

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

export const gstIdentitySchema = z.object({
  gstin: z.preprocess(
    (v) => (typeof v === 'string' ? blankToNull(v.toUpperCase().replace(/\s+/g, '')) : v),
    z.string().length(15, 'A GSTIN is 15 characters.').nullable(),
  ),
  stateCode: z.preprocess(blankToNull, z.string().regex(/^[0-9]{2}$/, 'A state code is two digits.').nullable()),
  defaultSac: z.preprocess(blankToNull, z.string().regex(/^[0-9]{4,8}$/, 'A SAC/HSN code is 4 to 8 digits.').nullable()),
});
export type GstIdentityInput = z.infer<typeof gstIdentitySchema>;
