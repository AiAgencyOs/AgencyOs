import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';
import {
  TEMPLATE_PARAMETERS,
  TEMPLATE_PARAMETER_LABELS,
} from '../src/lib/whatsapp/template-vocabulary.ts';

/**
 * A variable nobody filled — gap G-215.
 *
 * G-213's column comment said `parameters` held *"names of things this system
 * already holds"*, and nothing resolved them: the array went straight to Meta
 * and each entry was wrapped as `{type: 'text', text}`. An Admin registering
 * the documented thing — `first_name` — sent a client the literal word
 * **"first_name"**.
 *
 * The filling is proved live in `verify-outbound-window` §8–§10 against real
 * rows. What is here is the vocabulary's two halves agreeing, and the rules
 * that have no live surface.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const SQL = sqlCode(read('supabase/migrations/20260906130000_a_variable_nobody_filled.sql'));

describe('A. the vocabulary is one list, in two places', () => {
  test('every name TypeScript admits, the database admits', () => {
    const constraint = SQL.slice(
      SQL.indexOf('whatsapp_templates_parameters_known check'),
      SQL.indexOf(']::text[]'),
    );
    for (const name of TEMPLATE_PARAMETERS) {
      assert.ok(constraint.includes(`'${name}'`), `${name} is not in the CHECK constraint`);
    }
  });

  test('and every name the database admits, TypeScript admits', () => {
    const constraint = SQL.slice(
      SQL.indexOf('whatsapp_templates_parameters_known check'),
      SQL.indexOf(']::text[]'),
    );
    const inSql = [...constraint.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
    for (const name of inSql) {
      assert.ok(
        (TEMPLATE_PARAMETERS as readonly string[]).includes(name),
        `${name} is registrable and nothing fills it`,
      );
    }
  });

  test('every name a person can pick has words a person can read', () => {
    for (const name of TEMPLATE_PARAMETERS) {
      assert.ok(TEMPLATE_PARAMETER_LABELS[name], `${name} has no label`);
      assert.notEqual(TEMPLATE_PARAMETER_LABELS[name], name);
    }
  });

  /**
   * The absence, with its positive twin above. ADM-76 forbids invention, and
   * a variable is the easiest place to smuggle one in: `industry` and
   * `budget` are facts about a client that this system would have to guess.
   */
  test('nothing in the vocabulary is a fact this system would have to invent', () => {
    for (const invented of ['industry', 'budget', 'next_step', 'timeline', 'price', 'discount']) {
      assert.ok(
        !(TEMPLATE_PARAMETERS as readonly string[]).includes(invented),
        `${invented} would be ADM-76's invention wearing a variable's clothes`,
      );
    }
  });
});

describe('B. what cannot be filled is not sent', () => {
  // Comments stripped: the docstring argues at length about why there is no
  // fallback, and a check that read prose would fail on the argument for the
  // rule it is checking.
  const resolver = codeOnly(read('src/modules/crm/template-parameters.ts'));

  test('there is no fallback value anywhere in the resolver', () => {
    // "Hi there" in place of a name is a sentence the agency did not write and
    // nobody at Meta approved. The name itself is worse.
    assert.doesNotMatch(resolver, /'there'|'Hi'|fallback/i);
  });

  test('a missing fact is named, so somebody can fix it', () => {
    assert.match(resolver, /missing\.push\('contact_first_name'\)/);
    assert.match(resolver, /missing\.push\('quotation_reference'\)/);
  });

  test('a profile name that is a phone number is not a first name', () => {
    // The commonest shape in a real WhatsApp inbox. Greeting somebody as
    // "+91" is worse than not greeting them.
    const guard = resolver.slice(resolver.indexOf('function firstNameOf'), resolver.indexOf('export async function'));
    assert.match(guard, /\/\\d\/\.test\(first\)/);
    assert.match(guard, /\\p\{L\}/);
  });

  test('the order is the template’s, because Meta fills positionally', () => {
    assert.match(resolver, /input\.names\.map\(\(name\) => values\.get\(name\)!\)/);
  });
});

describe('C. status is Meta’s word and active is the Admin’s', () => {
  test('both are required before a send', () => {
    // The lookup moved into `crm.template_for` with the language choice
    // (G-217); the rule it carries did not change.
    const migration = read('supabase/migrations/20260906150000_which_template_and_in_whose_language.sql');
    const chooser = migration.slice(
      migration.indexOf('function crm.template_for'),
      migration.indexOf('comment on function crm.template_for'),
    );
    assert.match(chooser, /t\.status = 'approved'/);
    assert.match(chooser, /t\.active/);
  });

  test('the seven states Meta actually reports are the seven the column admits', () => {
    for (const state of ['draft', 'submitted', 'approved', 'rejected', 'paused', 'disabled', 'archived']) {
      assert.ok(SQL.includes(`'${state}'`), `${state} is missing from the status CHECK`);
    }
  });

  test('and the live-template index only holds a slot for an approved one', () => {
    // A rejected template must not keep the situation's slot: an Admin whose
    // template was rejected has to be able to register its replacement.
    assert.match(SQL, /whatsapp_templates_situation_key[\s\S]{0,200}?where active and status = 'approved'/);
  });
});

describe('D. a version is history, not a saved copy', () => {
  test('the versions table has no write policy at all', () => {
    const table = SQL.slice(SQL.indexOf('crm.whatsapp_template_versions'));
    assert.doesNotMatch(table, /create policy whatsapp_template_versions_(insert|update|write|all)/);
  });

  test('and a change that alters nothing sendable writes nothing', () => {
    assert.match(SQL, /new\.template_name is not distinct from old\.template_name/);
    assert.match(SQL, /new\.status\s+is not distinct from old\.status/);
  });
});
