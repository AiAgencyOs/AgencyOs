import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

/**
 * How often is too often — gap G-216.
 *
 * Nothing in this system limited how often it messaged somebody: a grep for
 * `rate_limit`, `fatigue` and `cooldown` across `src/`, `app/` and every
 * migration returned nothing at all. That was survivable while the follow-up
 * engine could not deliver anything (G-213) and enrolment was one lead at a
 * time. It stops being survivable the moment templates are approved and
 * twelve hundred historical leads become reachable.
 *
 * The behaviour is proved against a real Postgres by `verify-outbound-window`
 * §11–§13. What is here is the shape of the rules, and the defaults, which no
 * live section can assert without a deployment that has never been configured.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const SQL = sqlCode(read('supabase/migrations/20260906140000_how_often_is_too_often.sql'));

/**
 * The same migration with its comments intact.
 *
 * `sqlCode` strips `--` lines, which is right for asserting behaviour and
 * wrong for asserting a defaults block whose values are only identifiable by
 * the comment beside each one.
 */
const SQL_RAW = read('supabase/migrations/20260906140000_how_often_is_too_often.sql');

describe('A. an unconfigured deployment cannot spam anybody', () => {
  /**
   * The property that makes this safe by default, and the opposite of how an
   * unset configuration usually behaves. Without it, every agency that never
   * opened the screen would have no limits at all — which is precisely the
   * agency most likely to run a campaign it does not understand.
   */
  test('a missing row is the conservative default, not the absence of a limit', () => {
    const fn = SQL_RAW.slice(
      SQL_RAW.indexOf('function crm.outreach_limits_for'),
      SQL_RAW.indexOf('comment on function crm.outreach_limits_for'),
    );
    assert.match(fn, /coalesce\(/);
    assert.match(fn, /1,\s*--\s*per_contact_per_day/);
    assert.match(fn, /3,\s*--\s*per_contact_per_week/);
    assert.match(fn, /3,\s*--\s*unanswered_before_cooldown/);
  });

  test('and the column defaults agree with them', () => {
    assert.match(SQL, /per_contact_per_day\s+int not null default 1\b/);
    assert.match(SQL, /per_contact_per_week\s+int not null default 3\b/);
    assert.match(SQL, /unanswered_before_cooldown int not null default 3\b/);
  });

  test('zero is a legitimate ceiling — an agency can pause itself', () => {
    assert.match(SQL, /per_organization_per_day int not null default 200 check \(per_organization_per_day between 0 and/);
  });
});

describe('B. a reply is not outreach', () => {
  /**
   * The line this whole gap rests on, and it is Meta's own: a contact who
   * wrote within 24 hours is in an open conversation, so what we send is an
   * ANSWER. Outside it, every message is business-initiated. Counting answers
   * would mean a client asking four questions in an afternoon got one reply.
   */
  test('only messages marked as outreach are counted', () => {
    const fn = SQL.slice(SQL.indexOf('function crm.outreach_allowance'), SQL.indexOf('comment on function crm.outreach_allowance'));
    assert.match(fn, /coalesce\(\(m\.metadata->>'outreach'\)::boolean, false\)/);
    assert.match(fn, /m\.author_type <> 'client'/);
  });

  test('and the mark is written at send time, where the window is still knowable', () => {
    const decision = codeOnly(read('src/modules/crm/outbound-window.ts'));
    assert.match(decision, /mark_message_as_outreach/);
    const handlers = codeOnly(read('src/modules/crm/handlers.ts'));
    assert.match(handlers, /gate\.send === 'template'[\s\S]{0,120}?markAsOutreach/);
  });

  test('a client’s own message can never be marked as outreach', () => {
    const fn = SQL.slice(SQL.indexOf('function crm.mark_message_as_outreach'), SQL.length);
    assert.match(fn, /and m\.author_type <> 'client'/);
  });

  test('and one tenant cannot spend another’s allowance', () => {
    const fn = SQL.slice(SQL.indexOf('function crm.mark_message_as_outreach'), SQL.length);
    assert.match(fn, /m\.organization_id = \(select core\.current_organization_id\(\)\)/);
  });
});

describe('C. counted per person, not per thread', () => {
  test('the allowance resolves the counterpart number, as the window does', () => {
    const fn = SQL.slice(SQL.indexOf('function crm.outreach_allowance'), SQL.indexOf('comment on function crm.outreach_allowance'));
    assert.match(fn, /crm\.conversation_counterpart_digits/);
    // Two threads with one person are still one person; a limit that counted
    // threads is one somebody walks around by accident.
    assert.match(fn, /peer\.organization_id = v_org/);
  });

  test('a group has no counterpart, so these limits do not apply to it', () => {
    const fn = SQL.slice(SQL.indexOf('function crm.outreach_allowance'), SQL.indexOf('comment on function crm.outreach_allowance'));
    assert.match(fn, /if v_digits is null then\s*\n\s*return 'ok';/);
  });
});

describe('D. fatigue is not a rate', () => {
  test('it counts since their last message of any kind, so a reply clears it', () => {
    const fn = SQL.slice(SQL.indexOf('function crm.outreach_allowance'), SQL.indexOf('comment on function crm.outreach_allowance'));
    assert.match(fn, /o\.occurred_at > coalesce\(\(select last_at from inbound\), '-infinity'::timestamptz\)/);
  });

  test('and the cooldown runs from the NEWEST unanswered attempt', () => {
    // From the first, a long slow campaign would exit its own cooldown while
    // still adding to the pile.
    const fn = SQL.slice(SQL.indexOf('function crm.outreach_allowance'), SQL.indexOf('comment on function crm.outreach_allowance'));
    assert.match(fn, /select max\(o\.occurred_at\)/);
  });
});

describe('E. a held send waits for whatever will clear it', () => {
  const decision = read('src/modules/crm/outbound-window.ts');

  test('a rate names when it clears; a window does not, because only a person clears it', () => {
    assert.match(decision, /per_contact_per_day: \(\) => new Date\(Date\.now\(\) \+ 24 \* 3_600_000\)/);
    assert.match(decision, /per_contact_per_week: \(\) => new Date\(Date\.now\(\) \+ 7 \* 24 \* 3_600_000\)/);
  });

  /**
   * The absence, with its twin above. A cooldown is measured in days and the
   * client's own reply is the thing that should end it — giving it a clock
   * would resume outreach at the first legal instant against somebody who has
   * said nothing for a month.
   */
  test('a cooldown gets no clock at all', () => {
    const clears = decision.slice(
      decision.indexOf('const LIMIT_CLEARS_AT'),
      decision.indexOf('export async function outreachAllowance'),
    );
    assert.doesNotMatch(clears, /cooldown:/);
  });

  test('every refusal has words an operator can act on', () => {
    const reasons = decision.slice(
      decision.indexOf('const LIMIT_REASONS'),
      decision.indexOf('const LIMIT_CLEARS_AT'),
    );
    for (const rule of [
      'per_contact_per_day',
      'per_contact_per_week',
      'per_organization_per_day',
      'cooldown',
    ]) {
      assert.match(reasons, new RegExp(`${rule}:`), `${rule} refuses without saying why`);
    }
  });

  test('an unreadable limit retries rather than sending anyway', () => {
    // The dangerous direction is the other one: treating a failed read as
    // "no limit" would remove every brake during a database blip.
    assert.match(decision, /allowance === 'unreadable'[\s\S]{0,160}?mode: 'retry'/);
  });
});
