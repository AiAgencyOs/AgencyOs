import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * Document 11 — Requirements, Scope & Change Request System — is fourteen
 * pages and had no tables.
 *
 * AgencyOS could record an accepted requirement version, and `modules`,
 * `features` and `tasks` each carry `requirement_version_id`, so work traced
 * back to a requirement. What did not exist is the thing in between: a frozen
 * baseline, and a controlled way to move it. Doc 11 §1 is the rule it exists
 * for — agents *"must not silently expand, reduce or rewrite"* the scope — and
 * nothing enforced it, because there was no baseline to expand from.
 *
 * Behaviour is proved against real Postgres in
 * `scripts/verify-scope-baseline.mjs`. These pin the decisions.
 */

const read = (needle: string) =>
  readdirSync(fileURLToPath(new URL('../supabase/migrations', import.meta.url)))
    .filter((f) => f.includes(needle))
    .map((f) => readFileSync(fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url)), 'utf8'))
    .join('\n');

const tables = read('the_system_knows_what_it_is_building');
const moves = read('moving_a_baseline_is_a_transition');

describe('A. a price has exactly one home', () => {
  test('a change request has no price column', () => {
    // Doc 11 §32 has the AI prepare a calculation; ADM-22 answers who may
    // state the result: "Every price is quoted per client by a human." A
    // second place a price can live is always the one that escapes the
    // approval engine.
    const table = tables.slice(tables.indexOf('create table if not exists projects.change_requests'));
    const body = table.slice(0, table.indexOf(');'));
    assert.ok(!/price_minor|amount_minor|\bprice\s+(numeric|bigint|int)/.test(body), 'a price column exists');
    assert.match(body, /proposal_id\s+uuid/);
  });

  test('and a paid change cannot be approved without one', () => {
    // The boundary as a refusal rather than a convention.
    assert.match(moves, /paid_change_needs_a_proposal/);
    assert.match(tables, /change_requests_paid_names_a_proposal/);
  });
});

describe('B. a frozen baseline is history', () => {
  test('it may only be superseded, never edited', () => {
    assert.match(tables, /a frozen scope version may only be superseded/);
    assert.match(tables, /a frozen scope version is immutable/);
  });

  test('nor deleted', () => {
    assert.match(tables, /a frozen scope version is history and cannot be deleted/);
  });

  test('and its items are part of it', () => {
    // A baseline whose lines can still be edited is not frozen, whatever its
    // parent row says.
    assert.match(tables, /refuse_frozen_scope_item/);
    assert.match(tables, /before insert or update or delete on projects\.scope_items/);
  });

  test('exactly one baseline is active per project', () => {
    assert.match(tables, /create unique index if not exists scope_versions_one_active/);
    assert.match(tables, /where status = 'active'/);
  });
});

describe('C. moving it copies rather than edits', () => {
  test('apply_change_request opens a new version and copies the old one into it', () => {
    const fn = moves.slice(moves.indexOf('function projects.apply_change_request'));
    assert.match(fn, /insert into projects\.scope_items/);
    assert.match(fn, /from projects\.scope_items si\s*\n\s*where si\.scope_version_id = v_active/);
    assert.ok(!/update projects\.scope_items/.test(fn), 'it edits the old items');
  });

  test('and refuses a request that was never approved', () => {
    assert.match(moves, /not_approved/);
  });

  test('freezing takes a row lock, because two callers both freezing is a race', () => {
    const fn = moves.slice(moves.indexOf('function projects.freeze_scope_version'));
    assert.match(fn, /for update/);
  });

  test('an empty draft cannot be frozen', () => {
    // A baseline with nothing in it answers "no" to every later question about
    // what is in scope.
    assert.match(moves, /'empty'/);
  });
});

describe('D. what is deliberately not automated', () => {
  test('classification has a vocabulary and no default', () => {
    // Doc 11 §17's list, exactly. Null until somebody classifies it: a default
    // would be a guess about the client's request.
    for (const c of ['in_scope', 'free_change', 'paid_change', 'new_project', 'clarification', 'duplicate', 'rejected']) {
      assert.match(tables, new RegExp(`'${c}'`), `${c} is missing from the vocabulary`);
    }
    const col = tables.slice(tables.indexOf('classification   text'));
    assert.ok(!/default '/.test(col.slice(0, 200)), 'classification carries a default');
  });

  test('and the reason the classifier is absent is written down', () => {
    // Doc 11 §18: "'Small' must be a policy definition, not an agent's
    // personal judgment." Those thresholds are Admin values and nobody has set
    // them. Inventing one would be inventing the business rule.
    assert.match(tables, /what is NOT automated, and why that is not an omission/);
    assert.match(tables, /must be a policy definition, not an\n-- agent's personal judgment/);
  });
});

describe('E. it is checked where it will actually run', () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { scripts: Record<string, string> };
  const workflow = readFileSync(
    fileURLToPath(new URL('../.github/workflows/verify.yml', import.meta.url)),
    'utf8',
  );

  test('package.json exposes the live script', () => {
    assert.match(pkg.scripts['db:verify:scope'] ?? '', /verify-scope-baseline\.mjs/);
  });

  test('and CI runs it', () => {
    assert.match(workflow, /npm run db:verify:scope/);
  });

  test('every org-scoped foreign key carries its tenancy guard', () => {
    // CI's db:verify:tenancyguards enumerates the gaps, but a new table is the
    // moment they get forgotten.
    for (const fk of ['project_id', 'scope_version_id', 'feature_id', 'resulting_scope_version_id']) {
      assert.match(tables, new RegExp(`core\\.enforce_parent_org\\('${fk}'`), `${fk} has no guard`);
    }
    for (const t of ['scope_versions', 'scope_items', 'change_requests']) {
      assert.match(tables, new RegExp(`freeze_org_${t}`), `${t} can be moved between tenants`);
    }
  });
});
