import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { region, TO_END } from './_region.ts';

/**
 * A region has two ends — G-294.
 *
 * 189 test regions were taken as `SOURCE.slice(SOURCE.indexOf('marker'))`,
 * with no end. Each was correct when written and became wrong the day the
 * next unit appended something below the marker in the same file: whatever
 * was appended silently joined the region, changing every count taken over it
 * and every absence asserted about it.
 *
 * **Four of them bit in a single session** — the lucky case, where a count
 * went from three to four and a test went red. The unlucky case is an absence
 * assertion that the swallowed code happens to satisfy: the test stays green
 * while the region it names no longer holds the property, and nothing
 * distinguishes the two from outside.
 *
 * This file is the check that stops the shape coming back, and the proof that
 * the helper replacing it fails rather than falls back.
 */

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const TESTS = here('.');
const files = readdirSync(TESTS).filter((f) => f.endsWith('.ts'));

/** `.slice(` with a single `indexOf` argument, honouring parens inside strings. */
function unboundedSlices(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\.slice\(/g)) {
    let depth = 1;
    let j = m.index + m[0].length;
    let quote: string | null = null;
    const from = j;
    while (j < source.length) {
      const ch = source[j]!;
      if (quote) {
        if (ch === '\\') { j += 2; continue; }
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
      } else if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      j += 1;
    }
    const arg = source.slice(from, j);
    let d = 0;
    let q: string | null = null;
    let comma = false;
    for (const ch of arg) {
      if (q) { if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') q = ch;
      else if (ch === '(') d += 1;
      else if (ch === ')') d -= 1;
      else if (ch === ',' && d === 0) comma = true;
    }
    if (arg.includes('indexOf') && !comma && !arg.includes('+') && !arg.includes('||')) out.push(arg.trim());
  }
  return out;
}

describe('A. the shape cannot come back', () => {
  test('no test takes a region with only a start', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f === 'a-region-has-two-ends.test.ts' || f === '_region.ts') continue;
      for (const a of unboundedSlices(readFileSync(TESTS + f, 'utf8'))) offenders.push(`${f}: .slice(${a})`);
    }
    assert.deepEqual(offenders, []);
  });

  test('and the sweep reads a real list of test files', () => {
    // Zero files would make the assertion above pass on nothing at all — the
    // vacuous pass is the whole failure class this gap is about.
    assert.ok(files.length > 200, `only ${files.length} files were swept`);
  });

  test('the detector actually detects, on a known-bad string', () => {
    // A check that has never found anything is a hope. This is the exact
    // shape, and the two shapes it must NOT flag.
    assert.deepEqual(unboundedSlices("const b = S.slice(S.indexOf('x'));"), ["S.indexOf('x')"]);
    assert.deepEqual(unboundedSlices("const b = S.slice(S.indexOf('x'), S.indexOf('y'));"), []);
    assert.deepEqual(unboundedSlices('const b = S.slice(0, 400);'), []);
    // A paren inside the marker string must not end the argument early.
    assert.deepEqual(unboundedSlices("const b = S.slice(S.indexOf('f(a'));"), ["S.indexOf('f(a')"]);
  });
});

describe('B. the helper fails rather than falls back', () => {
  const SRC = 'alpha\nexport const one = 1;\nbeta\nexport const two = 2;\n';

  test('a region stops at the next structural boundary', () => {
    assert.equal(region(SRC, 'alpha'), 'alpha');
  });

  test('a start marker that does not resolve is an error, not slice(−1)', () => {
    // `indexOf` returning −1 makes `slice(-1)` the LAST CHARACTER of the file,
    // and every absence assertion passes on one character. This found three
    // live instances the moment it was switched on — one of them a seeder
    // whose "never updates, never deletes" assertions had been reading a
    // single `;` because the marker was lowercase and the SQL was not.
    assert.throws(() => region(SRC, 'nowhere'), /start marker not found/);
  });

  test('an end marker that does not resolve is an error too', () => {
    // Falling back to the end of the file is the behaviour this exists to
    // remove — and it is the failure a reader is least likely to suspect,
    // because the region is still correct on the day it is written.
    assert.throws(() => region(SRC, 'alpha', 'omega'), /end marker not found/);
  });

  test('a region that swallowed the file is refused', () => {
    assert.throws(() => region('alpha only', 'alpha only'), /did not bound anything/);
  });

  test('and `to the end of the file` has to be said out loud', () => {
    // It is legitimate — the last handler, the last function — but it is a
    // choice, and a greppable one: every use is a place to look when the file
    // it reads grows a section below.
    assert.equal(region(SRC, 'beta', TO_END), 'beta\nexport const two = 2;\n');
    const uses = files.filter((f) => readFileSync(TESTS + f, 'utf8').includes('TO_END'));
    assert.ok(uses.length > 0 && uses.length < 30, `${uses.length} files use TO_END`);
  });
});

describe('C. one implementation, not one per file', () => {
  test('no test file carries its own bounded-slice helper', () => {
    // Six did. The fix is small enough that writing it inline felt cheaper
    // than sharing it, which is exactly why it kept being written wrong — all
    // six fell back to the end of the file when the end marker was missing,
    // silently restoring the behaviour they were written to prevent.
    const local = files.filter((f) => /const bounded = \(source: string/.test(readFileSync(TESTS + f, 'utf8')));
    assert.deepEqual(local, []);
  });

  test('and the helper says why it exists, where the next author will read it', () => {
    const helper = readFileSync(here('./_region.ts'), 'utf8');
    assert.match(helper, /The dangerous direction is the silent one/);
    assert.match(helper, /the start marker EXISTS/);
  });
});
