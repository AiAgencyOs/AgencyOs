import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

import { parseDelivery } from '../src/lib/whatsapp/payload.ts';

/**
 * Which advertisement brought them — G-204 (Doc 09 §3 and §4, audit LC-A).
 *
 * §3 asks for campaign and ad metadata and the landing or source URL "where
 * available"; §4 lists campaign information among a lead's minimum fields.
 * Neither had a column, and `crm.leads.source` said `whatsapp` for every lead
 * that ever arrived.
 *
 * For an agency whose leads come from Facebook advertising, that is the
 * difference between knowing WhatsApp brought them and knowing **which
 * advertisement did** — the difference between a marketing budget with a
 * feedback loop and one without.
 *
 * ── and the data was already arriving ─────────────────────────────────────
 *
 * A Click-to-WhatsApp advertisement delivers a `referral` block on the first
 * message. `parseDelivery` dropped all of it. Nothing here is inferred or
 * asked of a model: it is Meta's own field, carried the last few inches it
 * was never carried.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = sqlCode(read('supabase/migrations/20260904180000_which_advertisement_brought_them.sql'));
const INGEST = codeOnly(read('src/modules/crm/ingest.ts'));

const delivery = (message: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA',
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: '123456' },
            contacts: [{ wa_id: '919812345678', profile: { name: 'A Client' } }],
            messages: [{ from: '919812345678', id: 'wamid.1', type: 'text', text: { body: 'hi' }, ...message }],
          },
        },
      ],
    },
  ],
});

describe('A. the block Meta sends, read at the door', () => {
  test('an ad click carries its type, its id, its URL and its headline', () => {
    const { messages } = parseDelivery(
      delivery({
        referral: {
          source_type: 'ad',
          source_id: '1200945',
          source_url: 'https://fb.me/2xYz',
          headline: 'Get an app for your tiffin service',
          ctwa_clid: 'ARxxxxxxxx',
        },
      }),
    );
    assert.deepEqual(messages[0]?.referral, {
      sourceType: 'ad',
      sourceId: '1200945',
      sourceUrl: 'https://fb.me/2xYz',
      headline: 'Get an app for your tiffin service',
    });
  });

  test('the click identifier is deliberately NOT read', () => {
    // It answers no question this agency has asked, and storing an identifier
    // because it arrived is how a CRM accumulates data nobody can name the
    // purpose of.
    const { messages } = parseDelivery(
      delivery({ referral: { source_type: 'ad', source_id: '1', ctwa_clid: 'ARzzz' } }),
    );
    assert.ok(!JSON.stringify(messages[0]?.referral).includes('ARzzz'));
    assert.ok(!read('src/lib/whatsapp/payload.ts').includes('ctwa_clid:'));
  });

  test('an unrecognised source type is dropped rather than coerced', () => {
    // 'ad' and 'post' are Meta's own two; a third would be a guess about a
    // field that changed.
    const { messages } = parseDelivery(
      delivery({ referral: { source_type: 'reel_of_the_future', source_id: '9' } }),
    );
    assert.equal(messages[0]?.referral, undefined);
  });

  test('and a source id with no type is not half a record', () => {
    const { messages } = parseDelivery(delivery({ referral: { source_url: 'https://fb.me/x' } }));
    assert.equal(messages[0]?.referral, undefined);
  });

  test('an ordinary message carries none of it, and is unchanged', () => {
    const { messages } = parseDelivery(delivery({}));
    assert.equal(messages[0]?.referral, undefined);
    assert.equal(messages[0]?.body, 'hi');
  });
});

describe('B. first touch, and the row is what enforces it', () => {
  test('two controls hold it, and a red-proof settled which is which', () => {
    /**
     * Both are enough on their own. Removing the filter changed nothing
     * observable — the trigger refuses the overwrite and the failure is
     * logged rather than fatal — and removing both together is what puts the
     * second advertisement in place of the first.
     *
     * So the filter is the cheap half (no pointless write on a webhook that
     * runs concurrently with itself) and the database owns the rule. Both are
     * pinned, because a reader who assumed the filter was the guard could
     * remove the trigger and leave it.
     */
    assert.match(INGEST, /\.is\('campaign_source_id', null\)/);
    assert.match(MIGRATION, /which advertisement brought this lead is a record of what happened, and does not change/);
    assert.match(read('src/modules/crm/ingest.ts'), /this is not the control; it is the cheap half/);
  });

  test('a source id must say whether it was an ad or a post', () => {
    assert.match(MIGRATION, /a campaign source must say whether it was an ad or a post/);
  });

  test('failing to record a campaign never undoes a recorded message', () => {
    // Losing the attribution costs a report; losing the message costs a client.
    assert.match(INGEST, /scope: 'ingestInboundMessage\.campaign'/);
    const ingestProse = read('src/modules/crm/ingest.ts');
    assert.match(ingestProse, /Losing the attribution costs a report;\n {3}\* losing the message costs a client/);
  });

  test('it is written beside the ingest, not inside it, and the reason is recorded', () => {
    // Widening a 244-line function's signature for a fact about the LEAD is
    // the overload trap G-178 hit.
    assert.match(read('src/modules/crm/ingest.ts'), /overload trap G-178 hit/);
  });
});

describe('C. what the column can hold', () => {
  test('the two source types, and no third', () => {
    assert.match(MIGRATION, /campaign_source_type in \('ad', 'post'\)/);
  });

  test('the URL is bounded at a URL’s length, not a sentence’s', () => {
    assert.match(MIGRATION, /campaign_source_url[\s\S]{0,120}?between 1 and 2000/);
  });

  test('and there is an index for the question it exists to answer', () => {
    // "Which advertisement brought them" is a group-by, not a scan.
    assert.match(MIGRATION, /create index if not exists leads_campaign_idx[\s\S]{0,160}?where campaign_source_id is not null/);
  });
});
