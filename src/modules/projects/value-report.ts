/**
 * Phase 8D: the value report as a deterministic DRAFT of cited facts.
 *
 * The facts come from the database read `projects.value_report_facts` (tickets resolved, changes released, hours logged, production release checks), each
 * citing the row it came from. This module renders them into sentences with a VERSIONED template. It is a pure function: the same facts and the same
 * template version give the same words, byte for byte, and it states nothing the facts do not say.
 *
 * What it will never write: an uptime percentage (AgencyOS measures none, and the report says so), a satisfaction score, a saving, a price, a discount or a
 * promise. A title that itself mentions a price is withheld from the sentence (the full label stays in the cited facts) because the database refuses a
 * body that names one. The result is a draft a person edits and approves; nothing here sends it.
 *
 * Changing the wording means adding a NEW template version, never editing a released one: a stored draft names the version that rendered it, and
 * `tests/value-report.test.ts` pins the fingerprint of every released version so an in-place edit fails there.
 */

export type FactSource = { table: string; id: string };

export type ValueFactType = 'ticket_resolved' | 'change_released' | 'hours_logged' | 'production_verification';

export type ValueFact = {
  type: ValueFactType;
  label: string;
  value: number | string;
  unit: string;
  on: string;
  projectId: string | null;
  evidence: string | null;
  sources: FactSource[];
};

export type ValueReportInput = {
  clientName: string;
  periodStart: string;
  periodEnd: string;
  facts: readonly ValueFact[];
};

/**
 * The same pattern the database applies to a report body, an agent's ledger draft and a check-in agenda (`names_a_price`). Kept as a source string so a
 * test can compare it with the migration's literal: the two layers must refuse the same words.
 */
export const PRICE_WORDS_SOURCE = String.raw`(₹|€|\$)\s*[0-9]|\b(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\b|discount|% off`;
const PRICE_WORDS = new RegExp(PRICE_WORDS_SOURCE, 'i');

export function mentionsPrice(text: string): boolean {
  return PRICE_WORDS.test(text);
}

type Template = {
  version: number;
  intro: string;
  tickets: { one: string; many: string };
  changes: { one: string; many: string };
  hours: { one: string; many: string };
  production: { one: string; many: string };
  withheld: string;
  nothing: string;
  limitations: readonly string[];
  closing: string;
};

/** Released template versions. NEVER edit an entry: add the next version (the test pins each fingerprint). */
export const VALUE_REPORT_TEMPLATES: Readonly<Record<number, Template>> = {
  1: {
    version: 1,
    intro: 'Report for {client}, covering {start} to {end}. Every statement below comes from a recorded entry, listed under "Sources".',
    tickets: {
      one: '1 support ticket was resolved: {list}.',
      many: '{n} support tickets were resolved: {list}.',
    },
    changes: {
      one: '1 change was released to production: {list}.',
      many: '{n} changes were released to production: {list}.',
    },
    hours: {
      one: '{hours} hours were logged on this client\'s projects: {list}.',
      many: '{hours} hours were logged on this client\'s projects: {list}.',
    },
    production: {
      one: 'A production release check was recorded: {list}. It is a person\'s dated check, not a measure of availability.',
      many: '{n} production release checks were recorded: {list}. They are a person\'s dated checks, not a measure of availability.',
    },
    withheld: '(title withheld: it mentions a price)',
    nothing: 'Nothing was recorded in this period.',
    limitations: [
      'No uptime figure is stated: AgencyOS records no uptime measurement.',
      'This draft states only what the cited entries say. It contains no satisfaction score, saving, price or promise.',
    ],
    closing: 'This is a draft for a person to edit and approve. It has not been sent.',
  },
};

export const CURRENT_VALUE_REPORT_TEMPLATE_VERSION = 1;

/** A stable text of a released template, for the fingerprint test. */
export function templateText(version: number): string {
  const t = VALUE_REPORT_TEMPLATES[version];
  if (!t) throw new Error(`unknown value report template version ${version}`);
  return JSON.stringify(t);
}

const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{([a-z]+)\}/g, (_m, key: string) => {
    if (!(key in values)) throw new Error(`template placeholder {${key}} has no value`);
    return String(values[key]);
  });

/** Hours with at most two decimals and no trailing zeros: 3.50 -> "3.5", 2 -> "2". */
export function formatHours(value: number): string {
  return Number(value.toFixed(2)).toString();
}

const asText = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`a fact has no ${what}`);
  return v;
};

/**
 * Strictly parse the `facts` the database returned. An uncited fact (no source row), an unknown type or a malformed source is refused rather than
 * tidied: a report that cannot cite a statement does not make it.
 */
export function parseFacts(raw: unknown): ValueFact[] {
  if (!Array.isArray(raw)) throw new Error('the facts are not a list');
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`fact ${index} is not an object`);
    const f = entry as Record<string, unknown>;
    const type = f.type;
    if (type !== 'ticket_resolved' && type !== 'change_released' && type !== 'hours_logged' && type !== 'production_verification') throw new Error(`fact ${index} has an unknown type`);
    const sources = Array.isArray(f.sources) ? f.sources : [];
    if (sources.length === 0) throw new Error(`fact ${index} cites no source row`);
    const parsedSources = sources.map((s, i) => {
      const src = (s ?? {}) as Record<string, unknown>;
      return { table: asText(src.table, `source ${i} table`), id: asText(src.id, `source ${i} id`) };
    });
    const value = f.value;
    if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`fact ${index} has no value`);
    return {
      type,
      label: asText(f.label, 'label'),
      value,
      unit: asText(f.unit, 'unit'),
      on: asText(f.on, 'date'),
      projectId: typeof f.projectId === 'string' ? f.projectId : null,
      evidence: typeof f.evidence === 'string' && f.evidence.length > 0 ? f.evidence : null,
      sources: parsedSources,
    };
  });
}

const safe = (label: string, t: Template): string => (mentionsPrice(label) ? t.withheld : label);

/** The deterministic draft body for a client and period. */
export function renderValueReport(input: ValueReportInput, version: number = CURRENT_VALUE_REPORT_TEMPLATE_VERSION): string {
  const t = VALUE_REPORT_TEMPLATES[version];
  if (!t) throw new Error(`unknown value report template version ${version}`);
  for (const f of input.facts) if (f.sources.length === 0) throw new Error('a fact without a source row cannot be reported');

  const byType = (type: ValueFactType) => input.facts.filter((f) => f.type === type);
  const lines: string[] = [fill(t.intro, { client: safe(input.clientName, t), start: input.periodStart, end: input.periodEnd })];

  const tickets = byType('ticket_resolved');
  if (tickets.length > 0) {
    const list = tickets.map((f) => safe(f.label, t)).join('; ');
    lines.push(fill(tickets.length === 1 ? t.tickets.one : t.tickets.many, { n: tickets.length, list }));
  }
  const changes = byType('change_released');
  if (changes.length > 0) {
    const list = changes.map((f) => `${safe(f.label, t)}${f.evidence ? ` (deployment ${safe(f.evidence, t)})` : ''}`).join('; ');
    lines.push(fill(changes.length === 1 ? t.changes.one : t.changes.many, { n: changes.length, list }));
  }
  const hours = byType('hours_logged');
  if (hours.length > 0) {
    const total = hours.reduce((sum, f) => sum + Number(f.value), 0);
    const list = hours.map((f) => `${safe(f.label, t)}: ${formatHours(Number(f.value))}`).join('; ');
    lines.push(fill(hours.length === 1 ? t.hours.one : t.hours.many, { hours: formatHours(total), list }));
  }
  const production = byType('production_verification');
  if (production.length > 0) {
    const list = production.map((f) => `${f.on} ${String(f.value)}${f.evidence ? ` (evidence ${safe(f.evidence, t)})` : ''}`).join('; ');
    lines.push(fill(production.length === 1 ? t.production.one : t.production.many, { n: production.length, list }));
  }
  if (input.facts.length === 0) lines.push(t.nothing);

  lines.push('', ...t.limitations, '', t.closing, '', 'Sources:');
  for (const f of input.facts) lines.push(`- ${safe(f.label, t)} [${f.sources.map((s) => `${s.table} ${s.id}`).join(', ')}]`);
  return lines.join('\n');
}
