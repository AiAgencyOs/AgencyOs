import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * A number the owner declined.
 *
 * ADM-88: *"no numeric lead score and no invented weights — the repository has
 * no approved scoring model and inventing one is out of scope."*
 *
 * `crm.leads.score` (0–100) and `score_reasons` were written by nothing in the
 * application and **filled by the seed**, so every fresh environment showed an
 * operator `· score 82` with reasons under it for a feature that does not
 * exist. That is the class G-101 and the ADM-74 announcement belong to: the
 * system telling an operator something untrue about itself.
 *
 * The refusal itself is a CHECK constraint proved against real Postgres by
 * `db:verify:noscore`. What this file protects is the other half — that the
 * surface does not grow back, quietly, in a file nobody connects to a decision
 * made in a different month.
 */
describe('ADM-88 — a lead carries no invented score', () => {
  const migration = readdirSync(join(root, 'supabase/migrations'))
    .filter((f) => f.includes('a_number_the_owner_declined'))
    .map((f) => read(`supabase/migrations/${f}`))
    .join('\n');

  test('the decision is a constraint, not a convention', () => {
    assert.ok(migration, 'the migration is missing');
    assert.match(migration, /check \(score is null and score_reasons is null\)/);
    // Both columns, because a justification with no number attached is still
    // the invented weight ADM-88 refused — and leaving score_reasons writable
    // would let the whole model arrive one column at a time.
    assert.match(migration, /score_reasons is null/);
  });

  test('and it clears the rows before it constrains them — the scores were on PRODUCTION', () => {
    // Not a fresh-environment problem after all. Two of production's five
    // leads carried 82 and 18 with three invented reasons each — the seeded
    // demo rows — so the live leads list was rendering `· score 82` to an
    // operator for a feature that does not exist.
    //
    // Found by running `supabase migration list --linked` before pushing and
    // then asking the live database whether the constraint could hold. It
    // could not: ALTER TABLE … ADD CONSTRAINT is refused by existing rows, so
    // the push would have aborted here and the six migrations after it would
    // never have applied.
    const update = migration.indexOf('update crm.leads');
    const constrain = migration.indexOf('add constraint leads_no_invented_score');
    assert.ok(update > -1, 'the migration constrains data it never cleared');
    assert.ok(update < constrain, 'the clear must come before the constraint, or the push aborts');
    assert.match(migration, /set score = null, score_reasons = null/);
    // Cleared rather than exempted. `payments_verified_together` carries a
    // grandfather clause and was right to; nothing is invented by clearing a
    // number nobody computed, and an exemption would preserve the only two
    // rows actually being shown to somebody.
    assert.doesNotMatch(migration, /created_at\s*<\s*'20\d\d/);
  });

  test('and the columns are retained rather than dropped, on purpose', () => {
    // Dropping them expresses the same rule and loses the trace. A reader who
    // finds a constrained column learns a decision was made; a reader who
    // finds nothing learns nothing, and re-adds the column.
    assert.doesNotMatch(migration, /drop column/i);
    assert.match(migration, /ADM-88/);
  });

  test('the seed no longer ships one', () => {
    // It shipped 82 and 18, with reasons. Found by writing the constraint and
    // watching `db reset` refuse the seed — the failure that proved the claim
    // "nothing writes these columns" had been wrong.
    const seed = read('supabase/seed.sql');
    const leadsInsert = seed.slice(seed.indexOf('insert into crm.leads'));
    const block = leadsInsert.slice(0, leadsInsert.indexOf('\n\n'));
    assert.doesNotMatch(block, /"reasons"/, 'the seed still ships score reasons');
    assert.doesNotMatch(block, /'(qualified|disqualified)',\s*\d/, 'the seed still ships a score');
  });

  test('no page or query reads a column that can never have a value', () => {
    // Scoped to the code a person writes. `src/lib/db/types.ts` is generated
    // from the live schema and correctly still describes the columns — they
    // exist, they are simply always null. Excluding it is not a loophole: the
    // constraint is what stops a *value*, and this stops a *surface*.
    const GENERATED = ['src/lib/db/types.ts'];
    const offenders: string[] = [];

    // Two passes, because the column appears in two different syntaxes and a
    // single pattern over the raw text cannot tell either of them from prose.
    // A first draft matched the bare word and failed on the security page,
    // which contains the sentence "Evidence, not a score" — a check that fires
    // on the documentation of a prohibition is one people learn to skip.
    //
    //   pass 1 — code with comments and string literals removed:
    //            `lead.score`, `score:`, `score_reasons` as identifiers.
    //   pass 2 — string literals only, and only where `score` stands as a
    //            whole token in a comma-separated select list or a
    //            `|`-separated type union. That is the shape a PostgREST
    //            `.select(...)` and a `Pick<Row, …>` both use, and it cannot
    //            match a word inside a sentence.
    const strip = (source: string) =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

    const literalsOf = (source: string) =>
      [...source.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)].map(
        (m) => m[1] ?? m[2] ?? m[3] ?? '',
      );

    const IDENTIFIER = /\bscore_reasons\b|\.score\b|(^|[^.\w'"`])score\s*:/m;
    const COLUMN_TOKEN = /(^|[,|]\s*)'?score(_reasons)?'?\s*([,|]|$)/;

    const walk = (dir: string) => {
      for (const entry of readdirSync(join(root, dir))) {
        const rel = `${dir}/${entry}`;
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        if (statSync(join(root, rel)).isDirectory()) {
          walk(rel);
          continue;
        }
        if (!/\.tsx?$/.test(entry) || GENERATED.includes(rel)) continue;

        const source = strip(read(rel));
        const code = source.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''");
        if (IDENTIFIER.test(code) || literalsOf(source).some((l) => COLUMN_TOKEN.test(l))) {
          offenders.push(rel);
        }
      }
    };
    walk('src');
    walk('app');

    assert.deepEqual(
      offenders,
      [],
      `these read or render a lead score, which ADM-88 declined: ${offenders.join(', ')}`,
    );
  });
});
