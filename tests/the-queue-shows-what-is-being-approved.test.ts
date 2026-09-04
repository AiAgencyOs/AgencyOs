import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly } from './_code-only.ts';

/**
 * The queue shows what is being approved — G-202 (audit OA-10).
 *
 * ADM-96 says the PDF is what the owner decides against, and it reached them
 * everywhere except the one screen whose entire purpose is deciding.
 *
 *   the WhatsApp announcement   carries the rendered PDF (G-162, live)
 *   the lead's quotation panel  links every version's PDF
 *   the approvals queue         a summary somebody else wrote, and an amount
 *
 * A summary is a claim about a document. Deciding against the claim rather
 * than the document is the shape of every approval that later surprises
 * somebody.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const QUEUE = codeOnly(read('app/(internal)/approvals/page.tsx'));

describe('A. the document is on the page where it is decided', () => {
  test('a proposal approval links its own quotation', () => {
    assert.match(QUEUE, /href=\{`\/api\/quotations\/\$\{request\.subject_id\}\/pdf`\}/);
  });

  test('and only a proposal — nothing else has a quotation to show', () => {
    /**
     * Anchored on the opening brace, and that is the whole assertion.
     *
     * The first version matched the condition as a substring, so a red-proof
     * that disabled the branch with `{false && …}` left it green: the pin
     * proved the words were present, not that the branch was reachable. Same
     * shape as every other vacuous check this repository has found.
     */
    assert.match(QUEUE, /\{request\.subject_type === 'proposal' && request\.subject_id \?/);
    assert.ok(!/\{\s*false\s*&&/.test(QUEUE), 'no branch on this page may be switched off in place');
  });

  test('through the same route the lead page uses, not a second one', () => {
    // A second door to the same document is a second place for the gate to
    // drift: this route re-checks `lead.read` in the service behind it.
    const lead = codeOnly(read('app/(internal)/leads/[leadId]/page.tsx'));
    assert.match(lead, /\/api\/quotations\/\$\{p\.id\}\/pdf/);
  });

  test('the subject id it needs is already selected — no new query', () => {
    const queries = codeOnly(read('src/modules/approvals/queries.ts'));
    assert.match(queries, /'id, subject_type, subject_id,/);
  });
});
