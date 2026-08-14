/**
 * Strip comments before asserting an absence.
 *
 * This exists because the same mistake has now been made five times in this
 * repository, in five different files: a check that asserts some construct is
 * *gone* is run against source that **explains why it is gone**, finds the
 * explanation, and fails — or worse, a check asserting something is *present*
 * is satisfied by a comment mentioning it, and passes while the code is wrong.
 *
 * Both directions are the same bug: **a claim about code was checked against
 * prose.** `check-record` §17 hit it, the G-126 audit test hit it, the
 * quotation outcome test hit it twice, and the upsell tests hit it again.
 *
 * The fix is small enough that writing it inline each time felt cheaper than
 * sharing it, which is exactly why it kept recurring.
 *
 * Handles `--` (SQL), `//` (TypeScript) and `/* *\/` blocks. It is deliberately
 * naive: it will also blank a `--` or `//` inside a string literal. For the
 * assertions this serves — "does this construct appear in the code" — a false
 * *absence* is the safe direction, and no test here searches for a literal
 * containing a comment marker.
 *
 * **It does not remove string literals, and that matters.** A SQL
 * `comment on ... is '...'` body is a string, not a comment, so prose inside
 * one survives this untouched — which caught out the G-037 tests, whose view
 * comment quotes the exact words they assert are absent. When a file documents
 * itself in string literals, bound the slice to the code region *first* and
 * pass that in.
 */
export function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

/**
 * Strip comments **and SQL `comment on … is '…';` statements**.
 *
 * The recurring shape `codeOnly` alone cannot handle. A migration in this
 * repository documents itself twice: once in `--` comments and again in
 * `comment on` bodies, which are string literals rather than comments. An
 * absence assertion run over the raw file finds the documentation and fails on
 * it — which happened to the G-037 tests and again to G-113's, by which point
 * it was clearly a shape rather than an accident.
 *
 * Callers asserting "this construct does not appear in the SQL" should use
 * this. Callers asserting that a `comment on` says something should read the
 * unstripped source, which is the other half of the same distinction.
 */
export function sqlCode(source: string): string {
  return codeOnly(source).replace(/comment on [\s\S]*?;\s*$/gm, ' ');
}
