import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * Two granted decisions the record had never linked.
 *
 * ADM-11: follow-ups are *"drafted and SENT AUTOMATICALLY, with nobody reading
 * them first, including messages that may carry a price, discount or delivery
 * promise"* — and it names the risk itself: *"the only path in AgencyOS where
 * something reaches a client unread."*
 *
 * ADM-22: *"It must never state a price, and there is no list for it to state
 * one from."*
 *
 * They do not conflict. ADM-11 grants automatic *sending* and records the risk
 * the owner accepted; it grants no pricing, which ADM-22 forbids at every
 * level. Nothing enforced the second half: `send_outbound_message` takes
 * `p_body text` and screens it for nothing.
 *
 * Behaviour is proved against real Postgres in
 * `scripts/verify-unread-price.mjs` — a trigger over a regex is exactly the
 * thing that reads correct and behaves otherwise. These pin the decisions the
 * migration makes.
 */

const migration = readdirSync(fileURLToPath(new URL('../supabase/migrations', import.meta.url)))
  .filter((f) => f.includes('a_message_nobody_read_may_not_name_a_price'))
  .map((f) => readFileSync(fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url)), 'utf8'))
  .join('\n');

describe('A. the rule binds the row, not one writer', () => {
  test('it is a trigger, not an edit to send_outbound_message', () => {
    // That function has been redefined five times. Re-emitting it to add one
    // rule is how a branch gets silently dropped — this repository has done
    // exactly that once. A row rule also binds every path that writes the row.
    assert.match(migration, /create trigger refuse_unread_price/);
    assert.ok(
      !/create or replace function crm\.send_outbound_message/.test(migration),
      'the migration re-emits the send function',
    );
  });

  test('it fires on UPDATE of the body as well as INSERT', () => {
    // Otherwise a price is edited in after the row is accepted.
    assert.match(migration, /before insert or update of body/);
  });
});

describe('B. only the unread path is bound', () => {
  test('the rule is author_type user with no author id', () => {
    assert.match(migration, /new\.author_type = 'user' and new\.author_id is null/);
  });

  test('and the exemption is stated as ADM-22 asks for it', () => {
    // A human quoting a price per client is the thing ADM-22 says should
    // happen. The exemption is that, not a loophole.
    assert.match(migration, /every price quoted per client, by a person/);
  });
});

describe('C. the matcher, and what it admits it does not do', () => {
  test('word boundaries are \\y — \\b is a backspace in Postgres', () => {
    // Three of five patterns matched nothing in the first draft because of
    // this, and every one of them read correct.
    assert.ok(!/~\*\s*'[^']*\\b/.test(migration), 'a pattern still uses \\b as a word boundary');
    assert.match(migration, /\\y/);
  });

  test('a bare percentage is not a discount', () => {
    // "50% complete" is an honest sentence. Blocking it would teach whoever
    // hits it to route around the guard.
    assert.match(migration, /\[0-9\]\+\\s\*%\\s\*\(off\|discount\|less\)/);
    assert.match(migration, /50% complete/);
  });

  test('the money-only limit is written down rather than implied', () => {
    // ADM-11 also names a delivery promise. A matcher for a promise is a
    // matcher for intent, and writing one would invent a rule nobody decided.
    assert.match(migration, /what this deliberately does NOT catch/i);
    assert.match(migration, /matcher for a promise is a matcher for intent/);
  });

  test('and so is the weaker half of the exemption', () => {
    // author_id has no foreign key, so the rule keys on presence rather than
    // on identity. Sound for the paths that exist; written down for the day
    // something else writes this table.
    assert.match(migration, /carries no foreign key/);
    assert.match(migration, /presence is a weaker claim than\n-- identity/);
  });
});

describe('D. it is checked where it will actually run', () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { scripts: Record<string, string> };
  const workflow = readFileSync(
    fileURLToPath(new URL('../.github/workflows/verify.yml', import.meta.url)),
    'utf8',
  );

  test('package.json exposes the live script', () => {
    assert.match(pkg.scripts['db:verify:unreadprice'] ?? '', /verify-unread-price\.mjs/);
  });

  test('and CI runs it against a real database', () => {
    assert.match(workflow, /npm run db:verify:unreadprice/);
  });
});
