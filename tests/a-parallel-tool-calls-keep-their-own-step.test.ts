import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const src = readFileSync(new URL('../app/api/jobs/run/agent-run.ts', import.meta.url), 'utf8');
const loopStart = src.indexOf('export async function callModelWithTools');
// bounded at the function's own closing brace, so a later addition cannot be swallowed into the region
const loop = src.slice(loopStart, src.indexOf('\n}\n', loopStart) + 3);

describe('a model that asks for several tools in one turn leaves one trace row for each', () => {
  test('the step numbers are decided before the concurrent calls start, not read from a shared counter', () => {
    const start = loop.indexOf('const results = await Promise.all(');
    assert.ok(start > 0);
    const block = loop.slice(start, loop.indexOf('messages.push({\n      role: \'user\'', start));
    assert.match(loop.slice(Math.max(0, start - 200), start), /const base = seq;/);
    assert.match(block, /seq: base \+ index/);
    assert.doesNotMatch(block, /seq = await recordToolCall/, 'a shared counter advanced inside Promise.all hands every call the same step');
    assert.match(loop, /seq = base \+ response\.data\.calls\.length;/);
  });
});
