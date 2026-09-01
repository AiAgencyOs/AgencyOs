import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

/**
 * A group message can carry a file — G-181.
 *
 * A zero-trust audit read the inbound webhook line by line and found this:
 *
 *     if (message.groupId && message.mediaType) { skipped += 1; continue; }
 *
 * A photograph, a voice note or a PDF posted into a project group was
 * **counted as somebody else's traffic and thrown away**.
 *
 * The comment beside it was honest about the trade — *"crm.ingest_group_message
 * takes no media kind, and widening it is a separate change"* — and named the
 * loss it was accepting: an internal group losing a sticker is not the same as
 * a client's voice note going unanswered on their lead thread.
 *
 * That was right about the priority and wrong about the outcome. The project
 * group **is** the client-facing thread once a project starts (G-015,
 * ADM-13), so the file a client posts there — the screenshot of the bug, the
 * logo, the signed document — is exactly the kind of thing an agency is later
 * accused of never having received. Counting it as `skipped` made it
 * indistinguishable from a message for a number nobody claims.
 *
 * ── what it does NOT do, and why that is not an omission ──────────────────
 *
 * It stores the envelope. It queues no reading. `image.received` and
 * `audio.received` exist so a client's file is understood before the agent
 * answers it on a LEAD thread — and nothing answers a group thread
 * automatically: `crm.emit_reply_due` fires on a client message in a DIRECT
 * conversation, and a group message is not that. A model call whose output
 * nothing reads is cost with no consumer, which is the shape G-011 exists to
 * refuse.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260901150000_a_group_message_can_carry_a_file.sql');
const ROUTE = read('app/api/webhooks/whatsapp/route.ts');
const INGEST = read('src/modules/crm/ingest.ts');

describe('A. the webhook stops throwing it away', () => {
  test('the branch that dropped a group file is gone', () => {
    const code = codeOnly(ROUTE);
    assert.ok(
      !/message\.groupId && message\.mediaType/.test(code),
      'the webhook still refuses a group message that carries a file',
    );
  });

  test('and the group path is still the one that keeps a colleague out of the funnel', () => {
    // G-115's rule, untouched: `ingestInboundMessage` opens a LEAD on whoever
    // sent the message, so a colleague typing in the internal approval group
    // would become a prospect. The branch that routes a group elsewhere is the
    // only thing standing between the parser knowing about `group_id` and that
    // happening, and this change must not have widened it.
    assert.match(ROUTE, /message\.groupId\s*\n?\s*\? await ingestGroupMessage/);
  });

  test('the docblock no longer says a reply does not exist', () => {
    // It said "a reply is a later, human-gated step that does not exist yet",
    // which stopped being true at ADM-91. The route was right the whole time;
    // the comment was a trap for the next reader.
    assert.ok(!ROUTE.includes('a reply is a later, human-gated step that does not exist yet'));
    assert.match(ROUTE, /stopped being true at ADM-91/);
    // And what IS still true is stated, rather than the sentence just deleted.
    assert.match(ROUTE, /nothing is SENT from here/);
  });

  test('the ingest passes the envelope through, the way the 1:1 path does', () => {
    assert.match(INGEST, /p_media_type: parsed\.data\.mediaType/);
    assert.match(INGEST, /p_media_id: parsed\.data\.mediaId/);
    assert.match(INGEST, /p_caption: parsed\.data\.caption/);
  });
});

describe('B. the function keeps everything it already guaranteed', () => {
  const sql = sqlCode(MIGRATION);

  test('dropped and recreated, never overloaded', () => {
    // The trap G-178 hit one function along: a different argument list makes a
    // second function, and the six-argument call is then ambiguous — a runtime
    // error on the next group message rather than a failure at apply time.
    assert.match(
      sql,
      /drop function if exists crm\.ingest_group_message\(text, text, text, text, text, timestamptz\);/,
    );
    const dropped = sql.indexOf('drop function if exists crm.ingest_group_message');
    const created = sql.indexOf('create function crm.ingest_group_message');
    assert.ok(dropped > 0 && created > dropped);
  });

  test('the new parameters are appended with null defaults', () => {
    assert.match(sql, /p_media_type text default null,\s*\n\s*p_media_id text default null,\s*\n\s*p_caption text default null/);
  });

  test('every refusal and every lock it had is still there', () => {
    // A rewrite that quietly dropped one of these would be a regression
    // disguised as an addition.
    assert.match(sql, /'unknown_phone_number_id'::text/);
    assert.match(sql, /'unknown_group'::text/);
    assert.match(sql, /'replayed'::text/);
    assert.match(sql, /for update;/);
    assert.match(sql, /on conflict \(organization_id, external_ref\) where external_ref is not null/);
    // And the rule about who a group message is from — a group cannot be
    // narrowed to a person without an identity link that does not exist.
    assert.match(sql, /case when v_conversation\.kind = 'internal_group' then 'user' else 'client' end/);
  });

  test('a text message’s metadata is byte-for-byte what it was', () => {
    // Each key is merged only when it has a value. Without that, every text
    // message in every group would acquire three null keys, and a test
    // comparing metadata across the change would be comparing two shapes.
    assert.match(sql, /when p_media_type is null then '\{\}'::jsonb/);
    assert.match(sql, /when coalesce\(btrim\(p_media_id\), ''\) = '' then '\{\}'::jsonb/);
    assert.match(sql, /when coalesce\(btrim\(p_caption\), ''\) = '' then '\{\}'::jsonb/);
  });

  test('and it queues no reading, deliberately', () => {
    // Nothing answers a group thread automatically, so a model call here would
    // have no consumer. The comment says so where the next person will look.
    assert.ok(
      !/emit_media_received|image\.received|audio\.received/.test(sql),
      'a group file must not queue a reading nothing will read',
    );
    assert.match(MIGRATION, /cost with no consumer/);
  });
});
