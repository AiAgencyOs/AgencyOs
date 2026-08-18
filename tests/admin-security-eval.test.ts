import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isClean, securityChecks, type SecurityPosture } from '../src/lib/admin/security-eval.ts';

const clean: SecurityPosture = { unguarded_fks: [], unfrozen_tables: [], invoker_writes: [] };

describe('securityChecks', () => {
  test('an all-empty posture is clean — every invariant holds', () => {
    assert.equal(isClean(clean), true);
    assert.ok(securityChecks(clean).every((c) => c.ok && c.count === 0));
  });

  test('a violation is reported with its exact count and identifiers — real evidence', () => {
    const p: SecurityPosture = {
      unguarded_fks: [{ child: 'crm.import_records', fk_column: 'batch_id', parent: 'crm.import_batches' }],
      unfrozen_tables: [{ org_table: 'crm.import_records' }],
      invoker_writes: [{ target: 'crm.conversation_messages', op: 'UPDATE', writer: 'crm.some_fn' }],
    };
    const checks = securityChecks(p);
    assert.equal(isClean(p), false);
    const fk = checks.find((c) => c.id === 'tenant-fk-guards')!;
    assert.equal(fk.ok, false);
    assert.equal(fk.count, 1);
    assert.match(fk.offenders[0]!, /import_records\.batch_id → crm\.import_batches/);
    assert.equal(checks.find((c) => c.id === 'org-freeze')!.count, 1);
    assert.equal(checks.find((c) => c.id === 'invoker-writes')!.count, 1);
  });

  test('a partial violation leaves the other checks green (no smearing)', () => {
    const p: SecurityPosture = { ...clean, unfrozen_tables: [{ org_table: 'x.y' }] };
    const checks = securityChecks(p);
    assert.equal(checks.find((c) => c.id === 'org-freeze')!.ok, false);
    assert.equal(checks.find((c) => c.id === 'tenant-fk-guards')!.ok, true);
    assert.equal(checks.find((c) => c.id === 'invoker-writes')!.ok, true);
  });
});
