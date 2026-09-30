import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  CLAUSE_KEYS,
  clauseBodies,
  clausesForProposal,
  DEFAULT_CLAUSES,
  inForce,
  parseClauseSnapshot,
  validateClauseBody,
  type ClauseVersion,
} from '../src/modules/sales/quotation-clauses.ts';
import { commercialTermsFor, COMMERCIAL_TERMS, quotationSectionsFor } from '../src/modules/sales/quotation-standards.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * Configurability audit B-6: clauses 2-5 of a quotation's commercial terms
 * became the owner's wording, versioned, and a quotation keeps the clause it
 * printed. Two promises: unset means the code constants exactly as before, and
 * an issued quotation never re-reads today's clauses.
 */
describe('B-6 · unset means the code constants, exactly as before', () => {
  it('the four defaults are the four sentences every quotation printed', () => {
    assert.deepEqual(CLAUSE_KEYS, ['acceptance_window', 'cancellation', 'liability_cap', 'jurisdiction']);
    assert.equal(COMMERCIAL_TERMS.length, 5);
    assert.deepEqual(COMMERCIAL_TERMS.slice(1), CLAUSE_KEYS.map((k) => DEFAULT_CLAUSES[k]));
    assert.match(COMMERCIAL_TERMS[1] ?? '', /5 working days/);
    assert.match(COMMERCIAL_TERMS[4] ?? '', /Mohali \/ Chandigarh/);
  });

  it('no snapshot, an empty snapshot and a missing key all print the defaults', () => {
    assert.deepEqual(clauseBodies(null), COMMERCIAL_TERMS.slice(1));
    assert.deepEqual(clauseBodies({}), COMMERCIAL_TERMS.slice(1));
    assert.deepEqual(commercialTermsFor(), COMMERCIAL_TERMS);
    assert.deepEqual(commercialTermsFor(15, clauseBodies({})), COMMERCIAL_TERMS);
  });

  it('a published clause replaces only its own line, in place', () => {
    const terms = commercialTermsFor(20, clauseBodies({ jurisdiction: { version: 2, body: 'Singapore law applies.' } }));
    assert.equal(terms[0], 'This quotation is valid for 20 days from its date.');
    assert.equal(terms[4], 'Singapore law applies.');
    assert.deepEqual(terms.slice(1, 4), COMMERCIAL_TERMS.slice(1, 4));
  });

  it('a clause list of the wrong length is ignored rather than printed half', () => {
    assert.deepEqual(commercialTermsFor(15, ['only one']), COMMERCIAL_TERMS);
  });

  it('the sections assembler prints the clauses it is handed, and the defaults when it is not', () => {
    const own = clauseBodies({ liability_cap: { version: 1, body: 'Liability is capped at fees paid in the last month.' } });
    const withThem = quotationSectionsFor(500_000_00, 0, { understanding: 'One build.' }, [], { clauses: own });
    const without = quotationSectionsFor(500_000_00, 0, { understanding: 'One build.' }, []);
    assert.ok(withThem && without);
    assert.equal(withThem.commercialTerms[3], 'Liability is capped at fees paid in the last month.');
    assert.deepEqual(without.commercialTerms, COMMERCIAL_TERMS);
  });

  it('terms edited into a draft still win over any clause wording', () => {
    const sections = quotationSectionsFor(
      500_000_00,
      0,
      { understanding: 'One build.', commercialTerms: ['Whatever the composer said.'] },
      [],
      { clauses: clauseBodies({ jurisdiction: { version: 3, body: 'Singapore law applies.' } }) },
    );
    assert.deepEqual(sections?.commercialTerms, ['Whatever the composer said.']);
  });
});

describe('B-6 · the wording is validated the way the database validates it', () => {
  it('10 to 1200 characters, plain text, one line', () => {
    assert.equal(validateClauseBody('too short').ok, false);
    assert.equal(validateClauseBody('x'.repeat(1201)).ok, false);
    assert.equal(validateClauseBody('x'.repeat(1200)).ok, true);
    assert.equal(validateClauseBody('Payable within <b>7 days</b> of invoice.').ok, false);
    assert.equal(validateClauseBody('Line one is fine.\nLine two is not.').ok, false);
    const ok = validateClauseBody('  Payable within 7 days of invoice.  ');
    assert.ok(ok.ok && ok.data === 'Payable within 7 days of invoice.');
  });
});

describe('B-6 · a snapshot is read defensively and in force means the newest version', () => {
  it('a malformed snapshot is an empty one, never a thrown render', () => {
    for (const bad of [null, undefined, 'x', 3, [], { cancellation: 'text' }, { cancellation: { version: 'one', body: 'x' } }, { cancellation: { version: 1, body: '  ' } }]) {
      assert.deepEqual(parseClauseSnapshot(bad), {}, JSON.stringify(bad));
    }
    assert.deepEqual(parseClauseSnapshot({ nonsense: { version: 1, body: 'x' }, cancellation: { version: 2, body: 'kept' } }), {
      cancellation: { version: 2, body: 'kept' },
    });
  });

  it('inForce picks the highest version per key whatever the order', () => {
    const v = (key: ClauseVersion['key'], version: number, body: string): ClauseVersion => ({ key, version, body, effectiveFrom: '2026-10-01', createdBy: 'u', createdByName: null });
    assert.deepEqual(inForce([v('cancellation', 1, 'a'), v('cancellation', 3, 'c'), v('cancellation', 2, 'b'), v('jurisdiction', 1, 'j')]), {
      cancellation: { version: 3, body: 'c' },
      jurisdiction: { version: 1, body: 'j' },
    });
  });
});

describe('B-6 · the snapshot door never turns a failed read into the defaults', () => {
  const client = (result: { data: unknown; error: { message: string } | null }) => ({
    schema: () => ({ rpc: async () => result }),
  });

  it('frozen and live rows come back as the four bodies in print order', async () => {
    for (const outcome of ['frozen', 'live']) {
      const r = await clausesForProposal(client({ data: [{ outcome, clauses: { cancellation: { version: 1, body: 'Their cancellation wording.' } } }], error: null }), 'p');
      assert.ok(r.ok);
      assert.equal(r.data[1], 'Their cancellation wording.');
      assert.equal(r.data[0], DEFAULT_CLAUSES.acceptance_window);
    }
  });

  it('a database error is an error, not the defaults', async () => {
    const r = await clausesForProposal(client({ data: null, error: { message: 'down' } }), 'p');
    assert.equal(r.ok, false);
  });

  it('a refusal or an unknown answer is an error too', async () => {
    for (const outcome of ['not_found', 'forbidden', 'surprise']) {
      const r = await clausesForProposal(client({ data: [{ outcome, clauses: null }], error: null }), 'p');
      assert.equal(r.ok, false, outcome);
    }
    assert.equal((await clausesForProposal(client({ data: [], error: null }), 'p')).ok, false);
  });
});

describe('B-6 · the database keeps the wording and what each quotation printed', () => {
  const sql = read('supabase/migrations/20261003200000_the_clauses_a_quotation_prints_are_the_owners_and_are_kept.sql');
  const fn = (name: string) => {
    const start = sql.indexOf(`create or replace function ${name}`);
    assert.ok(start >= 0, `${name} is defined`);
    return sql.slice(start, sql.indexOf('$$;', sql.indexOf('as $$', start)) + 3);
  };

  it('the table holds the four keys, a version, a bounded plain body, and one row per (organization, key, version)', () => {
    assert.match(sql, /create table if not exists sales\.quotation_clauses/);
    assert.match(sql, /clause_key in \('acceptance_window', 'cancellation', 'liability_cap', 'jurisdiction'\)/);
    assert.match(sql, /char_length\(body\) between 10 and 1200/);
    assert.match(sql, /body !~ '\[<>\]'/);
    assert.match(sql, /unique \(organization_id, clause_key, version\)/);
    assert.match(sql, /effective_from\s+timestamptz not null default now\(\)/);
    assert.match(sql, /created_by\s+uuid not null references core\.users/);
  });

  it('is organization-scoped and grants authenticated a read and nothing else', () => {
    assert.match(sql, /alter table sales\.quotation_clauses enable row level security/);
    assert.match(sql, /alter table sales\.quotation_clauses force row level security/);
    assert.match(sql, /revoke all on table sales\.quotation_clauses from public, anon, authenticated/);
    assert.match(sql, /grant select on table sales\.quotation_clauses to authenticated;/);
    assert.doesNotMatch(sql, /grant [a-z, ]*(insert|update|delete)[a-z, ]* on table sales\.quotation_clauses to authenticated/);
    assert.match(sql, /organization_id = \(select core\.current_organization_id\(\)\)/);
  });

  it('a published clause is never edited: an update is refused by a trigger', () => {
    assert.match(sql, /raise exception 'a published clause is never edited/);
    assert.match(sql, /before update or delete on sales\.quotation_clauses/);
  });

  it('publishing is owner or ops admin, appends a version, and is audited with key, version, body and who', () => {
    const publish = fn('core.publish_quotation_clause');
    assert.match(publish, /security definer/);
    assert.match(publish, /set search_path = ''/);
    assert.match(publish, /core\.is_admin\(\)/);
    assert.match(publish, /'not_authorized'/);
    assert.match(publish, /coalesce\(v_latest\.version, 0\) \+ 1/);
    assert.match(publish, /between|char_length\(v_body\) < 10 or char_length\(v_body\) > 1200/);
    assert.match(publish, /v_body ~ '\[<>\]'/);
    assert.match(publish, /pg_advisory_xact_lock/);
    assert.match(publish, /core\.record_audit\(/);
    assert.match(publish, /'quotation_clause\.published'/);
    assert.match(publish, /'key', p_key, 'version', v_next, 'body', v_body, 'by', v_actor/);
    assert.doesNotMatch(publish, /\bupdate sales\.quotation_clauses\b/);
    assert.match(sql, /revoke all on function core\.publish_quotation_clause\(text, text\) from public, anon/);
  });

  it('listing is for every internal role and empty for anyone else', () => {
    const list = fn('core.list_quotation_clauses');
    assert.match(list, /security definer/);
    assert.match(list, /core\.is_internal\(\)/);
    assert.match(list, /core\.current_organization_id\(\)/);
  });

  it('the snapshot is one column, taken once under the row lock, and frozen', () => {
    assert.match(sql, /alter table sales\.proposals add column if not exists clauses_printed jsonb/);
    const door = fn('sales.clauses_for_proposal');
    assert.match(door, /for update/);
    assert.match(door, /v_row\.status = 'draft'/);
    assert.match(door, /if v_row\.clauses_printed is not null then/);
    assert.match(door, /update sales\.proposals set clauses_printed = v_current/);
    assert.match(door, /core\.is_internal\(\)/);
    assert.match(door, /'forbidden'/);
    const guard = fn('sales.proposals_clauses_printed_guard');
    assert.match(guard, /old\.clauses_printed is not null/);
    assert.match(guard, /new\.status = 'draft'/);
  });

  it('a clause nobody published is absent from the snapshot, so the code constant prints', () => {
    const door = fn('sales.clauses_for_proposal');
    assert.match(door, /coalesce\(jsonb_object_agg\(/);
    assert.match(door, /'\{\}'::jsonb/);
  });
});

describe('B-6 · every place a quotation is rendered reads the clauses through the snapshot door', () => {
  it('the PDF download and the client send (sales service) both do, and refuse rather than default on a failed read', () => {
    const service = read('src/modules/sales/service.ts');
    const calls = service.match(/await clausesForProposal\(supabase, proposal\.id\)/g) ?? [];
    assert.equal(calls.length, 2, 'quotationPdfForProposal and sendProposal');
    assert.equal((service.match(/clauses: clauses\.data/g) ?? []).length, 2);
    assert.equal((service.match(/throw new SurroundingsUnreadable\(clauses\.error\.message\)/g) ?? []).length, 2);
  });

  it('the worker that attaches the owner\'s copy does too, as an unreadable (retryable) read', () => {
    const handlers = read('src/modules/crm/handlers.ts');
    assert.match(handlers, /clausesForProposal\(admin, proposal\.id\)/);
    assert.match(handlers, /clauses: clauses\.data/);
    assert.match(handlers, /kind: 'unreadable', detail: `could not read the quotation's clauses/);
  });

  it('the draft preview and the composer read the clauses in force now; nothing else imports the raw constants', () => {
    const composer = read('app/(internal)/quotations/new/composer.tsx');
    assert.doesNotMatch(composer, /COMMERCIAL_TERMS/);
    assert.match(composer, /defaultTerms\.join/);
    const actions = read('src/modules/sales/actions.ts');
    assert.doesNotMatch(actions, /COMMERCIAL_TERMS/);
    assert.match(actions, /readClausesInForce\(\)/);
  });
});

describe('B-6 · the screen and the door', () => {
  const service = read('src/modules/sales/clauses-service.ts');
  const action = read('app/(internal)/settings/actions.ts');
  const panel = read('app/(internal)/settings/commercial/clauses-panel.tsx');
  const page = read('app/(internal)/settings/commercial/page.tsx');

  it('publishing checks the role union, never context.role, and validates before it calls', () => {
    assert.match(service, /hasRole\(context, 'owner'\)/);
    assert.match(service, /hasRole\(context, 'ops_admin'\)/);
    assert.doesNotMatch(service, /context\.role/);
    assert.ok(service.indexOf('validateClauseBody(') < service.indexOf("rpc('publish_quotation_clause'"));
    assert.match(service, /rpc\('list_quotation_clauses'\)/);
  });

  it('a failed read is an error, never an empty list', () => {
    assert.match(service, /return err\('INTERNAL', 'The quotation clauses could not be read\.'\)/);
    assert.match(page, /if \(!clauseRead\.ok\) throw new Error\(clauseRead\.error\.message\)/);
  });

  it('the action is thin: the key is checked, the service decides', () => {
    assert.match(action, /export async function publishQuotationClauseAction/);
    assert.match(action, /isClauseKey\(key\)/);
    assert.match(action, /publishQuotationClause\(\{ key, body:/);
  });

  it('every internal role sees the text; only owner and ops admin get the form and the history is a disclosure', () => {
    assert.match(page, /hasRole\(context, 'owner'\) \|\| hasRole\(context, 'ops_admin'\)/);
    assert.match(panel, /canEdit \? \(\s*<PublishForm/);
    assert.match(panel, /<details/);
    assert.match(panel, /Version history/);
    assert.doesNotMatch(panel, /server-only|clauses-service/, 'a client component never imports a server-only module');
  });
});

describe('B-6 · the live verifier is wired in', () => {
  it('has a package script and runs in CI', () => {
    assert.match(read('package.json'), /"db:verify:clauses": "node scripts\/verify-quotation-clauses\.mjs"/);
    assert.match(read('.github/workflows/verify.yml'), /npm run db:verify:clauses/);
  });
});
