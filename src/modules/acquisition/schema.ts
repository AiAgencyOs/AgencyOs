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
    summary: 'The campaign pipeline is built: plans with versions, checks that can fail but never approve, exact-version admin approval (a budget increase or a targeting change is its own approval), a cap the Admin sets, pause that reaches the money, spend counted once, health findings, and results read from the CRM by first touch. NOT built: the Meta connector (so an approved launch is flagged for a person to apply by hand), pulling the platform\'s figures, and the AI that plans and optimises.',
  },
  email: {
    build: 'partial',
    summary: 'Governed sending from info@, opt-out, bounce handling and reply reading are live. A reply is adopted into the shared identity with the email agent as owner; prospects are qualified against the Admin\'s weights and rules; drafts are checked against recorded research; a follow-up is re-checked when it is sent. Finding prospects on the open web and an AI writing the message are NOT built yet - they need a discovery source and a funded model.',
    link: { href: '/communication/email-outreach', label: 'Open email outreach' },
  },
  social: {
    build: 'partial',
    summary: 'The content pipeline is built: drafts, an automated review that can fail but never approve, exact-version admin approval, scheduling, and publish-once. Strategies and audits are recorded. NOT built: connecting LinkedIn, Instagram or Facebook (so a due post is flagged for a person to post by hand), reading account analytics, and the AI that plans and writes.',
  },
  google_ads: {
    build: 'partial',
    summary: 'The campaign pipeline is the same as Meta\'s, with Google\'s rules (keywords, negatives, headline lengths). Landing pages are built too: versions approved as exactly their content, address and WhatsApp number, a governed deploy, and a verification of the public address - a Google ad can only launch to a VERIFIED page, and a visit that becomes a WhatsApp message is credited to its campaign. NOT built: the Google Ads connector and the Hostinger deployer, so an approved launch or page is applied by hand and nothing here is shown live until it has been checked.',
  },
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
