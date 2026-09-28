import 'server-only';

import { serverEnv } from '@/lib/env';

/**
 * Fetching what a Lead Ads webhook only points at — audit step 1.1.
 *
 * Meta's Lead Ads webhook delivers a `leadgen_id` and nothing else; the actual
 * form answers are a separate Graph API call, `GET /{leadgen_id}`, made with
 * the Page's access token. Same two-step shape `src/lib/whatsapp/media.ts`
 * already uses for a message's media handle, and the same base URL
 * (`graph.facebook.com`) `src/lib/whatsapp/send.ts` calls — one Meta app,
 * reused rather than a second HTTP client invented for a sibling product.
 *
 * Inert without credentials, on the same pattern every provider call in this
 * repository follows: no token, no fetch, and the caller is told exactly that
 * rather than discovering a silent failure.
 */

const DEFAULT_BASE = 'https://graph.facebook.com/v21.0';

export type LeadgenFields = {
  pageId: string;
  formId: string | null;
  adId: string | null;
  adName: string | null;
  formName: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  /** Every question/answer pair Meta returned, field name to value, raw. */
  fieldData: Record<string, string>;
};

export type FetchLeadgenResult =
  | ({ ok: true } & LeadgenFields)
  | { ok: false; permanent: boolean; message: string };

/** The Graph API's own field-name vocabulary for the three identity questions a lead form commonly asks. */
const NAME_KEYS = ['full_name', 'name'];
const EMAIL_KEYS = ['email'];
const PHONE_KEYS = ['phone_number', 'phone'];

function pick(fieldData: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = fieldData[key];
    if (value) return value;
  }
  return null;
}

/**
 * Fetches one Lead Ad submission's field answers by its `leadgen_id`.
 *
 * @param leadgenId the id the webhook delivered
 */
export async function fetchLeadgenFields(leadgenId: string): Promise<FetchLeadgenResult> {
  const { FACEBOOK_ACCESS_TOKEN, FACEBOOK_GRAPH_BASE_URL } = serverEnv();

  if (!FACEBOOK_ACCESS_TOKEN) {
    return { ok: false, permanent: false, message: 'FACEBOOK_ACCESS_TOKEN is not configured' };
  }

  const base = FACEBOOK_GRAPH_BASE_URL ?? DEFAULT_BASE;
  const url = `${base}/${encodeURIComponent(leadgenId)}?fields=field_data,ad_id,ad_name,form_id,form_name,page_id&access_token=${encodeURIComponent(FACEBOOK_ACCESS_TOKEN)}`;

  let response: Response;
  try {
    response = await fetch(url, { method: 'GET' });
  } catch (cause) {
    return { ok: false, permanent: false, message: `Graph API request failed: ${(cause as Error).message}` };
  }

  if (!response.ok) {
    // 429 and 5xx may pass on a retry; anything else (bad token, unknown id,
    // an expired lead) will not.
    const permanent = response.status !== 429 && response.status < 500;
    return { ok: false, permanent, message: `Graph API responded ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, permanent: false, message: 'Graph API response was not JSON' };
  }

  const record = body as {
    page_id?: string;
    form_id?: string;
    form_name?: string;
    ad_id?: string;
    ad_name?: string;
    field_data?: { name: string; values?: string[] }[];
  };

  const fieldData: Record<string, string> = {};
  for (const entry of record.field_data ?? []) {
    if (entry?.name && Array.isArray(entry.values) && entry.values.length > 0) {
      fieldData[entry.name] = entry.values[0] ?? '';
    }
  }

  return {
    ok: true,
    pageId: record.page_id ?? '',
    formId: record.form_id ?? null,
    adId: record.ad_id ?? null,
    adName: record.ad_name ?? null,
    formName: record.form_name ?? null,
    fullName: pick(fieldData, NAME_KEYS),
    email: pick(fieldData, EMAIL_KEYS),
    phone: pick(fieldData, PHONE_KEYS),
    fieldData,
  };
}
