import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { fromWireToolName, toWireToolName } from '../src/lib/ai/tool-names.ts';
import { TOOL_NAMES } from '../src/modules/agents/tools.ts';

// Anthropic's documented tool-name pattern. A stub model never checks it; the
// real API answered every tool-using call 400 `tools.0.custom.name` while the
// whole verifier fleet was green (found by the first live run, 2026-10-03).
const ANTHROPIC_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

describe('a tool id crosses the provider boundary as a name the real API accepts', () => {
  test('every registered tool id has a valid wire name', () => {
    assert.ok(TOOL_NAMES.length > 0);
    for (const name of TOOL_NAMES) {
      assert.match(toWireToolName(name), ANTHROPIC_TOOL_NAME, name);
    }
  });

  test('the translation is reversible for every registered tool, and ids never collide', () => {
    const wire = new Set<string>();
    for (const name of TOOL_NAMES) {
      const w = toWireToolName(name);
      assert.equal(fromWireToolName(w), name);
      assert.ok(!wire.has(w), `two tools share the wire name ${w}`);
      wire.add(w);
    }
  });

  test('the positive twin: the dotted ids really were invalid as they stood', () => {
    assert.ok(TOOL_NAMES.some((n) => !ANTHROPIC_TOOL_NAME.test(n)));
  });
});
