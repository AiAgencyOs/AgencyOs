import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20261027100000_two_contacts_judged_the_same_become_one.sql');
const service = read('src/modules/acquisition/service.ts');
const page = read('app/(internal)/lead-generation/identity/page.tsx');
const start = sql.indexOf('create or replace function crm.merge_contacts(');
const body = sql.slice(start, sql.indexOf('\n$$;', start));

describe('lead generation - merging two contacts judged the same person', () => {
  test('the door is admin-only, org-scoped, and executes a judgement rather than making one', () => {
    assert.match(body, /_social_caller_ok\(p_organization_id, true\)/);
    assert.match(body, /status = 'confirmed_same'/);
    assert.match(body, /'no_confirmed_review'/);
    assert.match(body, /p_winner = p_loser/);
  });

  test('nothing is deleted and consent never changes hands: the winner gets a copy and the safer answer wins', () => {
    const code = body.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    assert.doesNotMatch(code, /delete from/i);
    assert.match(code, /insert into crm\.communication_consent/);
    assert.doesNotMatch(code, /update crm\.communication_consent\s+set\s+contact_id/i);
    assert.match(code, /excluded\.status = 'withdrawn'/);
  });

  test('the loser is kept as history, marked merged, and a merged contact cannot be merged again', () => {
    assert.match(body, /merged_into_contact_id = p_winner/);
    assert.match(body, /'already_merged'/);
    assert.match(sql, /'merged'\)\)/, 'reachable_via allows the merged marker');
  });

  test('identity keys move before the winner learns an email/phone, so no false collision is raised', () => {
    assert.ok(body.indexOf('update crm.identity_keys') < body.indexOf('set email   = coalesce'));
  });

  test('the door is not callable by anon', () => {
    assert.match(sql, /revoke all on function crm\.merge_contacts\(uuid, uuid, uuid, text\) from public, anon;/);
  });

  test('a person can reach it: service wrapper maps every outcome, and the Identity page offers it only to managers', () => {
    for (const o of ['merged', 'needs_reason', 'same_contact', 'no_confirmed_review', 'already_merged', 'not_found']) assert.match(service, new RegExp(`'${o}'`));
    assert.match(page, /mayManage \? <MergeContactsForm/);
    assert.match(page, /listConfirmedUnmerged/);
  });
});
