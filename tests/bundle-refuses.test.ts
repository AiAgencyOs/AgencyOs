import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * The historical snapshot refuses to run — gap G-095, decision ADM-58.
 *
 * ADM-40 kept `supabase/_bundle.sql` as a marked snapshot. The marking was
 * prose, and **prose does not stop a paste**: the file still built a schema
 * missing D19's advisory-lock owner bootstrap, D22, G-083 and G-084. Run
 * against a fresh project — the exact case somebody would reach for it — every
 * concurrent caller is provisioned as owner.
 *
 * ADM-58 asked whether refusing is worth the file no longer being runnable
 * even deliberately. Taken as a delegated decision: it is. The guard turns an
 * accident into a deliberate act, and anyone who truly means to run it deletes
 * four lines — which shows up in a diff, where a mistaken paste shows up as a
 * broken deployment.
 */

const bundle = readFileSync(
  fileURLToPath(new URL('../supabase/_bundle.sql', import.meta.url)),
  'utf8',
);

describe('A. the file refuses', () => {
  test('it raises before doing anything', () => {
    assert.match(bundle, /raise exception 'supabase\/_bundle\.sql is NOT an install path/);
  });

  test('and the message says what to run instead', () => {
    // A refusal that does not say what to do sends somebody looking for a way
    // around it, which here means deleting the guard.
    assert.match(bundle, /npm run db:push/);
  });
});

describe('B. the guard is inside the transaction, and that is the whole point', () => {
  test('the raise comes after begin, not before it', () => {
    // The first version sat *above* `begin;` and tested clean against a plain
    // Postgres database — a result earned for the wrong reason. That run had
    // actually died 200 lines later on `schema "auth" does not exist`, which a
    // bare database lacks and a real Supabase project has.
    //
    // Above `begin;`, `psql -f` without ON_ERROR_STOP prints the error and
    // carries straight on. Measured on a probe database resembling a real
    // project: 27 tables built without the guard, 0 with it.
    const begin = bundle.indexOf('\nbegin;');
    const raise = bundle.indexOf("raise exception 'supabase/_bundle.sql is NOT an install path");
    assert.ok(begin > 0, 'the transaction is gone');
    assert.ok(raise > begin, 'the guard sits above `begin;`, where psql can step over it');
  });

  test('nothing creates a schema or table before the guard', () => {
    // The guard only protects what follows it. Anything above would already
    // have run by the time it fires.
    const head = bundle.slice(0, bundle.indexOf('raise exception'));
    assert.ok(
      !/^\s*(create|alter|drop)\s/im.test(head),
      'DDL runs before the guard, so the guard does not cover it',
    );
  });

  test('and the file still ends by committing, so the abort rolls back', () => {
    assert.match(bundle, /\ncommit;/);
  });
});

describe('C. it is still readable, which is its only supported use', () => {
  test('the schema it documents is still present in full', () => {
    // ADM-40 kept the file for reference. A guard that gutted it would answer
    // a different question than the one that was asked.
    for (const marker of ['create schema if not exists core', 'create table', 'create policy']) {
      assert.ok(bundle.includes(marker), `the file no longer documents: ${marker}`);
    }
  });

  test('and the header still says why it is not an install path', () => {
    assert.match(bundle, /NOT AN INSTALL PATH/);
  });
});
