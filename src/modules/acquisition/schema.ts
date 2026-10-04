/**
 * Lead generation — vocabulary shared by the server and the screens. Client-safe: no server imports.
 *
 * The five engines are a closed list because the database says so (crm.acquisition_channels CHECK); the
 * business facts that change — which service is targeted, who the ideal customer is, what a channel may
 * spend — are DATA read from the database, never constants here.
 */

export const ACQUISITION_CHANNELS = ['meta_ads', 'email', 'social', 'google_ads', 'b2b'] as const;
export type AcquisitionChannel = (typeof ACQUISITION_CHANNELS)[number];

export const CHANNEL_LABEL: Record<AcquisitionChannel, string> = {
  meta_ads: 'Meta / Facebook Ads',
  email: 'Email',
  social: 'Social Media',
  google_ads: 'Google Ads',
  b2b: 'B2B',
};

/** The URL segment for a channel tab. */
export const CHANNEL_SLUG: Record<AcquisitionChannel, string> = {
  meta_ads: 'meta',
  email: 'email',
  social: 'social',
  google_ads: 'google',
  b2b: 'b2b',
};

export function channelFromSlug(slug: string): AcquisitionChannel | null {
  return ACQUISITION_CHANNELS.find((c) => CHANNEL_SLUG[c] === slug) ?? null;
}

/**
 * How far each engine has actually been built. This is the honest status the screens print, and it is
 * updated in the same change that builds an engine — it exists so a tab can never imply working
 * automation that is not there (spec §98/§99).
 */
export type EngineBuild = 'not_built' | 'partial' | 'built';
export const ENGINE_STATUS: Record<AcquisitionChannel, { build: EngineBuild; summary: string; link?: { href: string; label: string } }> = {
  meta_ads: { build: 'not_built', summary: 'The Ad Manager agent and the Meta connector are not built yet. Click-to-WhatsApp ad attribution is already captured on a lead.' },
  email: {
    build: 'partial',
    summary: 'Governed sending from info@, opt-out, bounce handling and reply reading are live. A reply is adopted into the shared identity with the email agent as owner; prospects are qualified against the Admin\'s weights and rules; drafts are checked against recorded research; a follow-up is re-checked when it is sent. Finding prospects on the open web and an AI writing the message are NOT built yet - they need a discovery source and a funded model.',
    link: { href: '/communication/email-outreach', label: 'Open email outreach' },
  },
  social: { build: 'not_built', summary: 'The Social Media Marketing agent, content approval pipeline and publishing are not built yet.' },
  google_ads: { build: 'not_built', summary: 'The Google Ads connector, landing-page engine and Hostinger deployment are not built yet.' },
  b2b: { build: 'not_built', summary: 'The B2B opportunity agent and platform connectors are not built yet.' },
};

export const ICP_LIST_KEYS = ['industries', 'geographies', 'company_sizes', 'personas', 'exclusions'] as const;
export type IcpListKey = (typeof ICP_LIST_KEYS)[number];
export const ICP_LIST_LABEL: Record<IcpListKey, string> = {
  industries: 'Industries',
  geographies: 'Countries / regions',
  company_sizes: 'Company sizes',
  personas: 'Decision-maker roles',
  exclusions: 'Exclusions (never target)',
};

export type IcpDefinition = Partial<Record<IcpListKey, string[]>> & { min_qualification_score?: number };

/** One line per item, trimmed, empties dropped, capped so a pasted file cannot become the profile. */
export function parseList(raw: string): string[] {
  return [...new Set(raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))].slice(0, 100);
}

export function buildIcpDefinition(input: Partial<Record<IcpListKey, string>> & { minScore?: string }): IcpDefinition {
  const def: IcpDefinition = {};
  for (const key of ICP_LIST_KEYS) {
    const list = parseList(input[key] ?? '');
    if (list.length > 0) def[key] = list;
  }
  const raw = (input.minScore ?? '').trim();
  if (raw !== '') def.min_qualification_score = Number(raw);
  return def;
}

export const PAUSE_REASON_MAX = 500;
