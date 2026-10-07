import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CURRENT_VALUE_REPORT_TEMPLATE_VERSION,
  PRICE_WORDS_SOURCE,
  VALUE_REPORT_TEMPLATES,
  formatHours,
  mentionsPrice,
  parseFacts,
  renderValueReport,
  templateText,
  type ValueFact,
} from '../src/modules/projects/value-report.ts';

/**
 * Phase 8D value reports: the wording is a pure function of cited facts, the template is versioned, and nothing invents a metric. The database side (frozen facts,
 * the digest refusal, approval by a person) is proved in Postgres by scripts/verify-phase-eight-d.sql.
 */

const root = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

const TICKET: ValueFact = {
  type: 'ticket_resolved', label: 'TKT-AAAA1111 Export button', value: 1, unit: 'ticket', on: '2026-10-02', projectId: 'p1', evidence: null,
  sources: [{ table: 'projects.support_tickets', id: '11111111-1111-4111-8111-111111111111' }],
};
const CHANGE: ValueFact = {
  type: 'change_released', label: 'patch: Fixed the export timeout', value: 1, unit: 'release', on: '2026-10-03', projectId: 'p1', evidence: 'deploy-2026-10-03-1',
  sources: [{ table: 'projects.maintenance_work_items', id: '22222222-2222-4222-8222-222222222222' }],
};
const HOURS: ValueFact = {
  type: 'hours_logged', label: 'Hours logged on Acme Portal', value: 3.5, unit: 'hours', on: '2026-10-04', projectId: 'p1', evidence: null,
  sources: [{ table: 'projects.time_logs', id: '33333333-3333-4333-8333-333333333333' }, { table: 'projects.time_logs', id: '44444444-4444-4444-8444-444444444444' }],
};
const CHECK: ValueFact = {
  type: 'production_verification', label: 'Production release check: passed', value: 'passed', unit: 'outcome', on: '2026-10-03', projectId: 'p1', evidence: 'https://evidence.example.test/run-9',
  sources: [{ table: 'projects.release_verifications', id: '55555555-5555-4555-8555-555555555555' }],
};
const INPUT = { clientName: 'Acme Ltd', periodStart: '2026-10-01', periodEnd: '2026-10-07', facts: [TICKET, CHANGE, HOURS, CHECK] } as const;

describe('the draft is a pure function of the facts', () => {
  test('the same facts and version give the same words, byte for byte', () => {
    assert.equal(renderValueReport(INPUT), renderValueReport({ ...INPUT, facts: [...INPUT.facts] }));
  });

  test('each section states exactly what its facts say, with counts and totals computed from them', () => {
    const body = renderValueReport(INPUT);
    assert.match(body, /Report for Acme Ltd, covering 2026-10-01 to 2026-10-07\./);
    assert.match(body, /1 support ticket was resolved: TKT-AAAA1111 Export button\./);
    assert.match(body, /1 change was released to production: patch: Fixed the export timeout \(deployment deploy-2026-10-03-1\)\./);
    assert.match(body, /3\.5 hours were logged on this client's projects: Hours logged on Acme Portal: 3\.5\./);
    assert.match(body, /A production release check was recorded: 2026-10-03 passed \(evidence https:\/\/evidence\.example\.test\/run-9\)\./);
  });

  test('plurals follow the count and a section with no facts is absent, not "0"', () => {
    const two = renderValueReport({ ...INPUT, facts: [TICKET, { ...TICKET, label: 'TKT-BBBB2222 Login', sources: [{ table: 'projects.support_tickets', id: '66666666-6666-4666-8666-666666666666' }] }] });
    assert.match(two, /2 support tickets were resolved: TKT-AAAA1111 Export button; TKT-BBBB2222 Login\./);
    assert.doesNotMatch(two, /released to production|hours were logged|release check/);
  });

  test('every fact is listed under Sources with the table and id it came from', () => {
    const body = renderValueReport(INPUT);
    const sources = body.slice(body.lastIndexOf('Sources:'));
    for (const f of INPUT.facts) for (const s of f.sources) assert.ok(sources.includes(`${s.table} ${s.id}`), `${s.table} ${s.id} is cited`);
  });

  test('it never states an uptime figure, a score, a saving or a promise, and says why there is no uptime', () => {
    const body = renderValueReport(INPUT);
    assert.match(body, /No uptime figure is stated: AgencyOS records no uptime measurement\./);
    assert.match(body, /no satisfaction score, saving, price or promise/);
    assert.doesNotMatch(body, /\d\s*%/);
    assert.doesNotMatch(body, /\b(99|uptime of|saved you|we guarantee)\b/i);
    assert.match(body, /It has not been sent\./);
  });

  test('a period with no facts says nothing was recorded rather than inventing a result', () => {
    const body = renderValueReport({ ...INPUT, facts: [] });
    assert.match(body, /Nothing was recorded in this period\./);
    assert.doesNotMatch(body, /were resolved|were released|were logged/);
  });

  test('a fact with no source row cannot be reported', () => {
    assert.throws(() => renderValueReport({ ...INPUT, facts: [{ ...TICKET, sources: [] }] }), /without a source row/);
  });

  test('a title that mentions a price is withheld from the sentence and the sources, and the whole body passes the price check', () => {
    const priced: ValueFact = { ...TICKET, label: 'TKT-CCCC3333 Apply the 20% off discount code' };
    const body = renderValueReport({ ...INPUT, facts: [priced] });
    assert.doesNotMatch(body, /discount|% off/i);
    assert.match(body, /\(title withheld: it mentions a price\)/);
    assert.equal(mentionsPrice(body), false);
    assert.equal(mentionsPrice(renderValueReport(INPUT)), false, 'the ordinary report passes the check the database applies');
    assert.equal(mentionsPrice(renderValueReport({ ...INPUT, clientName: 'Discount Deli' })), false, 'a client name that is itself a price word is withheld too');
  });

  test('hours are shown with at most two decimals and no trailing zeros', () => {
    assert.equal(formatHours(3.5), '3.5');
    assert.equal(formatHours(2), '2');
    assert.equal(formatHours(0.1 + 0.2), '0.3');
    assert.equal(formatHours(1.005 * 100), '100.5');
  });
});

describe('the facts the database returned are parsed strictly', () => {
  const good = INPUT.facts.map((f) => ({ ...f }));
  test('a well-formed list parses to the same facts', () => {
    assert.deepEqual(parseFacts(good), INPUT.facts);
  });
  test('an uncited fact, an unknown type, a missing label and a non-list are all refused, never tidied', () => {
    assert.throws(() => parseFacts([{ ...good[0], sources: [] }]), /cites no source row/);
    assert.throws(() => parseFacts([{ ...good[0], sources: undefined }]), /cites no source row/);
    assert.throws(() => parseFacts([{ ...good[0], type: 'uptime_percent' }]), /unknown type/);
    assert.throws(() => parseFacts([{ ...good[0], label: '' }]), /no label/);
    assert.throws(() => parseFacts([{ ...good[0], sources: [{ table: 'projects.support_tickets' }] }]), /source 0 id/);
    assert.throws(() => parseFacts({}), /not a list/);
  });
});

describe('the template is versioned and a released version is never edited', () => {
  // The fingerprint of each RELEASED version. Changing the words means adding version N+1 and moving CURRENT to it; editing version 1 in place fails here.
  test('version 1 is pinned', () => {
    const digest = createHash('sha256').update(templateText(1)).digest('hex');
    assert.equal(digest, '516ddd55349c0f8fd3e0f2e6d2302779fadf7f956f6856434250330cb2518fe7', 'a released template version was edited in place: add a new version instead');
  });
  test('the current version exists and every version up to it is present (no gap, no removal)', () => {
    for (let v = 1; v <= CURRENT_VALUE_REPORT_TEMPLATE_VERSION; v += 1) assert.ok(VALUE_REPORT_TEMPLATES[v], `version ${v}`);
    assert.equal(Object.keys(VALUE_REPORT_TEMPLATES).length, CURRENT_VALUE_REPORT_TEMPLATE_VERSION);
  });
  test('an unknown version is refused rather than falling back to another one', () => {
    assert.throws(() => renderValueReport(INPUT, 99), /unknown value report template version 99/);
    assert.throws(() => templateText(0), /unknown value report template version 0/);
  });
});

describe('the price check is the same words the database refuses', () => {
  test('the migration carries the identical pattern (the two layers refuse the same text)', () => {
    const sql = readFileSync(root('supabase/migrations/20261110200000_a_value_report_is_a_draft_of_cited_facts_a_person_approves.sql'), 'utf8');
    const literal = /body !~\* '([^']+)'/.exec(sql);
    assert.ok(literal, 'the report body CHECK carries a price pattern');
    // the database writes word boundaries as \m and \M; JavaScript as \b
    assert.equal(literal[1]!.replace(/\\[mM]/g, '\\b'), PRICE_WORDS_SOURCE);
    // and the agent ledger draft and the door use the very same literal
    const ledger = readFileSync(root('supabase/migrations/20261110100000_client_communication_is_governed_as_data_and_nothing_here_sends.sql'), 'utf8');
    assert.ok(ledger.includes(literal[1]!), 'the ledger draft check uses the same pattern');
  });
  test('it catches the ways a price is written and lets an ordinary sentence through', () => {
    for (const bad of ['costs ₹500', 'USD 40', '40 dollars', '20% off', 'a Discount code', 'Rs. 100', '€5']) assert.equal(mentionsPrice(bad), true, bad);
    for (const fine of ['Fixed the export timeout', 'Hours logged on Acme Portal', 'worksheet 4 uses', 'inbox 2 messages']) assert.equal(mentionsPrice(fine), false, fine);
  });
});
