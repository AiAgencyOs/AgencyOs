import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { attemptBudgetFor, settlementFor } from '../src/lib/jobs/retry.ts';
import { schemaRefusal } from '../src/lib/ai/model-json.ts';

/**
 * The three P0 findings of the Phase 1-3 cost benchmark (Rs 45.57 for 10 messages): a failed call recorded 0 tokens, a refused
 * output was retried up to five times, and every message re-read the whole transcript for requirements.
 */
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const workflows = read('../app/api/jobs/run/workflows.ts');
const agentRun = read('../app/api/jobs/run/agent-run.ts');

describe('a refused model output is retried once, not four times', () => {
  const refusal = schemaRefusal({ issues: [{ path: ['scopeItems'], message: 'Required' }] });

  test('the budget for a schema refusal is two attempts', () => {
    assert.equal(attemptBudgetFor(refusal, 5), 2);
  });

  test('every other failure keeps its own budget', () => {
    assert.equal(attemptBudgetFor('provider timeout', 5), 5);
  });

  test('a lower configured budget is never raised', () => {
    assert.equal(attemptBudgetFor(refusal, 1), 1);
  });

  test('the second refusal parks the job; the first is retried', () => {
    assert.equal(settlementFor({ attemptsMade: 1, maxAttempts: attemptBudgetFor(refusal, 5) }, false, 0).status, 'queued');
    assert.equal(settlementFor({ attemptsMade: 2, maxAttempts: attemptBudgetFor(refusal, 5) }, false, 0).status, 'dead');
  });

  test('failJob applies the budget', () => {
    assert.match(agentRun, /maxAttempts: attemptBudgetFor\(reason, job\.max_attempts\)/);
  });
});

describe('a failed call is not recorded as free', () => {
  test('finishRun can carry usage, and writes it', () => {
    assert.match(agentRun, /usage\?: \{ inputTokens: number; outputTokens: number; costMinor: number \}/);
    assert.match(agentRun, /input_tokens: usage\.inputTokens, output_tokens: usage\.outputTokens, cost_minor: usage\.costMinor/);
  });

  test('every schema refusal passes the usage of the call that produced it', () => {
    const refused = workflows.match(/schemaRefusal\(validated\.error\);\n\s*await finishRun\([^\n]*\)/g) ?? [];
    assert.ok(refused.length >= 27, `expected at least 27 schema-refusal sites, found ${refused.length}`);
    for (const site of refused) assert.match(site, /call\.usage\)$/, site);
  });
});

describe('requirement re-extraction is skipped when it can add nothing', () => {
  test('the gate runs before the run is opened, so it costs no call', () => {
    const gate = workflows.indexOf('extractionNotNeeded(admin, job.organization_id');
    const open = workflows.indexOf("type: 'crm.conversation',", gate);
    assert.ok(gate > 0 && open > gate);
  });

  test('the first extraction of a conversation always runs', () => {
    assert.match(workflows, /if \(!versions \|\| versions\.length === 0\) return null;/);
  });

  test('an acknowledgement, and an accepted scope on a person-held thread, are the two skips', () => {
    assert.match(workflows, /client only acknowledged; nothing new to extract/);
    assert.match(workflows, /a person has the thread and has accepted a version/);
  });
});
