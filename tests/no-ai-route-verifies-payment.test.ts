import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';

import { AGENT_DEFINITIONS } from '../src/modules/agents/registry.ts';
import { TOOLS } from '../src/modules/agents/tools.ts';
import { RUNNER_SOURCE } from './_runner-source.ts';

/**
 * Phase 4 Orchestrator spec §22, MUST-level: "no AI route can claim final
 * payment verification." The Finance Agent audit found this already true —
 * `finance.verifyPayment`/`verifyPaymentSubmission` have exactly one caller
 * in the whole repo (`src/modules/finance/actions.ts`, a session-bound Server
 * Action behind `requireInternal()`), no tool named for either exists, and
 * ADM-99's dispatch allowlist (`tool-dispatch.ts`'s `DISPATCHABLE`) excludes
 * it regardless. This file is the regression proof, not a fix — it exists so
 * that a future agent, tool, or workflow reaching for either RPC fails loudly
 * here instead of silently reopening the seam ADM-82/83 close.
 */

const VERIFY_PAYMENT_RE = /verify.?payment/i;
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

const toolDispatchSource = read('../src/modules/agents/tool-dispatch.ts');
const registrySource = read('../src/modules/agents/registry.ts');
const financeService = read('../src/modules/finance/service.ts');
const financeActions = read('../src/modules/finance/actions.ts');

describe('no AI route may verify a payment — ADM-82/83, Orchestrator spec §22', () => {
  test('no bound tool is named for verifying a payment', () => {
    for (const tool of TOOLS) {
      assert.doesNotMatch(tool.name, VERIFY_PAYMENT_RE, `tool "${tool.name}" looks payment-verification-shaped`);
    }
  });

  test('no agent definition binds a payment-verification-shaped tool', () => {
    for (const agent of AGENT_DEFINITIONS) {
      for (const toolName of agent.tools) {
        assert.doesNotMatch(
          toolName,
          VERIFY_PAYMENT_RE,
          `${agent.key} binds "${toolName}", which looks payment-verification-shaped`,
        );
      }
    }
  });

  test("ADM-99's dispatchable allowlist excludes payment verification", () => {
    const dispatchable = /const DISPATCHABLE: readonly string\[\] = \[([\s\S]*?)\];/.exec(toolDispatchSource);
    assert.ok(dispatchable, 'DISPATCHABLE array not found in tool-dispatch.ts — has it moved?');
    assert.doesNotMatch(dispatchable![1]!, VERIFY_PAYMENT_RE);
  });

  test('no AgentWorkflow calls verify_payment or verify_payment_submission', () => {
    assert.doesNotMatch(RUNNER_SOURCE, /\.rpc\(\s*['"]verify_payment(_submission)?['"]/);
    assert.doesNotMatch(RUNNER_SOURCE, /import\s*\{[^}]*\bverifyPayment\b[^}]*\}\s*from\s*['"]@\/modules\/finance\/service['"]/);
  });

  test('registry.ts never imports or calls the finance verification functions', () => {
    assert.doesNotMatch(registrySource, /verifyPayment/);
  });

  test('verifyPayment/verifyPaymentSubmission have exactly one caller in the whole repo', () => {
    const roots = ['../src', '../app'].map((p) => fileURLToPath(new URL(p, import.meta.url)));
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (entry === 'node_modules' || entry === '.next') continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        if (full.endsWith('src/modules/finance/service.ts') || full.endsWith('src/modules/finance/actions.ts')) continue;
        const text = readFileSync(full, 'utf8');
        if (/verifyPayment\(/.test(text) || /\.rpc\(\s*['"]verify_payment(_submission)?['"]/.test(text)) {
          offenders.push(relative(fileURLToPath(new URL('..', import.meta.url)), full));
        }
      }
    };

    for (const root of roots) walk(root);

    assert.deepEqual(offenders, [], `only finance/actions.ts may call verifyPayment; also found: ${offenders.join(', ')}`);

    // And confirm the one legitimate call site is exactly what we expect —
    // if this ever moves, the exclusion list above must move with it.
    assert.match(financeActions, /verifyPayment\(/);
    assert.match(financeService, /export async function verifyPayment/);
  });
});
