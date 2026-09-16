/**
 * A GSTIN is checkable, so it is checked — Finance §4.2.
 *
 * §4.2 says *"validate required GST billing profile before issuing the GST
 * invoice"* and §16 says incomplete or invalid GST data **blocks** issuance.
 * A GSTIN is not free text: it is a fifteen-character identifier with a
 * published structure and a checksum, which means a typo is detectable here
 * rather than by the client's accountant three weeks later.
 *
 *   `27` `AAPFU0939F` `1` `Z` `V`
 *    │     │            │   │   └─ check character, computed from the first 14
 *    │     │            │   └───── literally 'Z' for a normal registration
 *    │     │            └───────── entity number for that PAN in that state
 *    │     └────────────────────── the holder's PAN
 *    └──────────────────────────── state code, 01–38 (plus 97 for "other
 *                                  territory" and 99 for a UN body)
 *
 * **This is reference data, not a business rule.** The format and the checksum
 * are published by the GSTN; nothing here decides anything about how the
 * agency bills. What it decides is whether a string a person typed can
 * possibly be a GSTIN — and the answer is arithmetic, which is exactly what
 * Finance §20 means by *"use deterministic code/config for money, tax,
 * percentages and gates; never rely on free-form LLM arithmetic as source of
 * truth."*
 *
 * **What it cannot do, stated plainly:** a GSTIN that passes here may still
 * not exist, may belong to somebody else, or may have been cancelled. Only the
 * GST portal knows that, this deployment has no integration with it, and a
 * checksum that passes is not a registration that is real. Callers get
 * `valid`, never `verified`.
 */

/** Character set the checksum runs over: 0–9 then A–Z, weighted by position. */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * State codes the GSTN has assigned. 01–38 are states and union territories;
 * 97 is "other territory" and 99 is a UN body or embassy.
 *
 * Held as a range rather than a list of names on purpose: mapping a code to
 * "Maharashtra" would be this module claiming to know India's administrative
 * geography, which it would then be wrong about the next time a union
 * territory merges. What it needs to know is whether the code is one the GSTN
 * issues.
 */
function isAssignedStateCode(code: string): boolean {
  if (!/^[0-9]{2}$/.test(code)) return false;
  const n = Number(code);
  return (n >= 1 && n <= 38) || n === 97 || n === 99;
}

/** The published shape. Case-sensitive: a GSTIN is upper case. */
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

/**
 * The GSTN check character, over the first fourteen.
 *
 * Each character's value is multiplied by 1 or 2 alternating, the product's
 * quotient and remainder against 36 are summed, and the total's complement mod
 * 36 indexes the alphabet. Deterministic, and the reason a transposed pair of
 * digits is caught here instead of on an invoice.
 */
export function gstinCheckCharacter(first14: string): string | null {
  if (first14.length !== 14) return null;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = ALPHABET.indexOf(first14[i]!);
    if (value < 0) return null;
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return ALPHABET[(36 - (sum % 36)) % 36]!;
}

export type GstinVerdict =
  | { valid: true; stateCode: string; pan: string; normalized: string }
  | { valid: false; reason: string };

/**
 * Whether a string can be a GSTIN.
 *
 * Trims and upper-cases before judging, because a person pasting from an email
 * should not be refused for a trailing space — but it returns the `normalized`
 * form it judged, so the caller stores what was checked rather than what was
 * typed.
 */
export function checkGstin(raw: string | null | undefined): GstinVerdict {
  const normalized = (raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (normalized.length === 0) return { valid: false, reason: 'no GSTIN was given' };
  if (normalized.length !== 15) {
    return { valid: false, reason: `a GSTIN is 15 characters; this one is ${normalized.length}` };
  }
  if (!GSTIN_SHAPE.test(normalized)) {
    return { valid: false, reason: 'this does not have the shape of a GSTIN (two digits, a PAN, an entity digit, Z, a check character)' };
  }
  const stateCode = normalized.slice(0, 2);
  if (!isAssignedStateCode(stateCode)) {
    return { valid: false, reason: `${stateCode} is not a state code the GSTN issues` };
  }
  const expected = gstinCheckCharacter(normalized.slice(0, 14));
  if (expected === null || expected !== normalized[14]) {
    // The single most useful message this module produces: it almost always
    // means one character was mistyped, and it says so rather than "invalid".
    return { valid: false, reason: 'the check character does not match — one character is probably mistyped' };
  }
  return { valid: true, stateCode, pan: normalized.slice(2, 12), normalized };
}

/** The two modes, and no third. Finance §4.1 stores one of these or nothing. */
export const BILLING_MODES = ['gst', 'non_gst'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

/** The fields §14's BillingProfile requires, and which of them GST adds. */
export const ALWAYS_REQUIRED = ['legal_name', 'billing_address', 'billing_state'] as const;
export const GST_ONLY_REQUIRED = ['gstin'] as const;

export type BillingProfileFields = {
  readonly mode: BillingMode | null;
  readonly legal_name?: string | null;
  readonly billing_address?: string | null;
  readonly billing_state?: string | null;
  readonly gstin?: string | null;
};

export type BillingReadiness = {
  /** Whether a GST invoice may be issued against this profile — §16. */
  readonly complete: boolean;
  /** Exactly what to ask for, so §16's "request only missing fields" is possible. */
  readonly missing: readonly string[];
  /** Present when a GSTIN was given and could not be a GSTIN. */
  readonly invalid: readonly { field: string; reason: string }[];
};

/**
 * What is still needed before an invoice may be issued — Finance §4.2, §16.
 *
 * Returns the gap rather than a bare false, because §16's instruction is to
 * *"request only missing fields"*, and a gate that says no without saying what
 * is owed produces a message asking the client for everything again.
 *
 * **Non-GST does not acquire a GSTIN.** §4.3: *"do not add GST merely because
 * the agency has GST configuration."* A non-GST profile is complete without
 * one, and this function is where that is true rather than in the caller who
 * happens to remember.
 */
export function billingReadiness(profile: BillingProfileFields): BillingReadiness {
  const missing: string[] = [];
  const invalid: { field: string; reason: string }[] = [];

  // §16: "Missing billing mode — block invoice." A profile with no confirmed
  // mode is not a profile that defaults to one.
  if (profile.mode === null) {
    return { complete: false, missing: ['billing_mode'], invalid: [] };
  }

  for (const field of ALWAYS_REQUIRED) {
    if (!profile[field]?.trim()) missing.push(field);
  }

  if (profile.mode === 'gst') {
    for (const field of GST_ONLY_REQUIRED) {
      if (!profile[field]?.trim()) {
        missing.push(field);
        continue;
      }
      const verdict = checkGstin(profile[field]);
      if (!verdict.valid) invalid.push({ field, reason: verdict.reason });
    }
  }

  return { complete: missing.length === 0 && invalid.length === 0, missing, invalid };
}
