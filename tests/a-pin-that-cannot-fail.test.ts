import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

/**
 * A pin that cannot fail — G-208 (audit TS-A).
 *
 * ── the finding, and what it is really about ──────────────────────────────
 *
 * The audit filed TS-A: a large share of this suite's assertions are
 * SOURCE-TEXT PINS — they match a regex against a file's own text rather than
 * running the thing and looking at what it did. Its estimate was "~40%"; the
 * measured figure is below, and lower.
 *
 * A pin is not wrong in itself. Some rules have no runtime to observe — that a
 * migration contains no `alter table`, that a docblock records a decision,
 * that a prompt carries a sentence. For those, the file IS the behaviour.
 *
 * **The danger is specific and it is not the ratio.** A pin can pass while the
 * thing it describes is absent, and it does so silently, because a regex that
 * finds nothing and a regex asked of nothing look identical from the outside.
 * This session produced three of them in a row:
 *
 *   1. a pin matched a condition as a SUBSTRING, so wrapping the branch in
 *      `{false && …}` left it green;
 *   2. a pin was asked of a `sqlCode()` result that the stripper had emptied —
 *      sixty blank lines — in exactly the case it was written for;
 *   3. a pin was asked of the wrong schema, one whose job is not to refuse.
 *
 * Converting 1,409 assertions is not what makes those impossible. **Making the
 * failure mode detectable is.** So this file does not refactor the suite; it
 * checks the pins can bite, and puts a number on the rest.
 */

const HERE = new URL('.', import.meta.url);
const repo = (rel: string) => fileURLToPath(new URL(`../${rel}`, HERE));
const TEST_FILES = readdirSync(fileURLToPath(HERE))
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => ({ name: f, text: readFileSync(fileURLToPath(new URL(f, HERE)), 'utf8') }));

/** Every `codeOnly('…path…')` / `sqlCode('…path…')` subject, per file. */
const STRIPPED: Array<{ file: string; path: string; stripper: 'codeOnly' | 'sqlCode' }> = [];
for (const { name, text } of TEST_FILES) {
  for (const m of text.matchAll(/\b(codeOnly|sqlCode)\s*\(\s*\w+\s*\(\s*'([^']+)'/g)) {
    STRIPPED.push({ file: name, path: m[2]!, stripper: m[1] as 'codeOnly' | 'sqlCode' });
  }
}

describe('A. no pin is asked of a source the stripper emptied', () => {
  test('there are pins to check at all', () => {
    // Without this, every assertion below passes on an empty list — which is
    // the exact defect the file exists to catch, in the file that catches it.
    assert.ok(STRIPPED.length > 20, `only ${STRIPPED.length} stripped subjects found — the scan broke`);
  });

  for (const { file, path, stripper } of STRIPPED) {
    test(`${file} → ${stripper}(${path}) still has code in it`, () => {
      const full = repo(path);
      assert.ok(existsSync(full), `${file} pins ${path}, which does not exist`);
      const stripped = (stripper === 'sqlCode' ? sqlCode : codeOnly)(readFileSync(full, 'utf8'));

      /**
       * The number is low on purpose: this is not a style rule about file
       * size, it is a check that the stripper left something to match.
       *
       * `sqlCode` removes `comment on … ;` along with `--` lines, so a
       * migration made only of comment statements strips to whitespace — and
       * an assertion against it passes or fails on nothing at all.
       */
      assert.ok(
        stripped.replace(/\s+/g, '').length > 120,
        `${stripper}(${path}) strips to ${stripped.replace(/\s+/g, '').length} non-space characters — ` +
          `any pin against it is being asked of an empty string`,
      );
    });
  }
});

describe('B. every source a test reads is a source it asserts against', () => {
  for (const { name, text } of TEST_FILES) {
    const bound = [...text.matchAll(/(?:const|let)\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:codeOnly|sqlCode|read|root|readFileSync)\s*\(/g)]
      .map((m) => m[1]!);
    if (bound.length === 0) continue;

    test(`${name} uses all ${bound.length} source blob(s) it binds`, () => {
      for (const blob of bound) {
        // Two occurrences: the binding, and at least one use. A file that
        // reads a source and never asserts against it looks like it checks
        // that file and does not.
        const uses = text.match(new RegExp(`\\b${blob}\\b`, 'g'))?.length ?? 0;
        assert.ok(uses > 1, `${name} binds ${blob} and never reads it`);
      }
    });
  }
});

describe('C. the ratio is a number, and it only goes down', () => {
  /**
   * TS-A's own measurement, kept honest.
   *
   * The audit estimated "~40%". Measured by resolving which identifiers in
   * each file are bound to a source blob, and counting the assert statements
   * that mention one, it is the figure below. Recording it as a ratchet turns
   * TS-A from an impression into a direction: a change may lower it and may
   * not raise it, and raising it deliberately means editing this line and
   * saying why.
   */
  const CEILING = 0.26;

  test(`no more than ${(CEILING * 100).toFixed(0)}% of assertions are source-text pins`, () => {
    let total = 0;
    let pins = 0;
    for (const { text } of TEST_FILES) {
      const blobs = new Set(
        [...text.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:codeOnly|sqlCode|read|root|readFileSync)\s*\(/g)]
          .map((m) => m[1]!),
      );
      const statements = text.match(/assert\.\w+\((?:[^;]|\n)*?\);/g) ?? [];
      total += statements.length;
      for (const statement of statements) {
        const mentionsBlob = [...blobs].some((b) => new RegExp(`\\b${b}\\b`).test(statement));
        if (mentionsBlob || /\b(?:codeOnly|sqlCode|read|root|readFileSync)\s*\(/.test(statement)) pins += 1;
      }
    }

    assert.ok(total > 3_000, `only ${total} assert statements found — the scan broke, not the suite`);
    const ratio = pins / total;
    assert.ok(
      ratio <= CEILING,
      `source-text pins are ${(ratio * 100).toFixed(1)}% of ${total} assertions, above the ${(CEILING * 100).toFixed(0)}% ceiling. ` +
        `Prefer an assertion that runs the thing; raise this line only with a reason.`,
    );
  });
});
