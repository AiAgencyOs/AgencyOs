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
  meta_ads: {
    build: 'partial',
    summary: 'The campaign pipeline is built: plans with versions, checks that can fail but never approve, exact-version admin approval (a budget increase or a targeting change is its own approval), a cap the Admin sets that counts budget already committed and not only money spent, spend counted once from the figures a person copies in, health findings, and results read from the CRM by first touch. A person applies an approved launch on the platform and records it here; a pause or end is an intent that a person confirms once the platform has really done it. NOT built: the Meta connector - nothing is pushed to or read from Meta, so a pause cannot reach the money by itself - and the AI that plans and optimises.',
  },
  email: {
    build: 'partial',
    summary: 'Governed sending from info@, opt-out, bounce handling and reply reading are live. A reply is adopted into the shared identity with the email agent as owner; prospects are qualified against the Admin\'s weights and rules; a draft can be checked against the facts recorded about the person (nothing writes drafts yet); a follow-up is re-checked when it is sent. Finding prospects on the open web and an AI writing the message are NOT built yet - they need a discovery source and a funded model.',
    link: { href: '/communication/email-outreach', label: 'Open email outreach' },
  },
  social: {
    build: 'partial',
    summary: 'The content pipeline is built: drafts, an automated review that can fail but never approve, exact-version admin approval, scheduling, and publish-once. Strategies and audits are recorded. A due post is flagged for a person, who posts it on the platform and records it here. NOT built: connecting LinkedIn, Instagram or Facebook, reading account analytics, and the AI that plans and writes.',
  },
  google_ads: {
    build: 'partial',
    summary: 'The campaign pipeline is the same as Meta\'s, with Google\'s rules (keywords, negatives, headline lengths). Landing pages are built too: versions approved as exactly their content, address and WhatsApp number; a person uploads the approved page (the app renders it for download) and records it; the app then FETCHES the public address and records what it found - only a page that carries exactly the approved version is VERIFIED, and a Google ad can only launch to a VERIFIED page. A visit that becomes a WhatsApp message is credited to its campaign. NOT built: the Google Ads connector and the Hostinger deployer, so launches and uploads are done by hand and recorded here.',
  },
  b2b: {
    build: 'partial',
    summary: 'The opportunity pipeline is built: jobs you record are scored against your own thresholds, proposals are checked, approved as exactly these words and this price (only a person sets a price) and recorded as sent once, profile changes follow the same path, and a marketplace\'s own rule decides whether a conversation may be taken to WhatsApp (the default is never). NOT built: any marketplace connector - nothing is read from or sent to a platform, so a person finds the jobs and sends the approved proposals - and the AI that finds and writes them.',
  },
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
