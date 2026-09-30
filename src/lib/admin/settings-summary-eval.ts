/**
 * The per-area status row at the top of Settings (SCR-071) — pure, so what
 * each tile says is tested without a database.
 *
 * Every tile states what is SET, from the stored rows; nothing is scored and
 * nothing is invented. An area with nothing configured says so plainly
 * ("Not set up") rather than showing a reassuring zero.
 */

export type AreaTone = 'success' | 'warning' | 'neutral';

export type AreaSummary = {
  key: string;
  label: string;
  href: string;
  /** The headline: how much of the area is set. */
  value: string;
  /** One line of what is set or missing. */
  caption: string;
  tone: AreaTone;
};

export type SettingsFacts = {
  organizationName: string | null;
  timezone: string | null;
  settings: Record<string, unknown>;
  defaultDesignReviewerId: string | null;
  members: number;
  teamDefaults: number;
  approvalPolicies: number;
  paymentAccounts: number;
  gstinSet: boolean;
  paymentStructures: number;
  projectTemplates: number;
  defaultWatchPhases: number | null;
  standardFolders: number | null;
};

const has = (settings: Record<string, unknown>, key: string) => typeof settings[key] === 'string' && (settings[key] as string).trim().length > 0;
const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function tone(set: number, of: number): AreaTone {
  return set === 0 ? 'neutral' : set === of ? 'success' : 'warning';
}

export function summariseSettingsAreas(f: SettingsFacts): AreaSummary[] {
  const s = f.settings;

  const general = [Boolean(f.organizationName), Boolean(f.timezone), has(s, 'quotation_contact_email') || has(s, 'quotation_contact_phone')];
  const generalSet = general.filter(Boolean).length;

  const pricing = ['pricing_day_rate_rupees', 'pricing_ai_day_rate_rupees', 'pricing_multiplier_min', 'pricing_multiplier_target', 'pricing_multiplier_max'].every((k) => has(s, k));
  const limits = ['negotiation_max_rounds', 'negotiation_min_price_rupees', 'negotiation_max_discount_pct', 'negotiation_max_autonomous_quote_rupees'].some((k) => has(s, k));
  const commercial = [pricing, f.paymentStructures > 0, limits];
  const commercialSet = commercial.filter(Boolean).length;

  const team = [f.members > 0, f.defaultDesignReviewerId !== null, f.teamDefaults > 0];
  const teamSet = team.filter(Boolean).length;

  const comms = [has(s, 'whatsapp_phone_number_id'), has(s, 'whatsapp_test_recipient'), has(s, 'outreach_window_start_hour') && has(s, 'outreach_window_end_hour')];
  const commsSet = comms.filter(Boolean).length;

  const finance = [f.paymentAccounts > 0, f.gstinSet];
  const financeSet = finance.filter(Boolean).length;

  const defaults = [has(s, 'project_group_identifier'), f.defaultDesignReviewerId !== null, f.projectTemplates > 0, f.standardFolders !== null && f.standardFolders > 0];
  const defaultsSet = defaults.filter(Boolean).length;

  return [
    { key: 'general', label: 'General', href: '/settings', value: `${generalSet} of ${general.length} set`, caption: [f.organizationName ?? 'No agency name', f.timezone ?? 'no timezone'].join(' · '), tone: tone(generalSet, general.length) },
    { key: 'commercial', label: 'Commercial', href: '/settings/commercial', value: `${commercialSet} of ${commercial.length} set`, caption: `Pricing model ${pricing ? 'set' : 'not set'} · payment terms ${f.paymentStructures > 0 ? 'set' : 'default'} · limits ${limits ? 'set' : 'none'}`, tone: tone(commercialSet, commercial.length) },
    { key: 'team', label: 'Team', href: '/settings/team', value: n(f.members, 'member'), caption: `${n(f.teamDefaults, 'default group member')} · design reviewer ${f.defaultDesignReviewerId ? 'named' : 'not named'}`, tone: tone(teamSet, team.length) },
    { key: 'communication', label: 'Communication', href: '/settings/communication', value: `${commsSet} of ${comms.length} set`, caption: `WhatsApp number ${comms[0] ? 'set' : 'not set'} · test recipient ${comms[1] ? 'set' : 'not set'} · sending window ${comms[2] ? 'set' : 'default'}`, tone: tone(commsSet, comms.length) },
    { key: 'approvals', label: 'Approvals', href: '/settings/approvals', value: n(f.approvalPolicies, 'policy', 'policies'), caption: f.approvalPolicies > 0 ? 'Who must approve what is configured' : 'No approval policy is recorded', tone: f.approvalPolicies > 0 ? 'success' : 'neutral' },
    { key: 'finance', label: 'Finance', href: '/settings/finance', value: `${financeSet} of ${finance.length} set`, caption: `${n(f.paymentAccounts, 'receiving account')} · GSTIN ${f.gstinSet ? 'set' : 'not set'}`, tone: tone(financeSet, finance.length) },
    { key: 'project-defaults', label: 'Project Defaults', href: '/settings/project-defaults', value: `${defaultsSet} of ${defaults.length} set`, caption: `${n(f.projectTemplates, 'template')} · ${f.standardFolders === null ? 'folders unread' : n(f.standardFolders, 'standard folder')}`, tone: tone(defaultsSet, defaults.length) },
  ];
}
