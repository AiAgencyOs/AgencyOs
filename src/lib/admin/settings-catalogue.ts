import { can, type Capability, type RoleSubject } from '@/lib/authz/permissions';
import { SECRET_CATEGORY_LABEL, SECRET_SLOTS } from '@/lib/secrets/registry';

/**
 * Every setting and every key an owner can look for by name — the list the ⌘K
 * palette searches.
 *
 * The palette used to reach five Settings tabs and stop there; an owner who
 * wanted "the GST number" or "the WhatsApp window" had to remember which tab
 * it lived on. This is the index that removes the remembering: one entry per
 * thing a person might type, each with the page and the anchor of the section
 * that holds its form.
 *
 * Client-safe: plain data plus one pure filter. The palette receives the
 * already-filtered result from the layout, so what it offers is exactly what
 * the role may open (the same `can()` every settings page re-runs).
 *
 * Three kinds:
 *
 *   org-setting  `key` IS the key in `core.organizations.settings`. The guard
 *                test checks it against the whitelist the database owns
 *                (`core.set_organization_setting`), so an entry cannot name a
 *                key the door would refuse.
 *   section      a settings section with no key of that kind — the agency
 *                name, GST identity, the approval policy. `key` is a slug.
 *   secret       a slot of the Keys & secrets registry, generated from it, so
 *                a new slot is findable the day it is added.
 *
 * Every `href` carries an anchor, and the guard test checks that the anchor is
 * an `id` in the page's own source.
 */

export type SettingsEntryKind = 'org-setting' | 'section' | 'secret';

export type SettingsEntry = {
  /** Unique across the catalogue. For `org-setting` it is the database key itself. */
  key: string;
  kind: SettingsEntryKind;
  label: string;
  /** The page and the section's anchor: `/settings/finance#gst-identity`. */
  href: string;
  /** Other words a person might type for it. Matched as well as the label. */
  keywords: readonly string[];
  /** What the role must hold to open the page. Every settings page and the keys page ask for this one. */
  capability: Capability;
};

const SETTINGS: Capability = 'organization.settings';

const setting = (key: string, label: string, href: string, keywords: readonly string[]): SettingsEntry => ({
  key,
  kind: 'org-setting',
  label,
  href,
  keywords,
  capability: SETTINGS,
});

const section = (key: string, label: string, href: string, keywords: readonly string[]): SettingsEntry => ({
  key,
  kind: 'section',
  label,
  href,
  keywords,
  capability: SETTINGS,
});

/** The settings pages' entries, tab by tab. */
export const SETTINGS_ENTRIES: readonly SettingsEntry[] = [
  // ── General ─────────────────────────────────────────────────────────────
  section('organization_name', 'Agency name', '/settings#agency-name', ['letterhead', 'company', 'organization', 'rename']),
  setting('quotation_contact_email', 'Quotation contact email', '/settings#quotation-contact', ['contact', 'quotation', 'pdf', 'email']),
  setting('quotation_contact_phone', 'Quotation contact phone', '/settings#quotation-contact', ['contact', 'quotation', 'pdf', 'phone', 'number']),
  setting('quotation_contact_location', 'Quotation contact location', '/settings#quotation-contact', ['contact', 'quotation', 'pdf', 'address', 'place']),
  section('agency_timezone', 'Agency timezone', '/settings#agency-timezone', ['time zone', 'ist', 'clock', 'follow-up', 'iana']),

  // ── Commercial ──────────────────────────────────────────────────────────
  setting('pricing_day_rate_rupees', 'Developer day rate', '/settings/commercial#pricing-model', ['pricing', 'rate', 'rupees', 'cost', 'price']),
  setting('pricing_ai_day_rate_rupees', 'AI-assisted day rate', '/settings/commercial#pricing-model', ['pricing', 'rate', 'rupees', 'cost', 'ai']),
  setting('pricing_multiplier_min', 'Pricing multiplier, minimum', '/settings/commercial#pricing-model', ['pricing', 'multiplier', 'band', 'floor']),
  setting('pricing_multiplier_target', 'Pricing multiplier, recommended', '/settings/commercial#pricing-model', ['pricing', 'multiplier', 'band', 'target']),
  setting('pricing_multiplier_max', 'Pricing multiplier, premium', '/settings/commercial#pricing-model', ['pricing', 'multiplier', 'band', 'ceiling']),
  section('payment_terms', 'Payment terms', '/settings/commercial#payment-terms', ['milestones', 'advance', 'instalments', 'when the client pays']),
  setting('quotation_validity_days', 'How long a quotation stands', '/settings/commercial#quotation-validity', ['validity', 'expiry', 'valid for', 'days', 'quotation']),
  section('third_party_charges', 'Third-party charges', '/settings/commercial#third-party-charges', ['pass-through', 'hosting', 'licence', 'license', 'charges']),
  setting('negotiation_max_rounds', 'Negotiation: most rounds', '/settings/commercial#negotiation-limits', ['negotiation', 'limit', 'agent', 'rounds']),
  setting('negotiation_min_price_rupees', 'Negotiation: lowest price', '/settings/commercial#negotiation-limits', ['negotiation', 'limit', 'agent', 'floor', 'minimum price']),
  setting('negotiation_max_discount_pct', 'Negotiation: largest discount', '/settings/commercial#negotiation-limits', ['negotiation', 'limit', 'agent', 'discount', 'percent']),
  setting('negotiation_max_autonomous_quote_rupees', 'Negotiation: largest quote the agent may send alone', '/settings/commercial#negotiation-limits', ['negotiation', 'limit', 'agent', 'autonomous', 'ceiling']),
  section('approved_offer', 'An offer the agent may apply', '/settings/commercial#approved-offer', ['discount', 'concession', 'price objection', 'agent']),

  // ── Communication ───────────────────────────────────────────────────────
  section('internal_group', 'Internal WhatsApp group', '/settings/communication#internal-group', ['group', 'whatsapp', 'approvals', 'handover']),
  section('announcements_number', 'Announcements number', '/settings/communication#announcements-number', ['whatsapp', 'recipient', 'approvals', 'handover']),
  section('announcements', 'Announcements', '/settings/communication#announcements', ['broadcast', 'notice', 'team', 'clients']),
  section('whatsapp_templates', 'WhatsApp templates outside the 24-hour window', '/settings/communication#whatsapp-templates', ['whatsapp', 'template', 'meta', 'approved', 'window', 'follow-up']),
  section('whatsapp_template_history', 'WhatsApp template history', '/settings/communication#template-history', ['whatsapp', 'template', 'versions', 'changes']),
  section('outreach_limits', 'How often AgencyOS starts a conversation', '/settings/communication#outreach-limits', ['outreach', 'limit', 'per day', 'per week', 'cooldown', 'frequency', 'whatsapp']),
  setting('outreach_window_start_hour', 'Sending window: opens at', '/settings/communication#outreach-window', ['window', 'hours', 'follow-up', 'send', 'business hours', 'start']),
  setting('outreach_window_end_hour', 'Sending window: closes at', '/settings/communication#outreach-window', ['window', 'hours', 'follow-up', 'send', 'business hours', 'end']),
  section('wake_on_inbound', 'How quickly the agent answers', '/settings/communication#wake-on-inbound', ['wake', 'inbound', 'reply', 'agent', 'speed']),
  section('reactivation_pilot', 'Historical-lead reactivation', '/settings/communication#reactivation', ['reactivation', 'pilot', 'inactive', 'nurture', 'cohort']),
  setting('reactivation_max_per_run', 'Reactivation per-run cap', '/settings/communication#reactivation-cap', ['reactivation', 'cap', 'ceiling', 'batch', 'worker']),
  setting('whatsapp_phone_number_id', 'WhatsApp phone number id', '/settings/communication#whatsapp', ['whatsapp', 'meta', 'number', 'verify', 'phone_number_id']),
  setting('whatsapp_test_recipient', 'WhatsApp test recipient', '/settings/communication#whatsapp-test-recipient', ['whatsapp', 'test', 'first send', 'internal number']),

  // ── Team ────────────────────────────────────────────────────────────────
  setting('project_group_identifier', 'Project group name suffix', '/settings/team#project-group-names', ['project group', 'whatsapp', 'identifier', 'naming']),
  section('default_design_reviewer', 'Who reviews design work', '/settings/team#design-reviewer', ['design', 'reviewer', 'gate', 'default']),

  // ── Approvals ───────────────────────────────────────────────────────────
  section('approval_policy', 'Who must approve what', '/settings/approvals#approval-policy', ['approval', 'approver', 'policy', 'role', 'sign-off']),

  // ── Finance ─────────────────────────────────────────────────────────────
  section('receiving_accounts', 'Receiving accounts', '/settings/finance#receiving-accounts', ['bank', 'upi', 'payment account', 'invoice', 'ifsc']),
  section('past_due_reminders', 'Past-due invoice reminders', '/settings/finance#past-due-reminders', ['reminder', 'overdue', 'invoice', 'interval', 'dunning']),
  section('gst_identity', 'GST identity', '/settings/finance#gst-identity', ['gst', 'gstin', 'tax', 'sac', 'state code', 'invoice']),
  section('invoice_numbering', 'Invoice numbering and terms', '/settings/finance#invoice-numbering', ['invoice', 'number', 'prefix', 'terms', 'due', 'net days', 'payment terms']),
  setting('won_requires_payment_evidence', 'Payment evidence before a deal is won', '/settings/finance#won-gate', ['won', 'deal', 'payment', 'gate', 'evidence', 'advance']),
];

/** The Keys & secrets slots, one entry each, generated from the registry so it cannot drift from the screen. */
export const SECRET_ENTRIES: readonly SettingsEntry[] = SECRET_SLOTS.map((slot) => ({
  key: `secret:${slot.key}`,
  kind: 'secret' as const,
  label: slot.label,
  href: `/security/keys#${slot.key}`,
  keywords: [
    slot.key,
    slot.key.replace(/_/g, ' '),
    'key',
    'secret',
    'token',
    'vault',
    SECRET_CATEGORY_LABEL[slot.category],
    ...slot.usedBy,
  ],
  // The keys screen is viewed and verified by the owner and the ops admin (audit.read); the owner alone stores.
  capability: 'audit.read',
}));

export const SETTINGS_CATALOGUE: readonly SettingsEntry[] = [...SETTINGS_ENTRIES, ...SECRET_ENTRIES];

/** The palette's group heading for an entry. */
export function groupOf(entry: SettingsEntry): string {
  return entry.kind === 'secret' ? 'Keys & secrets' : 'Settings';
}

/** The entries a role may open — the same `can()` the destination page runs for itself. */
export function catalogueFor(subject: RoleSubject): SettingsEntry[] {
  return SETTINGS_CATALOGUE.filter((e) => can(subject, e.capability));
}
