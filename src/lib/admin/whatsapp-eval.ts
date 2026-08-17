/**
 * Interpret a Meta Graph API response to a NON-MESSAGE configuration check,
 * into a safe, value-free result. Pure and dependency-free, so it is unit-
 * testable and carries no token — the caller passes only the status and the
 * (already token-free) body, and this turns Meta's codes into sentences an
 * operator can act on.
 */

export type WhatsAppVerifyResult = {
  ok: boolean;
  message: string;
  /** Public WABA facts Meta returns — not secrets. Present only on success. */
  verifiedName?: string;
  displayPhoneNumber?: string;
  qualityRating?: string;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

export function interpretVerify(status: number, body: unknown): WhatsAppVerifyResult {
  if (status === 200 && body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    return {
      ok: true,
      message: 'Reachable — Meta accepted the token and returned the number.',
      verifiedName: str(b.verified_name),
      displayPhoneNumber: str(b.display_phone_number),
      qualityRating: str(b.quality_rating),
    };
  }
  if (status === 401 || status === 403) {
    return { ok: false, message: `Meta rejected the access token (${status}). Check WHATSAPP_ACCESS_TOKEN.` };
  }
  if (status === 404) {
    return {
      ok: false,
      message: "Meta could not find that phone number id (404). Check this organization's WhatsApp number.",
    };
  }
  if (status === 429) {
    return { ok: false, message: 'Meta rate-limited the check (429). The configuration may be fine; try again shortly.' };
  }
  return { ok: false, message: `Meta returned an unexpected status (${status}).` };
}
