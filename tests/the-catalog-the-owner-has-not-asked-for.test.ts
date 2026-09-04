import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

/**
 * The catalog the owner has not asked for — G-206 (audit CN-10).
 *
 * ── the finding, and why it is not a task ─────────────────────────────────
 *
 * The audit filed CN-10 against `sales.approved_offers`: no eligibility, no
 * quantity, no applicable project types, no payment requirement, no
 * versioning. As a description of a data model that is fair.
 *
 * As a description of the decisions the table was built under, it is a
 * description of the BOUNDARY:
 *
 *   ADM-22 — "There is no price catalog. Every price is quoted per client by
 *   a human." G-035 was closed by that decision rather than by code.
 *
 *   ADM-98, overriding part of it and naming its own limit in the same
 *   breath — "ONE active offer per organization (several would make the agent
 *   choose between concessions, which is the judgement ADM-22 protected)."
 *
 * Eligibility rules, applicable types and quantity limits are not extra
 * columns on one offer. They are the machinery for having SEVERAL and picking
 * between them — the exact judgement both decisions reserve for a person.
 *
 * An agent widening that because a gap analysis called it a missing field
 * would be an agent granting itself authority the owner declined to grant.
 * It is ADM-100, and it is open.
 *
 * ── and the twin, which is the point of this file ─────────────────────────
 *
 * An absence recorded and never checked is a comment. A feature deleted by
 * accident also has no eligibility column, so section B asserts the one offer
 * still works — the same discipline the absence-only-assertions finding
 * established.
 */

const root = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const MIGRATIONS = readdirSync(fileURLToPath(new URL('../supabase/migrations', import.meta.url)))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => ({ name: f, sql: sqlCode(root(`supabase/migrations/${f}`)) }));

/** Every statement that creates or alters the offers table, in order. */
const OFFER_DDL = MIGRATIONS.filter((m) => /approved_offers/.test(m.sql));

describe('A. the catalog is absent, and each absence is one the owner chose', () => {
  const forbidden = [
    // The machinery for having several and picking between them.
    'eligibility',
    'eligible_for',
    'applicable_types',
    'project_types',
    'max_uses',
    'quantity',
    'remaining_uses',
    'offer_version',
    'supersedes_offer',
    'priority',
    'payment_requirement',
  ];

  for (const column of forbidden) {
    test(`no ${column} column on the offers table`, () => {
      for (const m of OFFER_DDL) {
        assert.ok(
          !new RegExp(`\\b${column}\\b`).test(m.sql),
          `${m.name} adds ${column} — that is ADM-100, which is open, not a migration`,
        );
      }
    });
  }

  test('and no second live offer: the partial unique index is still the whole rule', () => {
    // ADM-98 names this as the boundary it drew. Widening it is the decision.
    const joined = OFFER_DDL.map((m) => m.sql).join('\n');
    assert.match(joined, /create unique index if not exists approved_offers_live_key[\s\S]{0,200}?where active/);
  });
});

describe('B. the positive twin — the one offer still exists and still binds', () => {
  const joined = OFFER_DDL.map((m) => m.sql).join('\n');

  test('the table is there at all', () => {
    // Without this, every assertion above passes on a deleted feature.
    assert.match(joined, /create table if not exists sales\.approved_offers/);
  });

  test('with the owner’s own words, and the cap held in DDL', () => {
    assert.match(joined, /\bcondition\b/);
    assert.match(joined, /discount_pct[\s\S]{0,120}?between 1 and 50/);
  });

  test('and the four refusals the concession is bounded by', () => {
    const applied = MIGRATIONS.filter((m) => /apply_approved_offer/.test(m.sql)).map((m) => m.sql).join('\n');
    for (const outcome of ['not_draft', 'already_offered', 'no_offer', 'below_floor']) {
      assert.ok(applied.includes(outcome), `${outcome} is one of the five bounds ADM-98 was granted on`);
    }
  });
});

describe('C. the reasoning is where a builder will find it', () => {
  const REFUSAL = root('supabase/migrations/20260904190000_the_catalog_the_owner_has_not_asked_for.sql');

  test('the migration names the decision, not just the absence', () => {
    assert.match(REFUSAL, /ADM-100, and it is open/);
    assert.match(REFUSAL, /the judgement ADM-22 protected/);
  });

  test('it changes no schema — a refusal that altered a table would be a change', () => {
    /**
     * NOT `sqlCode` here, and the reason is the finding this test nearly
     * became. `sqlCode` strips `comment on … ;` along with `--` lines, because
     * for its usual job — asserting real DDL — a comment is documentation
     * rather than code. This migration is NOTHING BUT those statements, so
     * `sqlCode` returned sixty blank lines and the assertion failed against an
     * empty string rather than against the file.
     *
     * A stripper is a measurement. Reaching for the familiar one without
     * asking what it removes is how a test comes to be asked of a value that
     * is empty in exactly the case it was written for.
     */
    const executable = REFUSAL.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
    for (const verb of ['create table', 'alter table', 'create index', 'create function', 'drop ']) {
      assert.ok(
        !executable.toLowerCase().includes(verb),
        `the refusal migration must not ${verb.trim()} — it records a decision, it does not take one`,
      );
    }
    assert.match(executable, /comment on table sales\.approved_offers/);
  });

  test('and the table comment carries it into the database itself', () => {
    // `\d+` is where somebody looks before adding a column, and it is the one
    // place a reader who never opens this repository will still see it.
    assert.match(REFUSAL, /comment on table sales\.approved_offers is[\s\S]{0,900}?ADM-100, open/);
  });
});
