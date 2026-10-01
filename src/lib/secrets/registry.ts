/**
 * Every key the system uses, and what each is for — the registry behind the
 * Keys & secrets screen.
 *
 * Client-safe: no `server-only`, no database, no environment. The screen, the
 * store door and the resolver all read this one list, so what the panel
 * offers, what the door accepts and what the runtime reads cannot drift.
 *
 * A SLOT is the environment variable's own name. That is the whole contract
 * with the rest of the code: a consumer that used to read
 * `serverEnv().GITHUB_TOKEN` asks `resolveSecret('GITHUB_TOKEN')` and gets the
 * deployment's value if there is one, the vault's value if not.
 *
 * Three kinds of slot:
 *
 *   vault           stored in core.secret_credentials (the generic vault)
 *   provider_vault  the five AI provider keys, stored in the older
 *                   ai.provider_credentials with the same encryption; the
 *                   screen lists them beside the rest and their forms use the
 *                   same doors as Settings
 *   env_only        NEVER storable here, and the reason is stated on screen:
 *                   these are what open the vault (or what the platform itself
 *                   sends), so a key kept in the vault could not be read
 *                   before the vault was open
 */

export const SECRET_CATEGORIES = ['ai', 'code', 'messaging', 'email', 'alerting', 'design', 'calendar', 'platform'] as const;
export type SecretCategory = (typeof SECRET_CATEGORIES)[number];

export const SECRET_CATEGORY_LABEL: Record<SecretCategory, string> = {
  ai: 'AI providers',
  code: 'Code hosting',
  messaging: 'Messaging',
  email: 'Email',
  alerting: 'Alerting',
  design: 'Design',
  calendar: 'Calendar',
  platform: 'Platform (environment only)',
};

export type SecretStorage = 'vault' | 'provider_vault' | 'env_only';

/** A live check the screen can run for a slot. Each maps to an existing verifier — nothing is invented. */
export type SecretVerifier = 'github' | 'whatsapp';

export type SecretSlotDef = {
  /** The environment variable's name — and the slot id. */
  readonly key: string;
  readonly label: string;
  readonly category: SecretCategory;
  readonly storage: SecretStorage;
  /** What stops working without it, in a sentence a person can act on. */
  readonly purpose: string;
  /** Screens and jobs that read it — where a person will notice it missing. */
  readonly usedBy: readonly string[];
  /** For `provider_vault` slots: the provider id the older vault keys it by. */
  readonly provider?: 'anthropic' | 'openai' | 'gemini' | 'xai' | 'openrouter';
  readonly verifier?: SecretVerifier;
  /** A stored key older than this is flagged "rotate" — a reminder, never an enforcement. */
  readonly maxAgeDays: number;
  /** Whether the vendor issues keys that expire, so the form asks for the date. */
  readonly canExpire?: boolean;
  /** Where a person gets one — shown under the form. */
  readonly whereToGetIt?: string;
  /** `env_only` slots: why. */
  readonly envOnlyReason?: string;
  /** What a value looks like, for the door's format check. */
  readonly format?: SecretFormat;
};

export type SecretFormat =
  | { readonly kind: 'min'; readonly min: number }
  | { readonly kind: 'prefix'; readonly prefixes: readonly string[]; readonly min: number }
  | { readonly kind: 'url' }
  | { readonly kind: 'pem' };

export const SECRET_SLOTS: readonly SecretSlotDef[] = [
  // ── AI providers (the older vault) ──────────────────────────────────────
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', category: 'ai', storage: 'provider_vault', provider: 'anthropic', purpose: 'Every agent routed to a Claude model. Without it those agents refuse to run.', usedBy: ['AI agents', 'Requirement collector', 'Quotation drafting'], maxAgeDays: 180, whereToGetIt: 'console.anthropic.com → API keys' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI API key', category: 'ai', storage: 'provider_vault', provider: 'openai', purpose: 'Agents routed to a GPT model, and speech to text for voice notes.', usedBy: ['AI agents', 'Voice-note transcription'], maxAgeDays: 180, whereToGetIt: 'platform.openai.com → API keys' },
  { key: 'GEMINI_API_KEY', label: 'Gemini API key', category: 'ai', storage: 'provider_vault', provider: 'gemini', purpose: 'Agents routed to a Gemini model.', usedBy: ['AI agents'], maxAgeDays: 180, whereToGetIt: 'aistudio.google.com → Get API key' },
  { key: 'XAI_API_KEY', label: 'xAI API key', category: 'ai', storage: 'provider_vault', provider: 'xai', purpose: 'Agents routed to a Grok model.', usedBy: ['AI agents'], maxAgeDays: 180, whereToGetIt: 'console.x.ai → API keys' },
  { key: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', category: 'ai', storage: 'provider_vault', provider: 'openrouter', purpose: 'Agents routed through OpenRouter, and reference-image generation.', usedBy: ['AI agents', 'Reference imagery'], maxAgeDays: 180, whereToGetIt: 'openrouter.ai → Keys' },

  // ── Code hosting ────────────────────────────────────────────────────────
  {
    key: 'GITHUB_TOKEN', label: 'GitHub token', category: 'code', storage: 'vault', verifier: 'github', canExpire: true, maxAgeDays: 90,
    purpose: 'The Repository and Builds tabs read live from GitHub; the branch, review and merge doors write to it. Without it they say "not configured".',
    usedBy: ['Project › Repository', 'Project › Builds', 'Git write doors'],
    whereToGetIt: 'GitHub → Settings → Developer settings → Fine-grained tokens. Repository access: only the AgencyOS repository. Permissions: Contents, Pull requests and Actions read and write; Checks and Commit statuses read.',
    format: { kind: 'prefix', prefixes: ['github_pat_', 'ghp_', 'gho_', 'ghu_', 'ghs_'], min: 30 },
  },

  // ── Messaging ───────────────────────────────────────────────────────────
  { key: 'WHATSAPP_ACCESS_TOKEN', label: 'WhatsApp access token', category: 'messaging', storage: 'vault', verifier: 'whatsapp', maxAgeDays: 60, purpose: 'Every outbound WhatsApp message — quotations, invoices, reminders, campaigns. Without it nothing is sent.', usedBy: ['Communication', 'Invoices', 'Campaigns', 'Follow-ups'], whereToGetIt: 'Meta for Developers → your app → WhatsApp → API setup (a permanent System User token, not the 24-hour test token)', format: { kind: 'min', min: 16 } },
  { key: 'WHATSAPP_APP_SECRET', label: 'WhatsApp app secret', category: 'messaging', storage: 'vault', maxAgeDays: 365, purpose: 'Checks that an inbound WhatsApp webhook really came from Meta. Without it inbound messages are refused.', usedBy: ['WhatsApp webhook'], whereToGetIt: 'Meta for Developers → your app → Settings → Basic → App secret', format: { kind: 'min', min: 16 } },
  { key: 'WHATSAPP_VERIFY_TOKEN', label: 'WhatsApp webhook verify token', category: 'messaging', storage: 'vault', maxAgeDays: 365, purpose: 'The word Meta sends when you register the webhook URL. You choose it; Meta must be told the same one.', usedBy: ['WhatsApp webhook registration'], whereToGetIt: 'You choose it (16+ random characters) and enter the same value in Meta’s webhook settings', format: { kind: 'min', min: 16 } },

  // ── Email ───────────────────────────────────────────────────────────────
  { key: 'RESEND_API_KEY', label: 'Resend API key', category: 'email', storage: 'vault', maxAgeDays: 180, purpose: 'Sending invoices and receipts by email. Without it (and without SMTP) the email button says not configured.', usedBy: ['Invoice email send'], whereToGetIt: 'resend.com → API Keys', format: { kind: 'prefix', prefixes: ['re_'], min: 12 } },
  { key: 'SMTP_PASS', label: 'SMTP password', category: 'email', storage: 'vault', maxAgeDays: 180, purpose: 'The password for the SMTP account, when email goes through SMTP rather than Resend. The host, port and user are not secrets and stay in the environment.', usedBy: ['Invoice email send'], format: { kind: 'min', min: 4 } },

  // ── Alerting ────────────────────────────────────────────────────────────
  { key: 'ALERT_WEBHOOK_URL', label: 'Alert webhook URL', category: 'alerting', storage: 'vault', maxAgeDays: 365, purpose: 'Where failures are sent so a person is paged, not just the log. The URL itself is the secret — anyone holding it can post to that channel.', usedBy: ['Operations alerts'], whereToGetIt: 'Slack → Incoming Webhooks, or your paging tool’s webhook URL', format: { kind: 'url' } },

  // ── Design ──────────────────────────────────────────────────────────────
  { key: 'FIGMA_ACCESS_TOKEN', label: 'Figma access token', category: 'design', storage: 'vault', canExpire: true, maxAgeDays: 90, purpose: 'Reading a linked Figma file for the design tab. Without it the design tab shows the link and nothing more.', usedBy: ['Project › Design'], whereToGetIt: 'Figma → Settings → Security → Personal access tokens (file content: read)', format: { kind: 'min', min: 8 } },

  // ── Calendar ────────────────────────────────────────────────────────────
  { key: 'GOOGLE_SERVICE_ACCOUNT_KEY', label: 'Google service-account private key', category: 'calendar', storage: 'vault', maxAgeDays: 365, purpose: 'Offering and booking meeting times on Google Calendar. Without it availability answers "unconfigured" and no slot is invented.', usedBy: ['Meetings'], whereToGetIt: 'Google Cloud → IAM → Service accounts → Keys → the PEM private_key from the JSON file', format: { kind: 'pem' } },

  // ── Platform: what opens the vault, never stored in it ──────────────────
  { key: 'VAULT_ENCRYPTION_KEY', label: 'Vault encryption key', category: 'platform', storage: 'env_only', maxAgeDays: 0, purpose: 'Encrypts and decrypts every key on this screen.', usedBy: ['This vault'], envOnlyReason: 'It is the key that opens the vault, so it cannot live inside it.' },
  { key: 'SUPABASE_SERVICE_ROLE_KEY', label: 'Database service-role key', category: 'platform', storage: 'env_only', maxAgeDays: 0, purpose: 'Lets trusted server code read the database without a signed-in user — the job runner, and the read that decrypts a vault key.', usedBy: ['Job runner', 'This vault'], envOnlyReason: 'The server needs it to reach the database at all, before it can read anything from the vault.' },
  { key: 'CRON_SECRET', label: 'Scheduler secret', category: 'platform', storage: 'env_only', maxAgeDays: 0, purpose: 'The bearer the hosting platform’s scheduler sends to run the job tick.', usedBy: ['/api/jobs/run'], envOnlyReason: 'The hosting platform sends it from its own configuration; the two must match, so it is set in both places in the hosting dashboard.' },
] as const;

const BY_KEY = new Map(SECRET_SLOTS.map((s) => [s.key, s]));

export function slotFor(key: string): SecretSlotDef | null {
  return BY_KEY.get(key) ?? null;
}

/** The slots a person can store here: everything but the environment-only ones. */
export function storableSlots(): readonly SecretSlotDef[] {
  return SECRET_SLOTS.filter((s) => s.storage !== 'env_only');
}

export function slotsIn(category: SecretCategory): readonly SecretSlotDef[] {
  return SECRET_SLOTS.filter((s) => s.category === category);
}

/**
 * The format check the door runs before it encrypts anything. Returns a
 * sentence for a person, or null when the value is acceptable. It checks SHAPE
 * — a prefix, a length, a URL, a PEM header — and never whether the vendor
 * accepts the value; that is what Verify is for.
 */
export function validateSecretValue(key: string, raw: string): string | null {
  const slot = slotFor(key);
  if (!slot) return `“${key}” is not a key this system uses.`;
  if (slot.storage === 'env_only') return `${slot.label} cannot be stored here. ${slot.envOnlyReason ?? ''}`.trim();
  const value = raw.trim();
  if (value.length === 0) return 'A value is required.';
  if (/\s/.test(value) && slot.format?.kind !== 'pem') return 'The value must not contain spaces or line breaks — check that only the key was pasted.';
  const f = slot.format;
  if (!f) return null;
  switch (f.kind) {
    case 'min':
      return value.length >= f.min ? null : `${slot.label} looks too short (at least ${f.min} characters).`;
    case 'prefix': {
      if (!f.prefixes.some((p) => value.startsWith(p))) return `${slot.label} normally starts with ${f.prefixes.map((p) => `“${p}”`).join(' or ')} — check that the right key was copied.`;
      return value.length >= f.min ? null : `${slot.label} looks too short (at least ${f.min} characters).`;
    }
    case 'url': {
      try {
        const u = new URL(value);
        return u.protocol === 'https:' || u.protocol === 'http:' ? null : 'The URL must start with https://.';
      } catch {
        return 'That is not a URL.';
      }
    }
    case 'pem':
      return /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/.test(value) ? null : 'Paste the whole private key, from the BEGIN line to the END line.';
  }
}

/** The last four characters, so an owner can tell two tokens apart — null for a value too short to show any of. */
export function hintOf(value: string): string | null {
  const v = value.trim();
  return v.length >= 20 ? v.slice(-4) : null;
}

export type ExpiryState = 'none' | 'ok' | 'soon' | 'expired';

/** `soon` is within 14 days. Dates are `YYYY-MM-DD` (a `date` column), compared as days. */
export function expiryState(expiresOn: string | null | undefined, now: Date): ExpiryState {
  if (!expiresOn) return 'none';
  const end = Date.parse(`${expiresOn}T23:59:59Z`);
  if (!Number.isFinite(end)) return 'none';
  const days = Math.floor((end - now.getTime()) / 86_400_000);
  if (days < 0) return 'expired';
  return days <= 14 ? 'soon' : 'ok';
}

/** Whole days since a key was last set, or null when it never was. */
export function ageDays(updatedAt: string | null | undefined, now: Date): number | null {
  if (!updatedAt) return null;
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / 86_400_000)) : null;
}

export function needsRotation(slot: SecretSlotDef, updatedAt: string | null | undefined, now: Date): boolean {
  if (slot.maxAgeDays <= 0) return false;
  const age = ageDays(updatedAt, now);
  return age !== null && age >= slot.maxAgeDays;
}
