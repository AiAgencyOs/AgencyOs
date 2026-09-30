import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { listToolDefinitions, toolDetailFor } from '../src/modules/agents/permissions-schema.ts';
import { TOOLS } from '../src/modules/agents/tools.ts';

import { codeOnly } from './_code-only.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * Bucket G, stream G-3 — SCR-061 "Open model/tool detail".
 *
 *   1. A model has a page: the registry row, who added it, what routes to
 *      it, the runs that carried it in the period, the last twenty runs.
 *   2. A tool has a page: what it does, who is bound to it, how often it was
 *      called and failed, the last twenty calls linking to their runs.
 *   3. Both are gated on the dashboard's read capability, refuse an unknown
 *      id with the shell's not-found, and are linked from where the PDF puts
 *      them: the dashboard's Model usage and tools list, the routing
 *      registry, the agent page's tool list.
 *   4. Every read failure refuses; nothing is estimated.
 */

const MODEL_PAGE = 'app/(internal)/agents/models/[modelId]/page.tsx';
const TOOL_PAGE = 'app/(internal)/agents/tools/[toolName]/page.tsx';

describe('1. a model has a page', () => {
  test('the page exists, is gated on audit.read, and 404s an unknown id', () => {
    assert.ok(existsSync(join(process.cwd(), MODEL_PAGE)));
    const page = read(MODEL_PAGE);
    assert.match(page, /can\(context, 'audit\.read'\)/);
    assert.match(page, /if \(!detail\) notFound\(\);/);
    assert.doesNotMatch(page, /context\.role\b/);
  });

  test('the reader answers the registry row, who added it, the routes, the period and the last runs', () => {
    const reader = codeOnly(read('src/lib/admin/model-detail.ts'));
    assert.match(reader, /from\('models'\)[\s\S]*?\.eq\('model_id', modelId\)/);
    assert.match(reader, /\.in\('action', \['model\.added', 'model\.reactivated'\]\)/);
    assert.match(reader, /from\('routing_policies'\)/);
    assert.match(reader, /from\('agent_routing_overrides'\)/);
    assert.match(reader, /from\('fallback_chains'\)/);
    assert.match(reader, /from\('agent_runs'\)[\s\S]*?\.eq\('model', modelId\)/);
    assert.match(reader, /averageLatencyMs: latencies\.length > 0 \? Math\.round/);
    assert.match(reader, /recentRuns: runRows\.slice\(0, recentLimit\)/);
    const guards = reader.match(/if \([A-Za-z.]*[eE]rror\)/g) ?? [];
    const refusals = reader.match(/unreadable\(/g) ?? [];
    assert.equal(guards.length, refusals.length, 'every failed read refuses');
  });

  test('the page shows rates, routes, the period figures and links each run', () => {
    const page = read(MODEL_PAGE);
    for (const label of ['Provider', 'Capabilities', 'Input rate', 'Output rate', 'Added']) assert.match(page, new RegExp(`label: '${label}'`));
    assert.match(page, /title="What routes here"/);
    assert.match(page, /label=\{`Runs \(\$\{period\.days\}d\)`\}/);
    assert.match(page, /label="Tokens"/);
    assert.match(page, /label="Avg latency"/);
    assert.match(page, /href=\{\(r\) => `\/usage\/runs\/\$\{r\.id\}`\}/);
  });
});

describe('2. a tool has a page', () => {
  test('the page exists, is gated on audit.read, and 404s an unknown name', () => {
    assert.ok(existsSync(join(process.cwd(), TOOL_PAGE)));
    const page = read(TOOL_PAGE);
    assert.match(page, /can\(context, 'audit\.read'\)/);
    assert.match(page, /if \(!tool\) notFound\(\);/);
  });

  test('the definition is read from the registry, and every registered tool has one', () => {
    for (const t of TOOLS) {
      const detail = toolDetailFor(t.name);
      assert.ok(detail, `${t.name} has no detail`);
      assert.equal(detail.purpose, t.purpose);
      assert.equal(detail.actionClass, t.actionClass);
    }
    assert.equal(toolDetailFor('nothing.here'), null);
    assert.equal(listToolDefinitions().length, TOOLS.length);
    // memory.recall is the most-bound tool; its agents are the definitions that list it.
    const recall = toolDetailFor('memory.recall');
    assert.ok(recall && recall.boundAgents.length >= 5);
  });

  test('the reader counts tool_call steps by request->>tool in the period, with a failure rate', () => {
    const reader = codeOnly(read('src/modules/agents/tool-detail-queries.ts'));
    assert.match(reader, /\.eq\('kind', 'tool_call'\)/);
    assert.match(reader, /\.eq\('request->>tool', toolName\)/);
    assert.match(reader, /failureRate: steps\.length > 0 \? failed \/ steps\.length : null/);
    assert.match(reader, /from\('agent_tool_permissions'\)[\s\S]*?\.eq\('tool_key', toolKey\)/);
    const guards = reader.match(/if \([A-Za-z.]*[eE]rror\)/g) ?? [];
    const refusals = reader.match(/unreadable\(/g) ?? [];
    assert.equal(guards.length, refusals.length, 'every failed read refuses');
  });

  test('the page links each call to its run and each bound agent to its page', () => {
    const page = read(TOOL_PAGE);
    assert.match(page, /href=\{\(r\) => `\/usage\/runs\/\$\{r\.runId\}`\}/);
    assert.match(page, /href=\{`\/agents\/\$\{encodeURIComponent\(a\.key\)\}`\}/);
    assert.match(page, /label="Failure rate"/);
  });
});

describe('3. the PDF puts the links on the dashboard, the registry and the agent page', () => {
  test('the dashboard’s Model usage links each model, and its tools list links each tool', () => {
    const dashboard = read('app/(internal)/agents/page.tsx');
    assert.match(dashboard, /href=\{`\/agents\/models\/\$\{encodeURIComponent\(m\.model\)\}`\}/);
    assert.match(dashboard, /listToolDefinitions\(\)\.map\(\(t\) =>/);
    assert.match(dashboard, /href=\{`\/agents\/tools\/\$\{encodeURIComponent\(t\.name\)\}`\}/);
  });

  test('the routing registry links each model id', () => {
    const routing = read('app/(internal)/agents/routing/page.tsx');
    assert.match(routing, /href=\{`\/agents\/models\/\$\{encodeURIComponent\(m\.modelId\)\}`\}/);
  });

  test('the agent page’s tool list links each tool', () => {
    const panel = read('app/(internal)/agents/[agentKey]/policy-panel.tsx');
    assert.equal((panel.match(/href=\{`\/agents\/tools\/\$\{encodeURIComponent\((?:k|toolKey)\)\}`\}/g) ?? []).length, 2);
  });
});
