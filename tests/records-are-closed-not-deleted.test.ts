import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

// A sanctioned sales/delivery/finance record is closed through its own terminal
// state — lost/cancelled/superseded/void — never deleted. The sanctioned-write
// guards freeze each record's state on INSERT/UPDATE, but the ALL write policy
// left DELETE granted to authenticated, so an end-user could erase the record
// and its audit rather than closing it (20260815360000 for invoices,
// 20260815370000 for the five sales/delivery tables).
//
// Each surface is closed by a BEFORE DELETE trigger that refuses the delete for
// any caller with an end-user identity (auth.uid() is not null), while an
// identity-less server-side caller — the service role's fixture cleanup and the
// ON DELETE CASCADE from a deleted organization — stays exempt. This pins that
// every one of those triggers is present and wired to BEFORE DELETE, so a future
// migration or a verbatim function regeneration cannot silently reopen the
// destructive verb while every service-role verify script (exempt) still passes.

const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const allSql = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => sqlCode(readFileSync(dir + f, 'utf8')))
  .join('\n');

// The five sales/delivery tables share core.reject_end_user_delete();
// finance.invoices has its own message-specific twin. table → guard function.
const GUARDED: Array<{ table: string; fn: string }> = [
  { table: 'sales.opportunities', fn: 'core.reject_end_user_delete' },
  { table: 'projects.projects', fn: 'core.reject_end_user_delete' },
  { table: 'sales.proposals', fn: 'core.reject_end_user_delete' },
  { table: 'projects.deliverables', fn: 'core.reject_end_user_delete' },
  { table: 'projects.handovers', fn: 'core.reject_end_user_delete' },
  { table: 'finance.invoices', fn: 'finance.invoices_reject_end_user_delete' },
];

describe('a sanctioned record is closed by its terminal state, never deleted by an end-user', () => {
  test('the shared reject-end-user-delete guard refuses an authenticated caller', () => {
    const marker = 'create or replace function core.reject_end_user_delete(';
    const idx = allSql.toLowerCase().indexOf(marker);
    assert.ok(idx >= 0, 'core.reject_end_user_delete() must be defined in a migration');
    const body = allSql.slice(idx, idx + 1200);
    // It gates on an end-user identity — the auth.uid()-is-not-null shape — so a
    // raw service-role / cron / migration caller (auth.uid() is null) stays exempt.
    assert.match(
      body,
      /auth\.uid\(\)[\s)]+is\s+not\s+null/i,
      'core.reject_end_user_delete() must refuse only when auth.uid() is not null (end-user), exempting identity-less callers',
    );
    assert.match(body, /raise\s+exception/i, 'and it must raise to block the delete');
  });

  for (const { table, fn } of GUARDED) {
    const [, name] = table.split('.');
    test(`${table} carries a BEFORE DELETE guard`, () => {
      // create trigger <x> before delete on <table> for each row execute function <fn>()
      const re = new RegExp(
        `create trigger \\w+\\s+before delete on ${table.replace('.', '\\.')}\\s+for each row execute function ${fn.replace('.', '\\.')}\\(\\)`,
        'i',
      );
      assert.match(
        allSql,
        re,
        `${table} must have a BEFORE DELETE trigger running ${fn}() — its record is closed through its terminal state (${name} has one), not deleted by an end-user`,
      );
    });
  }
});
