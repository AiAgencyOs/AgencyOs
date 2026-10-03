/**
 * The integration registry's lifecycle logic — pure, so the one rule the spec is
 * emphatic about is tested without a database: **CONFIGURED is never VERIFIED**.
 * Only an integration a live signal actually exercised (the database answered, the
 * scheduler ticked) may be VERIFIED here. WhatsApp and the AI provider can be
 * CONFIGURED at most from this page — proving them needs the explicit verify
 * actions, which this page points to rather than fakes.
 */

import type { Avail } from './overview-eval';

export type Lifecycle = 'NOT_CONFIGURED' | 'CONFIGURED' | 'VERIFIED' | 'DEGRADED' | 'FAILED' | 'DISABLED';

export type Integration = {
  id: string;
  name: string;
  category: string;
  lifecycle: Lifecycle;
  /** One line of real evidence for the lifecycle state. */
  detail: string;
  /** Where the owner goes to configure or verify it. */
  href: string;
  /** True when moving it forward needs an external credential/action. */
  external: boolean;
  /**
   * The last moment a live check of it answered (ISO), from the record the
   * verify action or the live signal left — null when none has. Never
   * estimated: a row with no recorded check says so.
   */
  lastVerifiedAt?: string | null;
  /** How many records in the product rely on it, where that is countable (Figma references). */
  count?: { label: string; value: number } | null;
};

export type IntegrationSignals = {
  database: Avail<true>; // ok:true means a live read succeeded -> VERIFIED
  cronAgeSeconds: number | null;
  whatsapp: { tokenConfigured: boolean; numberConfigured: Avail<boolean> };
  aiProviderConfigured: Avail<boolean>;
  transcriberConfigured: Avail<boolean>;
  imageGeneratorConfigured: Avail<boolean>;
  alertWebhookConfigured: boolean;
  /**
   * Live Git — Decision: reversed by the owner on 2026-09-29. Whether a
   * GITHUB_TOKEN is present (never its value) and how many projects have
   * linked a repository. Optional so an older caller still evaluates.
   */
  /** Figma: the token's presence, and the design references recorded against it (`projects.theme_options`). */
  figma?: {
    tokenConfigured: boolean;
    references: Avail<{ recorded: number; verified: number; lastVerifiedAt: string | null }>;
  };
  /** Google Calendar: whether the service account and calendar id are present, and when a real free/busy read last answered. */
  calendar?: { configured: boolean; verifiedAt: string | null };
  /** Recorded verification moments from the organisation settings, for the rows that have an explicit verify action. */
  verifiedAt?: { whatsapp?: string | null; aiProvider?: string | null };
  /** The instant the registry was evaluated, for the rows a live signal exercised. */
  now?: string;
  github?: {
    tokenConfigured: boolean;
    linkedRepositories: Avail<number>;
    /** Bucket F — the token's scopes as GitHub states them (null: fine-grained token, none stated); undefined when unread. */
    scopes?: string[] | null;
    mayWrite?: boolean;
  };
};

export function evaluateIntegrations(s: IntegrationSignals): Integration[] {
  const out: Integration[] = [];

  // Database — a successful read IS its verification.
  out.push({
    id: 'database',
    name: 'Supabase (database)',
    category: 'Infrastructure',
    lifecycle: s.database.ok ? 'VERIFIED' : 'FAILED',
    detail: s.database.ok ? 'a live query succeeded' : 'DATA UNAVAILABLE — a live query failed',
    href: '/production-readiness',
    external: false,
    lastVerifiedAt: s.database.ok ? (s.now ?? null) : null,
  });

  // Scheduler — the heartbeat verifies or fails it.
  const stale = s.cronAgeSeconds === null || s.cronAgeSeconds > 15 * 60;
  out.push({
    id: 'scheduler',
    name: 'Cron scheduler',
    category: 'Infrastructure',
    lifecycle: s.cronAgeSeconds === null ? 'FAILED' : stale ? 'DEGRADED' : 'VERIFIED',
    detail:
      s.cronAgeSeconds === null
        ? 'DATA UNAVAILABLE — no heartbeat could be read'
        : stale
          ? `last tick ${Math.floor(s.cronAgeSeconds / 60)}m ago`
          : `last tick ${s.cronAgeSeconds}s ago`,
    href: '/operations',
    external: true,
    lastVerifiedAt: s.cronAgeSeconds !== null && s.now ? new Date(Date.parse(s.now) - s.cronAgeSeconds * 1000).toISOString() : null,
  });

  // WhatsApp / Meta — CONFIGURED at most from here; verification is an action.
  const number = s.whatsapp.numberConfigured;
  const whatsappConfigured = s.whatsapp.tokenConfigured && number.ok && number.value;
  out.push({
    id: 'whatsapp',
    name: 'WhatsApp / Meta',
    category: 'Messaging',
    lifecycle: !number.ok ? 'FAILED' : whatsappConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED',
    detail: !number.ok
      ? 'DATA UNAVAILABLE'
      : whatsappConfigured
        ? 'token + phone number id present — verify on Settings (not proven here)'
        : 'token or phone number id missing',
    href: '/settings',
    external: true,
    lastVerifiedAt: s.verifiedAt?.whatsapp ?? null,
  });

  // AI provider — CONFIGURED at most; runtime verification is an action.
  const ai = s.aiProviderConfigured;
  out.push({
    id: 'ai-provider',
    name: 'AI provider',
    category: 'AI',
    lifecycle: !ai.ok ? 'FAILED' : ai.value ? 'CONFIGURED' : 'NOT_CONFIGURED',
    detail: !ai.ok ? 'DATA UNAVAILABLE' : ai.value ? 'a provider key is present — verify before enabling agents' : 'no provider configured',
    href: '/agents',
    external: true,
    lastVerifiedAt: s.verifiedAt?.aiProvider ?? null,
  });

  // Transcription (ADM-94) — a separate registry and a separate decision from
  // the AI provider above; kept apart for the same reason the router keeps
  // them apart (a vendor named for one capability is not thereby chosen for
  // another).
  const transcriber = s.transcriberConfigured;
  out.push({
    id: 'transcriber',
    name: 'Speech to text',
    category: 'AI',
    lifecycle: !transcriber.ok ? 'FAILED' : transcriber.value ? 'CONFIGURED' : 'NOT_CONFIGURED',
    detail: !transcriber.ok
      ? 'DATA UNAVAILABLE'
      : transcriber.value
        ? 'a transcription key is present — verify before relying on it'
        : 'no transcriber configured — a recording cannot be turned into words',
    href: '/agents',
    external: true,
  });

  // Image generation (Designer §9, ADM-111) — optional; Phase 3 never depends
  // on it existing.
  const imageGenerator = s.imageGeneratorConfigured;
  out.push({
    id: 'image-generator',
    name: 'Image generation',
    category: 'AI',
    lifecycle: !imageGenerator.ok ? 'FAILED' : imageGenerator.value ? 'CONFIGURED' : 'NOT_CONFIGURED',
    detail: !imageGenerator.ok
      ? 'DATA UNAVAILABLE'
      : imageGenerator.value
        ? 'an image-generation key is present — verify before relying on it'
        : 'no image generator configured — optional reference imagery cannot be drawn',
    href: '/agents',
    external: true,
  });

  // Alerts — configured or degraded (only logged).
  out.push({
    id: 'alerts',
    name: 'Operational alerting',
    category: 'Observability',
    lifecycle: s.alertWebhookConfigured ? 'CONFIGURED' : 'DEGRADED',
    detail: s.alertWebhookConfigured ? 'ALERT_WEBHOOK_URL is set' : 'unset — failures are only written to the log',
    href: '/settings',
    external: true,
  });

  // GitHub — read (Decision: reversed by the owner on 2026-09-29) and written through governed doors (Decision: reversed by the owner on 2026-09-30).
  // CONFIGURED at most: a token being present says nothing about whether it
  // can read a given repository; each project's Repository tab is where a
  // real read succeeds or says why not. The count is of links, not of
  // anything GitHub answered.
  if (s.github) {
    const links = s.github.linkedRepositories;
    const linked = links.ok ? links.value : null;
    const linkedText =
      linked === null
        ? 'linked repositories: DATA UNAVAILABLE'
        : `${linked} linked ${linked === 1 ? 'repository' : 'repositories'}`;
    const scopesText =
      s.github.scopes === undefined
        ? 'scopes not read yet'
        : s.github.scopes === null
          ? 'scopes not stated (fine-grained token)'
          : s.github.scopes.length === 0
            ? 'no scopes'
            : `scopes: ${s.github.scopes.join(', ')}`;
    const writeText = s.github.mayWrite === undefined ? '' : s.github.mayWrite ? '; branch, review, merge and build dispatch may be written' : '; the write doors will be refused (no repo scope)';
    out.push({
      id: 'github',
      name: 'GitHub',
      category: 'Source control',
      lifecycle: !links.ok ? 'FAILED' : s.github.tokenConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED',
      detail: s.github.tokenConfigured
        ? `GITHUB_TOKEN is set — ${linkedText}; ${scopesText}${writeText}; each project's Repository tab reads live`
        : `GITHUB_TOKEN unset — ${linkedText}; links are kept, nothing is read or written`,
      href: '/settings',
      external: true,
    });
  }

  // Figma — the design references the token checks. VERIFIED only when a
  // reference was actually checked against Figma (`figma_verified_at`); a
  // token alone is CONFIGURED.
  if (s.figma) {
    const refs = s.figma.references;
    const verified = refs.ok && refs.value.verified > 0 && refs.value.lastVerifiedAt !== null;
    out.push({
      id: 'figma',
      name: 'Figma',
      category: 'Design',
      lifecycle: !refs.ok ? 'FAILED' : !s.figma.tokenConfigured ? 'NOT_CONFIGURED' : verified ? 'VERIFIED' : 'CONFIGURED',
      detail: !refs.ok
        ? 'DATA UNAVAILABLE — design references could not be counted'
        : !s.figma.tokenConfigured
          ? `FIGMA_ACCESS_TOKEN unset — ${refs.value.recorded} reference${refs.value.recorded === 1 ? '' : 's'} recorded unchecked; nothing is read from Figma`
          : `${refs.value.recorded} design reference${refs.value.recorded === 1 ? '' : 's'} recorded, ${refs.value.verified} checked against Figma${verified ? '' : ' — verify to prove the token can read a file'}`,
      href: '/integrations',
      external: true,
      lastVerifiedAt: refs.ok ? refs.value.lastVerifiedAt : null,
      count: refs.ok ? { label: 'references', value: refs.value.recorded } : null,
    });
  }

  // Google Calendar — a real free/busy read is its verification (ADM-102).
  if (s.calendar) {
    out.push({
      id: 'calendar',
      name: 'Google Calendar',
      category: 'Scheduling',
      lifecycle: !s.calendar.configured ? 'NOT_CONFIGURED' : s.calendar.verifiedAt ? 'VERIFIED' : 'CONFIGURED',
      detail: !s.calendar.configured
        ? 'service account or calendar id missing — availability answers unconfigured and nothing is booked'
        : s.calendar.verifiedAt
          ? 'a real free/busy read answered'
          : 'credentials present — verify to prove Google answers',
      href: '/integrations',
      external: true,
      lastVerifiedAt: s.calendar.verifiedAt,
    });
  }

  return out;
}

/** The most recent recorded check across the registry — the aggregate "last verified", or null when no row has one. */
export function latestVerification(list: readonly Integration[]): string | null {
  let latest: string | null = null;
  for (const i of list) {
    if (!i.lastVerifiedAt || !Number.isFinite(Date.parse(i.lastVerifiedAt))) continue;
    if (latest === null || Date.parse(i.lastVerifiedAt) > Date.parse(latest)) latest = i.lastVerifiedAt;
  }
  return latest;
}

export function integrationsSummary(list: readonly Integration[]): Record<Lifecycle, number> {
  const base: Record<Lifecycle, number> = {
    NOT_CONFIGURED: 0, CONFIGURED: 0, VERIFIED: 0, DEGRADED: 0, FAILED: 0, DISABLED: 0,
  };
  for (const i of list) base[i.lifecycle] += 1;
  return base;
}
