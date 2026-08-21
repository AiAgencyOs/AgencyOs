import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const migration = readdirSync(join(root, 'supabase/migrations'))
  .filter((f) => f.includes('the_events_the_documents_name'))
  .map((f) => read(`supabase/migrations/${f}`))
  .join('\n');

/**
 * The events the documents name.
 *
 * `core.emit_event` now refuses a type not declared in `core.event_types`, and
 * that refusal is only safe if the declaration is COMPLETE. The first draft of
 * this list was typed by hand from the SQL migrations, and it missed
 * `followup.queued` — emitted from TypeScript, through PostgREST, by
 * `src/modules/crm/follow-up-worker.ts`. Three verification scripts went red.
 *
 * So the list is checked against the repository rather than trusted: every
 * literal any emitter passes as a type, in SQL or in TypeScript, must be
 * declared. This is the test that should have been written before the refusal.
 */
describe('Doc 23 — the emitted set is closed, so it had better be complete', () => {
  const declared = new Set(
    [...migration.matchAll(/^\s*\('([a-z_]+\.[a-z_]+)',/gm)].map((m) => m[1]),
  );

  test('the catalogue exists and the refusal lives in emit_event', () => {
    assert.ok(migration, 'the migration is missing');
    assert.ok(declared.size >= 16, `only ${declared.size} types declared`);
    // In the function rather than as a row trigger, and the migration says
    // why: every emitter goes through emit_event, while the paths a row
    // trigger would additionally catch are verification fixtures writing
    // marker types that cannot collide with a real one.
    assert.match(migration, /create or replace function core\.emit_event/);
    assert.doesNotMatch(migration, /create trigger refuse_undeclared_event/);
  });

  test('EVERY type any SQL emitter passes is declared', () => {
    const undeclared: string[] = [];
    for (const file of readdirSync(join(root, 'supabase/migrations'))) {
      if (!file.endsWith('.sql')) continue;
      const sql = read(`supabase/migrations/${file}`)
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('--'))
        .join('\n');
      // Multi-line aware: the calls wrap, and a line-based match found none.
      for (const call of sql.matchAll(/emit_event\s*\(([\s\S]{0,300}?)\)/g)) {
        for (const lit of (call[1] ?? '').matchAll(/'([a-z_]+\.[a-z_]+)'/g)) {
          if (!declared.has(lit[1])) undeclared.push(`${file}: ${lit[1]}`);
        }
      }
    }
    assert.deepEqual(undeclared, [], `emitted and undeclared: ${undeclared.join(', ')}`);
  });

  test('and every type any TYPESCRIPT emitter passes is declared', () => {
    // The half that was missing. `follow-up-worker.ts` reaches emit_event
    // through PostgREST, so no amount of reading the migrations finds it.
    const undeclared: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(root, dir))) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const rel = `${dir}/${entry}`;
        if (statSync(join(root, rel)).isDirectory()) {
          walk(rel);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        for (const lit of read(rel).matchAll(/p_type:\s*'([a-z_]+\.[a-z_]+)'/g)) {
          if (!declared.has(lit[1])) undeclared.push(`${rel}: ${lit[1]}`);
        }
      }
    };
    walk('src');
    walk('app');
    assert.deepEqual(undeclared, [], `emitted and undeclared: ${undeclared.join(', ')}`);
  });

  test('a type BUILT at runtime is named here, because no scan can find it', () => {
    // `sales.record_proposal_response` emits `'proposal.' || p_response`.
    // There is no literal anywhere for the previous test — or for a person
    // reading the migrations — to find, and it went undetected until the whole
    // verification chain was replayed and `db:verify:quotations` went red.
    //
    // So the constructed emitters are enumerated by hand, and the check is
    // that the hand-written list still matches what the SQL does. A check that
    // cannot see something must say so rather than imply coverage.
    const CONSTRUCTED: Record<string, readonly string[]> = {
      // prefix           values the emitter can produce
      'proposal.': ['proposal.accepted', 'proposal.rejected'],
    };

    const found: string[] = [];
    for (const file of readdirSync(join(root, 'supabase/migrations'))) {
      if (!file.endsWith('.sql')) continue;
      const sql = read(`supabase/migrations/${file}`)
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('--'))
        .join('\n');
      for (const m of sql.matchAll(/emit_event\s*\([\s\S]{0,120}?'([a-z_]+\.)'\s*\|\|/g)) {
        found.push(m[1] ?? '');
      }
    }

    // Every constructed prefix the SQL actually uses is one this test knows
    // about. A new one appearing here fails rather than passing silently,
    // which is the whole reason the list is written down.
    for (const prefix of new Set(found)) {
      assert.ok(CONSTRUCTED[prefix], `emit_event builds "${prefix}…" at runtime and this test does not know its values`);
    }
    assert.ok(found.length > 0, 'the constructed-emitter scan found nothing — the parser drifted');

    // And every value they can produce is declared.
    for (const values of Object.values(CONSTRUCTED)) {
      for (const type of values) {
        assert.ok(declared.has(type), `${type} can be emitted at runtime and is not declared`);
      }
    }
  });

  test('and every type the dispatcher subscribes to is declared', () => {
    // A subscription to a type nothing may emit is a handler that can never
    // run — the mirror image of the defect above, and just as quiet.
    const catalog = read('src/lib/events/catalog.ts');
    const subscribed = [
      ...catalog
        .slice(catalog.indexOf('export const SUBSCRIPTIONS'))
        .matchAll(/'([a-z_]+\.[a-z_]+)':/g),
    ].map((m) => m[1]);
    assert.ok(subscribed.length > 0, 'no subscriptions were found — the parser drifted');
    for (const type of subscribed) {
      assert.ok(declared.has(type), `${type} is subscribed to and cannot be emitted`);
    }
  });

  test('Doc 23 §7 is listed in full, and what is unmapped says so', () => {
    const canonical = [...migration.matchAll(/^\s*\('([A-Z][A-Za-z]+)', \d+, (null|'[a-z_.]+')\)/gm)];
    assert.equal(canonical.length, 26, `Doc 23 §7 names 26 events, ${canonical.length} are listed`);
    const mapped = canonical.filter((m) => m[2] !== 'null');
    assert.equal(mapped.length, 6);
    // Every mapping points at a type that exists. A canonical event mapped to
    // a type nothing emits is worse than an unmapped one: it reports coverage
    // this system does not have.
    for (const m of mapped) {
      const type = (m[2] ?? '').slice(1, -1);
      assert.ok(declared.has(type), `${m[1]} maps to ${m[2]}, which is not declared`);
    }
  });

  test('no mapping was invented to make the number look better', () => {
    // §7 names business milestones; the repository names row states. Nine of
    // the ten pre-existing types map to nothing in §7, and calling
    // `proposal.sent` a `QuoteCreated` would make the coverage number a
    // statement about optimism rather than about the system.
    for (const legacy of ['lead.returned', 'proposal.sent', 'proposal.lapsed', 'invoice.created',
                          'invoice.issued', 'invoice.paid', 'invoice.voided', 'payment.recorded',
                          'approval.requested', 'followup.queued']) {
      // Matched to end of LINE, not to the first `)`. A first draft used
      // `[^)]*\)` and stopped inside "(ADM-05)." in the description — a regex
      // that finds a shorter thing than it means to, which is how a check
      // reports a defect that is not there.
      const row = migration
        .split('\n')
        .find((l) => l.trimStart().startsWith(`('${legacy}',`));
      assert.ok(row, `${legacy} is not declared`);
      assert.match(row, /,\s*null\)?,?\s*$/, `${legacy} was given a canonical name it does not have`);
    }
  });
});
