import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { parseDelivery } from '../src/lib/whatsapp/payload.ts';

/**
 * Inbound group messages — gap G-115.
 *
 * `crm.ingest_whatsapp_message` resolves an organization from the phone number
 * id and then unconditionally creates a contact, a lead and a `direct`
 * conversation. It has no notion of `kind`, because when it was written every
 * conversation was a 1:1 thread.
 *
 * G-109 added groups as an outbound channel. Nothing had ever routed an
 * inbound group message, so nothing had broken — but the moment a webhook did,
 * **every message in a project or internal group would have become a lead for
 * whoever sent it**. A colleague typing "morning" in the approval group would
 * open a sales lead on themselves.
 *
 * The database half is proved against a real Postgres by
 * `scripts/verify-group-ingest.mjs`. What is here is the parser, the routing
 * decision, and the assertions that would notice the routing being removed.
 */

const migration = readFileSync(
  fileURLToPath(
    new URL('../supabase/migrations/20260813120023_a_message_in_a_group.sql', import.meta.url),
  ),
  'utf8',
);

const route = readFileSync(
  fileURLToPath(new URL('../app/api/webhooks/whatsapp/route.ts', import.meta.url)),
  'utf8',
);

/** Meta's envelope, reduced to what parseDelivery reads. */
function delivery(message: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-555' },
              contacts: [{ wa_id: '919000000000', profile: { name: 'Priya' } }],
              messages: [
                {
                  from: '919000000000',
                  id: 'wamid.1',
                  type: 'text',
                  text: { body: 'morning all' },
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('A. the parser tells the two apart', () => {
  test('a 1:1 message carries no group id', () => {
    const { messages } = parseDelivery(delivery({}));
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.groupId, undefined);
  });

  test('a group message carries the one Meta sent', () => {
    const { messages } = parseDelivery(delivery({ group_id: 'capi_group:ABC' }));
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.groupId, 'capi_group:ABC');
  });

  test('`from` still names the individual, not the group', () => {
    // Meta's documentation is explicit: in a group delivery the `from` field
    // and the contact object both point at the participant who sent it. That
    // is what makes attribution possible later without being guessed now.
    const { messages } = parseDelivery(delivery({ group_id: 'capi_group:ABC' }));
    assert.equal(messages[0]!.from, '919000000000');
    assert.equal(messages[0]!.profileName, 'Priya');
  });

  test('one delivery can carry both kinds, and each keeps its own answer', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'pn-555' },
                messages: [
                  { from: '919000000000', id: 'wamid.a', type: 'text', text: { body: 'direct' } },
                  {
                    from: '919000000001',
                    id: 'wamid.b',
                    type: 'text',
                    text: { body: 'in a group' },
                    group_id: 'capi_group:ABC',
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const { messages } = parseDelivery(payload);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.groupId, undefined);
    assert.equal(messages[1]!.groupId, 'capi_group:ABC');
  });

  test('a non-string group id is ignored rather than trusted', () => {
    const { messages } = parseDelivery(delivery({ group_id: { nested: true } }));
    assert.equal(messages[0]!.groupId, undefined);
  });
});

describe('B. the routing decision', () => {
  test('the webhook sends a group message to the group ingest', () => {
    // The one branch standing between the parser knowing about group_id and a
    // colleague becoming a sales lead.
    assert.match(route, /message\.groupId\s*\n?\s*\?\s*await ingestGroupMessage/);
    assert.match(route, /:\s*await ingestInboundMessage\(admin, message\)/);
  });

  test('and an untracked group is skipped, not counted as ingested', () => {
    assert.match(route, /status === 'unknown_group'/);
    assert.match(route, /skipped \+= 1/);
  });
});

describe('C. the rules the database holds', () => {
  const sql = migration
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/comment on [\s\S]*?';/gi, '');

  test('the stripped SQL is still the migration — the checks below are not vacuous', () => {
    assert.match(sql, /function crm\.ingest_group_message/);
    assert.ok(sql.length > migration.length / 4, 'the strip removed most of the file');
  });

  test('it creates no lead and no contact — the whole point', () => {
    assert.ok(!/insert into crm\.leads/i.test(sql), 'the group path creates a lead');
    assert.ok(!/insert into crm\.contacts/i.test(sql), 'the group path creates a contact');
  });

  test('it queues no extraction either', () => {
    // Requirements are extracted from a client's 1:1 thread. Running an
    // extraction over internal chatter would put the agency's own words into a
    // requirement version.
    assert.ok(!/insert into core\.jobs/i.test(sql), 'the group path queues a job');
  });

  test('only a group conversation can receive one', () => {
    assert.match(sql, /kind in \('project_group', 'internal_group'\)/);
  });

  test('the tenant is restated, not trusted to the group id alone', () => {
    assert.match(sql, /c\.organization_id = v_org/);
  });

  test('the position is allocated under the conversation’s lock', () => {
    assert.match(sql, /from crm\.conversations c where c\.id = v_conversation\.id for update/);
    // And from -1, so the first message in a group is seq 0 like every other
    // thread. The same base a rewrite of send_outbound_message got wrong.
    assert.match(sql, /coalesce\(max\(m\.seq\), -1\) \+ 1/);
  });

  test('redelivery is free', () => {
    assert.match(sql, /'replayed'/);
  });

  test('an untracked group is a status, not an exception', () => {
    assert.match(sql, /'unknown_group'/);
    assert.ok(!/raise exception/i.test(sql), 'an untracked group raises');
  });

  test('the sender is kept for attribution, and attributed to nobody', () => {
    assert.match(sql, /'from', v_phone/);
    // author_id stays null: users have no phone column to match against, which
    // is the same fact behind ADM-74, and guessing a contact would put words
    // in a named client's mouth (G-116).
    assert.match(sql, /v_author, null,/);
  });
});
