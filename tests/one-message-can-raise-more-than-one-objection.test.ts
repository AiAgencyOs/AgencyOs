import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { objectionReadingSchema, objectionReadingJsonSchema } from '@/modules/sales/schema';

const workflows = readFileSync('app/api/jobs/run/workflows.ts', 'utf8');

describe('one message can raise more than one objection', () => {
  test('a message may carry a second kind with its own words', () => {
    const r = objectionReadingSchema.safeParse({
      kind: 'price', concern: 'bahut mehnga hai',
      alsoRaised: [{ kind: 'trust', concern: 'kaam poora karoge iski guarantee?' }],
    });
    assert.ok(r.success);
    assert.equal(r.data.alsoRaised[0]?.kind, 'trust');
  });

  test('a message with one objection says so with an empty list', () => {
    assert.ok(objectionReadingSchema.safeParse({ kind: 'timeline', concern: 'too slow', alsoRaised: [] }).success);
    // the field is required, so a decoder-constrained model always states it
    assert.ok(!objectionReadingSchema.safeParse({ kind: 'timeline', concern: 'too slow' }).success);
  });

  test('the same kind twice is refused, in the list and against the lead kind', () => {
    assert.ok(!objectionReadingSchema.safeParse({
      kind: 'price', concern: 'a', alsoRaised: [{ kind: 'price', concern: 'b' }],
    }).success);
    assert.ok(!objectionReadingSchema.safeParse({
      kind: 'price', concern: 'a', alsoRaised: [{ kind: 'trust', concern: 'b' }, { kind: 'trust', concern: 'c' }],
    }).success);
  });

  test('no more than three in one message, and an empty quote is refused', () => {
    assert.ok(!objectionReadingSchema.safeParse({
      kind: 'price', concern: 'a',
      alsoRaised: [{ kind: 'trust', concern: 'b' }, { kind: 'timeline', concern: 'c' }, { kind: 'feature', concern: 'd' }],
    }).success);
    assert.ok(!objectionReadingSchema.safeParse({
      kind: 'price', concern: 'a', alsoRaised: [{ kind: 'trust', concern: '  ' }],
    }).success);
  });

  test('the decoder is shown the list', () => {
    const json = JSON.stringify(objectionReadingJsonSchema());
    assert.match(json, /alsoRaised/);
  });

  test('the workflow writes every kind in ONE insert, in ONE round', () => {
    const at = workflows.indexOf("parts.map((part) => ({");
    assert.ok(at > 0, 'the multi-row objection insert was not found');
    const block = workflows.slice(at, workflows.indexOf(".select('id, kind')", at));
    assert.match(block, /\bround,/);
    // exactly one round computation feeds all rows
    assert.equal((workflows.match(/const round = \(\(sofar/g) ?? []).length, 1);
  });

  test('the migration widens the index to the kind, so a turn is not spent per complaint', () => {
    const sql = readFileSync('supabase/migrations/20261011110000_one_message_can_raise_more_than_one_objection.sql', 'utf8');
    assert.match(sql, /drop index if exists sales\.objections_one_per_round;/);
    assert.match(sql, /create unique index if not exists objections_one_per_round_and_kind\s+on sales\.objections \(lead_id, round, kind\)/);
  });
});
