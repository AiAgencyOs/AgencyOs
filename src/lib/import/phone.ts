/**
 * Deterministic phone normalization for the WhatsApp import — pure and
 * dependency-free, so the node test runner can import it directly.
 *
 * Deterministic means: the same input always yields the same output, and the
 * function NEVER guesses a country. A number written in E.164 (`+<cc><national>`)
 * normalizes to E.164 by stripping formatting. A bare national number
 * (`9389998942`) has no country in it, and inventing one would be inventing
 * phone ownership — forbidden — so it returns `e164: null` with a stated reason.
 * The caller treats a null e164 as "not phone-matchable", never as a match.
 */

export type NormalizedPhone = {
  /** E.164 (`+<digits>`) iff derivable WITHOUT guessing a country; else null. */
  e164: string | null;
  /** Digits after stripping formatting and marks — for display/debugging only. */
  digits: string;
  /** Whether the raw value carried a leading `+` (an explicit country code). */
  hadPlus: boolean;
  /** Why e164 is null, when it is — surfaced to the operator, never a guess. */
  reason?: 'no-country-code' | 'implausible-length' | 'empty';
};

// E.164 allows up to 15 digits; the shortest assignable numbers are ~8.
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

// WhatsApp wraps phones in bidi marks: LRM (U+200E), RLM (U+200F), and the bidi
// embeddings/overrides (U+202A..U+202E). Those are not whitespace, so they are
// stripped explicitly here; the no-break spaces (U+00A0, U+202F) are matched by
// \s in FORMATTING. All are written as escapes so no invisible byte is in source.
const MARKS = /[‎‏‪-‮]/g;
const FORMATTING = /[\s()\-.–—/]/g;

/** Strip WhatsApp bidi/space marks and human formatting, keeping `+` and digits. */
function strip(raw: string): string {
  return raw.replace(MARKS, '').replace(FORMATTING, '').trim();
}

export function normalizePhone(raw: string): NormalizedPhone {
  const cleaned = strip(raw ?? '');
  const hadPlus = cleaned.startsWith('+');
  const digits = cleaned.replace(/\D/g, '');

  if (digits.length === 0) return { e164: null, digits, hadPlus, reason: 'empty' };

  // Only a written `+` carries a country. Without it we cannot know the country
  // and MUST NOT assume one (assuming = inventing phone ownership).
  if (!hadPlus) return { e164: null, digits, hadPlus, reason: 'no-country-code' };

  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
    return { e164: null, digits, hadPlus, reason: 'implausible-length' };
  }

  return { e164: `+${digits}`, digits, hadPlus };
}

// A '+' followed by digits and phone punctuation; \s covers the no-break spaces
// WhatsApp inserts, so no literal invisible character lives in this source.
const PHONE_CANDIDATE = /\+[\d\s()\-.]{7,}\d/g;

/** Every distinct, resolvable E.164 phone in a blob of text (provenance only). */
export function extractPhones(text: string): string[] {
  const out = new Set<string>();
  const candidates = (text ?? '').match(PHONE_CANDIDATE) ?? [];
  for (const c of candidates) {
    const n = normalizePhone(c);
    if (n.e164) out.add(n.e164);
  }
  return [...out];
}
