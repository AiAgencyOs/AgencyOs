import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

// Found live (2026-10-03): the AI agent's replies are stored with the staff
// author type, so the lead chat labelled every one of them "Staff".
describe('the lead chat says when an AI wrote the message', () => {
  const page = read('app/(internal)/leads/[leadId]/page.tsx');
  const queries = read('src/modules/crm/queries.ts');

  test('the message read carries who authored it', () => {
    assert.match(queries, /retry_count, authored_by_agent'\)/);
    assert.match(read('src/modules/crm/types.ts'), /'retry_count' \| 'authored_by_agent'/);
  });

  test('a message with an authoring agent is labelled as AI, not Staff — and one without keeps its label', () => {
    assert.match(page, /if \(m\.authored_by_agent\) return `AI · \$\{m\.authored_by_agent\}`;/);
    assert.match(page, /return AUTHOR_LABEL\[m\.author_type\] \?\? m\.author_type;/);
    assert.match(page, /author=\{\s*startsRun && !incoming\s*\? authorOf\(m\)/);
  });
});
