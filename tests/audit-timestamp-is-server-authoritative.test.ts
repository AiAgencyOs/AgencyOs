import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

// audit.audit_log admits an authenticated append by design (audit_log_insert):
// anyone in the org may append about themselves (actor_id = auth.uid()), and the
// row can never be updated or deleted. But created_at was caller-controlled — no
// legitimate writer sets it (all rely on the now() default), yet a direct
// Data-API insert could back- or forward-date a self-attributed row, reordering
// the timeline an owner reads for forensics (a client stored created_at='2020'
// live). 20260815420000 forces created_at = now() for any caller with an identity
// via a BEFORE INSERT trigger; the identity-less service role keeps its value so
// a historical backfill stays possible.
//
// This pins the trigger, its guard, and its function on the last definition, so a
// future migration cannot silently return the timestamp to the caller's control
// while every service-role verify script (auth.uid() null, exempt) stays green.

const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const allSql = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => sqlCode(readFileSync(dir + f, 'utf8')))
  .join('\n');

describe('an audit row is timestamped by the server, not the caller', () => {
  test('the stamp function forces created_at = now() only for a caller with an identity', () => {
    const marker = 'create or replace function audit.stamp_created_at(';
    const idx = allSql.toLowerCase().lastIndexOf(marker);
    assert.ok(idx >= 0, 'audit.stamp_created_at() must be defined');
    const body = allSql.slice(idx, idx + 900);
    // Gated on an end-user identity, so the identity-less service role keeps its
    // supplied value (a historical backfill stays possible).
    assert.match(
      body,
      /auth\.uid\(\)[\s)]+is\s+not\s+null/i,
      'the stamp must apply only when auth.uid() is not null, exempting the service role',
    );
    assert.match(
      body,
      /new\.created_at\s*:=\s*now\(\)/i,
      'and it must overwrite created_at with now()',
    );
  });

  test('the BEFORE INSERT trigger is installed on audit.audit_log', () => {
    assert.match(
      allSql,
      /create trigger \w+\s+before insert on audit\.audit_log\s+for each row execute function audit\.stamp_created_at\(\)/i,
      'audit.audit_log must carry a BEFORE INSERT trigger running audit.stamp_created_at()',
    );
  });
});
