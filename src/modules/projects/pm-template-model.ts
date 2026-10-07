import {
  pmAdvanceVerified,
  pmBillingQuestion,
  pmClarificationAsk,
  pmFollowUp,
  pmGstDetailsRequest,
  pmKickoff,
  pmPaymentNeedsAttention,
  pmPaymentReceived,
  pmPaymentVerified,
  pmWelcome,
  type PmLanguage,
} from './pm-messages';

/**
 * P2-PM-006 / P2-FLOW-026 — the PM's client messages as editable templates. The registry below is mirrored by `projects.p1s_pm_template_registry()` and the
 * rules by `projects.p1s_pm_template_problem()` (migration 20261204200000); the database is the authority and a test compares the two lists. Nothing in this
 * file changes what the PM says: `defaultTemplateText` is the wording in `pm-messages.ts`, written with its placeholders left in, and an override exists only
 * after an Admin approved it.
 */

export const PM_LANGUAGES = ['en', 'hinglish', 'hindi'] as const satisfies readonly PmLanguage[];

export type PmTemplateDefinition = { key: string; label: string; when: string; placeholders: readonly string[]; required: readonly string[] };

export const PM_TEMPLATES = [
  { key: 'welcome', label: 'Welcome', when: 'When Phase 2 starts for a project.', placeholders: ['agencyName', 'projectName'], required: [] },
  { key: 'billing_question', label: 'Billing question', when: 'After the welcome, while the invoice type is not settled.', placeholders: [], required: [] },
  { key: 'gst_details_request', label: 'GST details request', when: 'When the client chose a GST invoice.', placeholders: [], required: [] },
  { key: 'payment_received', label: 'Payment details received', when: 'When the client submits payment details.', placeholders: [], required: [] },
  { key: 'advance_verified', label: 'Advance verified', when: 'When the first milestone payment is verified.', placeholders: [], required: [] },
  { key: 'payment_verified', label: 'Payment verified', when: 'When a later milestone payment is verified.', placeholders: ['invoiceNumber'], required: ['invoiceNumber'] },
  { key: 'payment_needs_attention', label: 'Payment needs attention', when: 'When payment details could not be matched.', placeholders: ['invoiceNumber'], required: ['invoiceNumber'] },
  { key: 'kickoff', label: 'Kickoff', when: 'When the project is officially started in the group.', placeholders: [], required: [] },
  { key: 'clarification_ask', label: 'Planning question', when: 'Around a planning question the planner needs answered.', placeholders: ['question'], required: ['question'] },
  { key: 'follow_up_billing', label: 'Reminder: billing', when: 'A gentle reminder while the invoice type is still unanswered.', placeholders: [], required: [] },
  { key: 'follow_up_gst_details', label: 'Reminder: GST details', when: 'A gentle reminder while the GST details are still missing.', placeholders: [], required: [] },
] as const satisfies readonly PmTemplateDefinition[];

export type PmTemplateKey = (typeof PM_TEMPLATES)[number]['key'];

export function templateDefinition(key: string): PmTemplateDefinition | null {
  return PM_TEMPLATES.find((t) => t.key === key) ?? null;
}

/** The wording in code, with each placeholder left as `{name}` so it can be edited in place. */
export function defaultTemplateText(key: PmTemplateKey, language: PmLanguage): string {
  switch (key) {
    case 'welcome':
      return pmWelcome({ language, agencyName: '{agencyName}', projectName: '{projectName}' });
    case 'billing_question':
      return pmBillingQuestion(language);
    case 'gst_details_request':
      return pmGstDetailsRequest(language);
    case 'payment_received':
      return pmPaymentReceived(language);
    case 'advance_verified':
      return pmAdvanceVerified(language);
    case 'payment_verified':
      return pmPaymentVerified(language, '{invoiceNumber}');
    case 'payment_needs_attention':
      return pmPaymentNeedsAttention(language, '{invoiceNumber}');
    case 'kickoff':
      return pmKickoff(language);
    case 'clarification_ask':
      return pmClarificationAsk(language, '{question}');
    case 'follow_up_billing':
      return pmFollowUp(language, 'billing');
    case 'follow_up_gst_details':
      return pmFollowUp(language, 'gst_details');
  }
}

const AMOUNT = /₹|[$]|\brs\.?\s*\d|\binr\b|\busd\b|\d[\d,]*\s*(k\b|lakh|lac|crore|rupees?|dollars?)|%/i;
const PROMISE = /\b(discount|free of charge|guarantee[ds]?|we promise|deadline)\b/i;
const LINK = /https?:\/\/|```/i;
const MODEL = /\b(openai|anthropic|claude|chatgpt|gpt-?[0-9]|gemini|openrouter|llama|mistral)\b/i;

/** The same rules `projects.p1s_pm_template_problem` enforces; the database decides, this gives the editor a message before the round trip. */
export function pmTemplateProblem(key: string, language: string, body: string): string | null {
  const def = templateDefinition(key);
  if (!def) return `unknown template "${key.slice(0, 40)}"`;
  if (!(PM_LANGUAGES as readonly string[]).includes(language)) return 'the language must be en, hinglish or hindi';
  if (body.trim().length < 8) return 'the message is too short to be a message';
  if (body.length > 1500) return 'the message is longer than 1500 characters';
  for (const m of body.matchAll(/\{([^{}]*)\}/g)) {
    const token = m[1] ?? '';
    if (!def.placeholders.includes(token)) return `the placeholder {${token.slice(0, 40)}} is not allowed in this template`;
  }
  const stripped = body.replace(/\{[^{}]*\}/g, '');
  if (/[{}]/.test(stripped)) return 'a brace is left open: placeholders are written {name}';
  for (const r of def.required) if (!body.includes(`{${r}}`)) return `this template must use {${r}}`;
  if (AMOUNT.test(stripped)) return 'a client message states no amount: the invoice carries it';
  if (PROMISE.test(stripped)) return 'a client message makes no promise, discount or deadline';
  if (LINK.test(stripped)) return 'a client message carries no link';
  if (MODEL.test(stripped)) return 'a client message says nothing about which model or provider is behind it';
  return null;
}

/** Fill `{name}` placeholders. A placeholder with no value (or an empty one) makes the whole render null: a half-filled client message is never sent. */
export function renderPmTemplate(body: string, vars: Readonly<Record<string, string>>): string | null {
  let missing = false;
  const text = body.replace(/\{([^{}]*)\}/g, (_all, name: string) => {
    const v = vars[name];
    if (v === undefined || v.trim() === '') {
      missing = true;
      return '';
    }
    return v;
  });
  return missing ? null : text;
}
