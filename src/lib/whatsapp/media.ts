import 'server-only';

import { serverEnv } from '@/lib/env';
import { AI_IMAGE_MEDIA_TYPES, type AiImageMediaType } from '@/lib/ai/types';

/**
 * Fetching what a client sent — the other half of `send.ts`.
 *
 * A WhatsApp media message carries a handle, not a file. Reading it is two
 * calls: ask the Graph API what the handle points at, then fetch that, with
 * the same bearer token. The URL it hands back is short-lived by design, which
 * is why this is done once, at the moment somebody looks, rather than at every
 * turn of the conversation.
 *
 * **The bytes are returned and never stored.** There is no bucket, no
 * retention rule and no second access-control surface anywhere in this system;
 * the caller hands them to the model and drops them. That is a deliberate
 * answer to §27 of the owner's brief — a client's photograph cannot leak to
 * another client if no copy of it exists.
 *
 * Inert without credentials, on the same pattern `send.ts` follows: no token,
 * no fetch, and the caller is told exactly that rather than discovering a
 * silent failure.
 */

/** Where the Graph API lives. Overridable so a test can point at a stub. */
const DEFAULT_BASE = 'https://graph.facebook.com/v21.0';

/**
 * The raw-byte ceiling.
 *
 * Anthropic accepts an image of about 5 MB *once base64 encoded*, and base64
 * inflates by roughly a third — so the honest raw limit is nearer 3.5 MB. A
 * larger image is refused here, with its size named, rather than sent and
 * rejected by the vendor in the vendor's words.
 *
 * WhatsApp's own cap for an image is 5 MB, so this bites rarely and never
 * silently.
 */
export const MAX_IMAGE_BYTES = 3_500_000;

export type FetchedMedia = {
  mediaType: AiImageMediaType;
  dataBase64: string;
  byteLength: number;
};

/**
 * Classified exactly as `SendResult` is, and for the same reason: the caller
 * is a job with an attempt budget, and "try again" and "this will never work"
 * are different answers.
 *
 *   permanent  the handle is gone (Meta expires media), the file is not an
 *              image this port carries, it is too large, or the request was
 *              refused — every retry sends the same request to the same no.
 *   transient  429, any 5xx, a transport failure or timeout, and a missing
 *              deployment token, which a later deploy supplies.
 */
export type FetchMediaResult =
  | ({ ok: true } & FetchedMedia)
  | { ok: false; permanent: boolean; message: string };

/**
 * Where a media URL is allowed to point.
 *
 * The URL is handed to us by an API response, and a response is data. Without
 * this, anything that could shape that response — a compromised token, a
 * misconfigured base, a proxy — could aim an authenticated, server-side fetch
 * at an address of its choosing, which is the ordinary shape of an SSRF.
 *
 * Two ways to be allowed, both narrow: the same origin as the configured Graph
 * base (which is what makes a local stub work, and in production IS Meta), or
 * https on a host Meta actually serves media from.
 */
const MEDIA_HOST_SUFFIXES = ['.fbcdn.net', '.fbsbx.com', '.facebook.com'] as const;

export function mediaUrlIsAllowed(rawUrl: string, graphBase: string): boolean {
  let url: URL;
  let base: URL;
  try {
    url = new URL(rawUrl);
    base = new URL(graphBase);
  } catch {
    return false;
  }

  if (url.origin === base.origin) return true;

  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return MEDIA_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function asImageMediaType(raw: string | undefined): AiImageMediaType | null {
  // Meta reports `image/jpeg` and sometimes `image/jpeg; codecs=...`-style
  // parameters; the type is the part before the first semicolon.
  const bare = (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return (AI_IMAGE_MEDIA_TYPES as readonly string[]).includes(bare)
    ? (bare as AiImageMediaType)
    : null;
}

/**
 * Read one image a client sent, by the handle the webhook recorded.
 *
 * Returns the bytes base64 encoded, because that is the form the AI port
 * takes and holding them twice for no reason is how a large image becomes a
 * memory problem.
 */
export async function fetchWhatsAppImage(mediaId: string): Promise<FetchMediaResult> {
  const env = serverEnv();

  if (!env.WHATSAPP_ACCESS_TOKEN) {
    // Transient, exactly as in send.ts: a deployment that has not set its token
    // yet may set it, and refusing forever over a deploy gap is the wrong
    // answer to a fixable state.
    return { ok: false, permanent: false, message: 'WhatsApp media reading is not configured on this deployment.' };
  }

  if (!mediaId.trim()) {
    return { ok: false, permanent: true, message: 'No media id was recorded for this message.' };
  }

  const base = env.WHATSAPP_GRAPH_BASE_URL ?? DEFAULT_BASE;
  const auth = { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` };

  // ── 1. what does the handle point at? ────────────────────────────────────
  let lookup: Response;
  try {
    lookup = await fetch(`${base}/${encodeURIComponent(mediaId.trim())}`, {
      headers: auth,
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown';
    console.error(JSON.stringify({ level: 'error', scope: 'fetchWhatsAppImage.lookup', detail }));
    return { ok: false, permanent: false, message: 'WhatsApp could not be reached.' };
  }

  const lookupText = await lookup.text();

  if (!lookup.ok) {
    // Logged in full, reported in summary — a Graph error body carries the
    // token's scopes and the account id, and neither belongs on a screen.
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'fetchWhatsAppImage.lookup',
        status: lookup.status,
        detail: lookupText.slice(0, 500),
      }),
    );
    const permanent = lookup.status >= 400 && lookup.status < 500 && lookup.status !== 429;
    return {
      ok: false,
      permanent,
      message: `WhatsApp would not describe the image (${lookup.status}).`,
    };
  }

  let described: { url?: string; mime_type?: string; file_size?: number };
  try {
    described = JSON.parse(lookupText) as typeof described;
  } catch {
    return { ok: false, permanent: false, message: 'WhatsApp described the image unreadably.' };
  }

  const mediaType = asImageMediaType(described.mime_type);
  if (!mediaType) {
    // Permanent: the file is what it is. A PDF sent as `image` — or an HEIC,
    // which iPhones produce and this port does not carry — will never become
    // one of the four on a retry.
    return {
      ok: false,
      permanent: true,
      message: `This file is ${described.mime_type ?? 'of an unknown type'}, which cannot be read as an image.`,
    };
  }

  if (typeof described.file_size === 'number' && described.file_size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      permanent: true,
      message: `The image is ${Math.round(described.file_size / 1000)} kB, over the ${Math.round(MAX_IMAGE_BYTES / 1000)} kB a model will accept.`,
    };
  }

  if (!described.url || !mediaUrlIsAllowed(described.url, base)) {
    // Permanent, and loud. Either Meta returned nothing to fetch, or it named
    // a host this deployment will not send its token to.
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'fetchWhatsAppImage.url',
        detail: described.url ? 'media url is not on an allowed host' : 'media url absent',
      }),
    );
    return { ok: false, permanent: true, message: 'WhatsApp did not give a usable address for the image.' };
  }

  // ── 2. the file itself ───────────────────────────────────────────────────
  let download: Response;
  try {
    download = await fetch(described.url, {
      headers: auth,
      cache: 'no-store',
      // Longer than the lookup: this is bytes over a CDN, not a JSON reply.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown';
    console.error(JSON.stringify({ level: 'error', scope: 'fetchWhatsAppImage.download', detail }));
    return { ok: false, permanent: false, message: 'The image could not be downloaded.' };
  }

  if (!download.ok) {
    const permanent = download.status >= 400 && download.status < 500 && download.status !== 429;
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'fetchWhatsAppImage.download',
        status: download.status,
      }),
    );
    return {
      ok: false,
      permanent,
      message: `The image could not be downloaded (${download.status}).`,
    };
  }

  const bytes = new Uint8Array(await download.arrayBuffer());

  // Checked again after the fact, not only from `file_size`: the header is the
  // provider's claim about the file and this is the file. A body that arrives
  // larger than advertised is exactly the case a declared size cannot catch.
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      permanent: true,
      message: `The image is ${Math.round(bytes.byteLength / 1000)} kB, over the ${Math.round(MAX_IMAGE_BYTES / 1000)} kB a model will accept.`,
    };
  }

  if (bytes.byteLength === 0) {
    return { ok: false, permanent: false, message: 'The image downloaded as an empty file.' };
  }

  return {
    ok: true,
    mediaType,
    dataBase64: Buffer.from(bytes).toString('base64'),
    byteLength: bytes.byteLength,
  };
}
