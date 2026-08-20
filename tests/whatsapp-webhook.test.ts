import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { parseDelivery } from '../src/lib/whatsapp/payload.ts';
import {
  authorizeSignature,
  authorizeSubscription,
  SIGNATURE_HEADER,
  WEBHOOK_DISABLED,
  WEBHOOK_FORBIDDEN,
  WEBHOOK_UNAUTHORIZED,
} from '../src/lib/whatsapp/verify.ts';

/**
 * The inbound WhatsApp webhook.
 *
 * Both decisions the route makes — is this Meta, and what did it send — are
 * pure and are exercised here directly, the way src/lib/cron-auth.ts is. What
 * remains in route.ts is the wiring between them and the ingest, which is
 * asserted as source below and driven over real HTTP by
 * scripts/verify-whatsapp-webhook.mjs (`npm run db:verify:webhook`).
 */

const routeSource = readFileSync(
  fileURLToPath(new URL('../app/api/webhooks/whatsapp/route.ts', import.meta.url)),
  'utf8',
);

const SECRET = 'test-app-secret-0123456789';
const TOKEN = 'test-verify-token-0123456789';

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

const query = (params: Record<string, string>) => new URLSearchParams(params);

/** A delivery carrying one inbound text message. */
const delivery = (overrides: Record<string, unknown> = {}) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA_1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550001111', phone_number_id: 'PN_1' },
            contacts: [{ profile: { name: 'Asha' }, wa_id: '919900112233' }],
            messages: [
              {
                from: '919900112233',
                id: 'wamid.AAA',
                timestamp: '1786000000',
                type: 'text',
                text: { body: 'I need a storefront rebuild' },
              },
            ],
            ...overrides,
          },
        },
      ],
    },
  ],
});

// ═══════════════════════════════════════════════════════════════════════════
// 1 + 2. The subscription handshake
// ═══════════════════════════════════════════════════════════════════════════

describe('1. a valid GET verification', () => {
  test('returns the challenge when mode and token both match', () => {
    const auth = authorizeSubscription(
      query({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1158201444' }),
      TOKEN,
    );
    assert.equal(auth.ok, true);
    assert.equal(auth.challenge, '1158201444');
  });

  test('the challenge is echoed verbatim — Meta compares the body exactly', () => {
    const odd = '  0042-challenge  ';
    const auth = authorizeSubscription(
      query({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': odd }),
      TOKEN,
    );
    assert.equal(auth.ok, true);
    assert.equal(auth.challenge, odd, 'the challenge must not be trimmed or reformatted');
  });
});

describe('2. an invalid verification token', () => {
  test('is forbidden, and returns no challenge', () => {
    const auth = authorizeSubscription(
      query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'c' }),
      TOKEN,
    );
    assert.equal(auth.ok, false);
    if (auth.ok) return;
    assert.equal(auth.status, 403);
    assert.equal(auth.error, WEBHOOK_FORBIDDEN);
    assert.equal(auth.challenge, undefined);
  });

  test('a token that is a prefix of the real one is refused', () => {
    const auth = authorizeSubscription(
      query({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN.slice(0, -1), 'hub.challenge': 'c' }),
      TOKEN,
    );
    assert.equal(auth.ok, false);
  });

  test('an absent token is refused', () => {
    const auth = authorizeSubscription(
      query({ 'hub.mode': 'subscribe', 'hub.challenge': 'c' }),
      TOKEN,
    );
    assert.equal(auth.ok, false);
  });

  test('the right token under an unimplemented mode is refused, not guessed at', () => {
    const auth = authorizeSubscription(
      query({ 'hub.mode': 'unsubscribe', 'hub.verify_token': TOKEN, 'hub.challenge': 'c' }),
      TOKEN,
    );
    assert.equal(auth.ok, false);
    if (auth.ok) return;
    assert.equal(auth.status, 403);
  });

  test('with no token configured the webhook is disabled, not open', () => {
    const auth = authorizeSubscription(
      query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'anything', 'hub.challenge': 'c' }),
      undefined,
    );
    assert.equal(auth.ok, false);
    if (auth.ok) return;
    assert.equal(auth.status, 503);
    assert.equal(auth.error, WEBHOOK_DISABLED);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 + 4. The delivery signature
// ═══════════════════════════════════════════════════════════════════════════

describe('3. a valid POST signature', () => {
  test('is accepted', () => {
    const body = JSON.stringify(delivery());
    assert.equal(authorizeSignature(body, sign(body), SECRET).ok, true);
  });

  test('is computed over the raw body, not a re-serialisation of it', () => {
    // Same object, different byte sequence. Only the bytes actually received
    // can produce the digest Meta sent.
    const received = '{"object":"whatsapp_business_account","entry":[]}';
    const reserialised = JSON.stringify(JSON.parse(received) as unknown, null, 2);

    assert.equal(authorizeSignature(received, sign(received), SECRET).ok, true);
    assert.equal(authorizeSignature(reserialised, sign(received), SECRET).ok, false);
  });

  test('an empty body still signs and verifies', () => {
    assert.equal(authorizeSignature('', sign(''), SECRET).ok, true);
  });
});

describe('4. an invalid POST signature', () => {
  const body = JSON.stringify(delivery());

  test('a wrong digest is unauthorized', () => {
    const auth = authorizeSignature(body, `sha256=${'0'.repeat(64)}`, SECRET);
    assert.equal(auth.ok, false);
    if (auth.ok) return;
    assert.equal(auth.status, 401);
    assert.equal(auth.error, WEBHOOK_UNAUTHORIZED);
  });

  test('a signature from the wrong secret is refused', () => {
    assert.equal(authorizeSignature(body, sign(body, 'another-secret-000000'), SECRET).ok, false);
  });

  test('a tampered body is refused even with a once-valid signature', () => {
    const signature = sign(body);
    const tampered = body.replace('storefront rebuild', 'free work forever');
    assert.notEqual(tampered, body);
    assert.equal(authorizeSignature(tampered, signature, SECRET).ok, false);
  });

  test('a missing header is refused', () => {
    assert.equal(authorizeSignature(body, null, SECRET).ok, false);
  });

  test('a bare hex digest with no scheme is refused', () => {
    const bare = sign(body).slice('sha256='.length);
    assert.equal(authorizeSignature(body, bare, SECRET).ok, false);
  });

  test('the sha1 scheme Meta also offers is not accepted here', () => {
    const sha1 = createHmac('sha1', SECRET).update(body, 'utf8').digest('hex');
    assert.equal(authorizeSignature(body, `sha1=${sha1}`, SECRET).ok, false);
  });

  test('with no secret configured every delivery is refused as disabled', () => {
    const auth = authorizeSignature(body, sign(body), undefined);
    assert.equal(auth.ok, false);
    if (auth.ok) return;
    assert.equal(auth.status, 503);
  });

  test('no failure body ever contains the secret or the expected digest', () => {
    for (const presented of [null, 'sha256=deadbeef', sign(body, 'other-secret-00000000')]) {
      const auth = authorizeSignature(body, presented, SECRET);
      assert.equal(auth.ok, false);
      if (auth.ok) return;
      assert.equal(auth.error, WEBHOOK_UNAUTHORIZED);
      assert.doesNotMatch(auth.error, /[0-9a-f]{16,}/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. A first inbound message, as the parser hands it to the ingest
// ═══════════════════════════════════════════════════════════════════════════

describe('5. an inbound text message', () => {
  test('is read out with every field the ingest needs', () => {
    const { messages, ignored } = parseDelivery(delivery());

    assert.equal(messages.length, 1);
    assert.equal(ignored, 0);
    assert.deepEqual(messages[0], {
      phoneNumberId: 'PN_1',
      from: '919900112233',
      externalRef: 'wamid.AAA',
      body: 'I need a storefront rebuild',
      profileName: 'Asha',
      occurredAt: new Date(1786000000 * 1000).toISOString(),
    });
  });

  test('the provider timestamp is read as Unix seconds, not milliseconds', () => {
    const { messages } = parseDelivery(delivery());
    const year = new Date(messages[0]!.occurredAt!).getUTCFullYear();
    assert.ok(year > 2020 && year < 2100, `implausible year ${year}`);
  });

  test('a sender with no profile name still yields a message', () => {
    const { messages } = parseDelivery(delivery({ contacts: [] }));
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.profileName, undefined);
  });

  test('an unreadable timestamp is dropped rather than dropping the message', () => {
    const payload = delivery();
    payload.entry[0]!.changes[0]!.value.messages[0]!.timestamp = 'not-a-number';
    const { messages } = parseDelivery(payload);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.occurredAt, undefined);
  });

  test('several messages in one delivery keep their envelope order', () => {
    const payload = delivery();
    const first = payload.entry[0]!.changes[0]!.value.messages[0]!;
    payload.entry[0]!.changes[0]!.value.messages = [
      { ...first, id: 'wamid.1', text: { body: 'one' } },
      { ...first, id: 'wamid.2', text: { body: 'two' } },
    ];
    const { messages } = parseDelivery(payload);
    assert.deepEqual(
      messages.map((m) => m.body),
      ['one', 'two'],
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Replay — the property the route depends on
// ═══════════════════════════════════════════════════════════════════════════

describe('6. a replayed delivery', () => {
  test('parses to the same provider message id, which is the dedupe key', () => {
    const a = parseDelivery(delivery());
    const b = parseDelivery(delivery());
    assert.equal(a.messages[0]?.externalRef, b.messages[0]?.externalRef);
    assert.equal(a.messages[0]?.externalRef, 'wamid.AAA');
  });

  test('the route answers 200 for a replay rather than treating it as a conflict', () => {
    // A non-2xx would have Meta redeliver forever. A replay is counted and
    // falls through to the 200; only a failure that a retry could fix reaches
    // the 500, and the NOT_FOUND/VALIDATION guard is what stands in front of it.
    assert.match(routeSource, /replayed \+= 1/);

    const guard = routeSource.indexOf("result.error.code === 'NOT_FOUND'");
    const fiveHundred = routeSource.indexOf('status: 500');
    assert.ok(guard > 0, 'the NOT_FOUND/VALIDATION guard is gone');
    assert.ok(fiveHundred > guard, 'the guard must come before the 500 path');
    assert.match(
      routeSource.slice(guard, fiveHundred),
      /skipped \+= 1;\s*\n\s*continue;/,
      'NOT_FOUND/VALIDATION must be acknowledged, not retried',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Deliveries that are not inbound messages
// ═══════════════════════════════════════════════════════════════════════════

describe('7. irrelevant events', () => {
  test('a status receipt yields no message but is surfaced, not ignored', () => {
    const payload = delivery();
    const value = payload.entry[0]!.changes[0]!.value as Record<string, unknown>;
    delete value.messages;
    delete value.contacts;
    value.statuses = [
      { id: 'wamid.AAA', status: 'delivered', recipient_id: '919900112233' },
      { id: 'wamid.AAA', status: 'read', recipient_id: '919900112233' },
    ];

    // C10: what used to be counted ignored is now read out as a receipt.
    const { messages, statuses, ignored } = parseDelivery(payload);
    assert.equal(messages.length, 0);
    assert.equal(statuses.length, 2);
    assert.equal(ignored, 0);
  });

  test('a non-text message is carried, named by kind and never given an invented body', () => {
    const payload = delivery();
    payload.entry[0]!.changes[0]!.value.messages[0] = {
      from: '919900112233',
      id: 'wamid.IMG',
      timestamp: '1786000000',
      type: 'image',
      image: { id: 'media-1', mime_type: 'image/jpeg' },
    } as never;

    // It used to be dropped, which is how a client who answers with a voice
    // note leaves no trace and the conversation appears to have stopped. The
    // envelope is now recorded; the body stays empty because nothing here read
    // it.
    const { messages, ignored } = parseDelivery(payload);
    assert.equal(messages.length, 1);
    assert.equal(ignored, 0);
    assert.equal(messages[0]?.mediaType, 'image');
    assert.equal(messages[0]?.body, '');
  });

  test('a reaction stays ignored — it decorates a message rather than being one', () => {
    const payload = delivery();
    payload.entry[0]!.changes[0]!.value.messages[0] = {
      from: '919900112233',
      id: 'wamid.REACT',
      timestamp: '1786000000',
      type: 'reaction',
      reaction: { message_id: 'wamid.ORIGINAL', emoji: '👍' },
    } as never;

    const { messages, ignored } = parseDelivery(payload);
    assert.equal(messages.length, 0, 'a thumbs-up must not become a second reply');
    assert.equal(ignored, 1);
  });

  test('a kind this parser does not know is ignored rather than carried through', () => {
    const payload = delivery();
    payload.entry[0]!.changes[0]!.value.messages[0] = {
      from: '919900112233',
      id: 'wamid.WAT',
      timestamp: '1786000000',
      type: 'order_status_update',
    } as never;

    // A provider's vocabulary must not reach a screen untranslated.
    const { messages, ignored } = parseDelivery(payload);
    assert.equal(messages.length, 0);
    assert.equal(ignored, 1);
  });

  test('a change for another field is ignored', () => {
    const payload = delivery();
    payload.entry[0]!.changes[0]!.field = 'account_review_update';
    const { messages, ignored } = parseDelivery(payload);
    assert.equal(messages.length, 0);
    assert.equal(ignored, 1);
  });

  test('an envelope for another Meta product is not interpreted', () => {
    const payload = { ...delivery(), object: 'instagram' };
    assert.equal(parseDelivery(payload).messages.length, 0);
  });

  test('a message with no phone_number_id cannot be attributed, so is ignored', () => {
    const payload = delivery();
    delete (payload.entry[0]!.changes[0]!.value as Record<string, unknown>).metadata;
    const { messages, ignored } = parseDelivery(payload);
    assert.equal(messages.length, 0);
    assert.equal(ignored, 1);
  });

  test('an empty text body is ignored — the column rejects it anyway', () => {
    const payload = delivery();
    payload.entry[0]!.changes[0]!.value.messages[0]!.text = { body: '' };
    assert.equal(parseDelivery(payload).messages.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7b. Delivery-status receipts, as the parser hands them to record_delivery_receipt — C10
// ═══════════════════════════════════════════════════════════════════════════

/** A delivery carrying only status receipts, no message. */
const statusDelivery = (statuses: unknown[]) => {
  const payload = delivery();
  const value = payload.entry[0]!.changes[0]!.value as Record<string, unknown>;
  delete value.messages;
  delete value.contacts;
  value.statuses = statuses;
  return payload;
};

describe('7b. delivery-status receipts (C10)', () => {
  test('a well-formed receipt is read out with every field the RPC needs', () => {
    const { statuses, ignored } = parseDelivery(
      statusDelivery([
        { id: 'wamid.AAA', status: 'read', recipient_id: '919900112233', timestamp: '1786000000' },
      ]),
    );
    assert.equal(ignored, 0);
    assert.deepEqual(statuses, [
      {
        phoneNumberId: 'PN_1',
        providerRef: 'wamid.AAA',
        status: 'read',
        occurredAt: new Date(1786000000 * 1000).toISOString(),
        recipientId: '919900112233',
      },
    ]);
  });

  test('all four modelled statuses parse; an unknown one is ignored, not passed on', () => {
    const { statuses, ignored } = parseDelivery(
      statusDelivery([
        { id: 'w.1', status: 'sent' },
        { id: 'w.2', status: 'delivered' },
        { id: 'w.3', status: 'read' },
        { id: 'w.4', status: 'failed' },
        { id: 'w.5', status: 'deleted' },
      ]),
    );
    assert.deepEqual(statuses.map((s) => s.status), ['sent', 'delivered', 'read', 'failed']);
    assert.equal(ignored, 1);
  });

  test('a receipt with no message id cannot name a message, so is ignored', () => {
    const { statuses, ignored } = parseDelivery(statusDelivery([{ status: 'delivered' }]));
    assert.equal(statuses.length, 0);
    assert.equal(ignored, 1);
  });

  test('an absent provider timestamp leaves occurredAt undefined — the DB default stands', () => {
    const { statuses } = parseDelivery(statusDelivery([{ id: 'w.1', status: 'delivered' }]));
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]?.occurredAt, undefined);
    assert.equal(statuses[0]?.recipientId, undefined);
  });

  test('a receipt with no phone_number_id cannot resolve an org, so is ignored', () => {
    const payload = statusDelivery([{ id: 'w.1', status: 'read' }]);
    delete (payload.entry[0]!.changes[0]!.value as Record<string, unknown>).metadata;
    const { statuses, ignored } = parseDelivery(payload);
    assert.equal(statuses.length, 0);
    assert.equal(ignored, 1);
  });

  test('messages and status receipts in one delivery are both surfaced', () => {
    const payload = delivery();
    (payload.entry[0]!.changes[0]!.value as Record<string, unknown>).statuses = [
      { id: 'wamid.BBB', status: 'delivered' },
    ];
    const { messages, statuses } = parseDelivery(payload);
    assert.equal(messages.length, 1);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]?.providerRef, 'wamid.BBB');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Malformed payloads
// ═══════════════════════════════════════════════════════════════════════════

describe('8. malformed payloads', () => {
  test('the parser never throws, whatever it is handed', () => {
    for (const junk of [
      null,
      undefined,
      0,
      '',
      'a string',
      [],
      {},
      { object: 'whatsapp_business_account' },
      { object: 'whatsapp_business_account', entry: 'not-an-array' },
      { object: 'whatsapp_business_account', entry: [null, 1, 'x'] },
      { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages' }] }] },
      { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: 'no' } }] }] },
    ]) {
      const result = parseDelivery(junk);
      assert.equal(result.messages.length, 0, JSON.stringify(junk));
      assert.ok(Number.isInteger(result.ignored));
    }
  });

  test('a body that is not JSON is a 400, not a retry loop', () => {
    // Redelivery cannot fix a payload that will never parse.
    assert.match(routeSource, /JSON\.parse\(rawBody\)/);
    assert.match(routeSource, /status: 400/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. C5 — a message the ingest refuses is named, not swallowed
//
// VALIDATION and NOT_FOUND were folded into one `skipped` count and one
// console.warn, so a customer's message that never reached the transcript
// looked exactly like a delivery for a number we do not serve. Behaviour is
// proved end to end by scripts/verify-whatsapp-webhook.mjs §7b; the branch
// structure is pinned here.
// ═══════════════════════════════════════════════════════════════════════════

describe('9. a refused message is reported as rejected', () => {
  test('VALIDATION and NOT_FOUND are handled separately', () => {
    const notFound = routeSource.indexOf("result.error.code === 'NOT_FOUND'");
    const validation = routeSource.indexOf("result.error.code === 'VALIDATION'");
    assert.ok(notFound > 0 && validation > 0, 'one of the two outcomes is no longer checked');
    assert.ok(notFound < validation, 'NOT_FOUND is the cheaper check and comes first');

    // The bug was the two sharing one `if`, and mere presence cannot see that:
    // `code === 'NOT_FOUND' || code === 'VALIDATION'` satisfies both assertions
    // above. What distinguishes separate branches is that the first one ends
    // before the second begins, so the branch boundary is what to assert on.
    assert.match(
      routeSource.slice(notFound, validation),
      /continue;/,
      'the two outcomes were re-merged into a single branch',
    );
  });

  test('each has its own counter, and both are reported', () => {
    assert.match(routeSource, /let skipped = 0;/);
    assert.match(routeSource, /let rejected = 0;/);
    assert.match(routeSource, /skipped \+= 1/);
    assert.match(routeSource, /rejected \+= 1/);
    const body = routeSource.slice(routeSource.lastIndexOf('return NextResponse.json({'));
    for (const field of ['received', 'ingested', 'replayed', 'skipped', 'rejected', 'ignored']) {
      assert.match(body, new RegExp(`\\b${field}\\b`), `the response no longer reports ${field}`);
    }
  });

  test('a refusal is an error, an unclaimed number is a warning', () => {
    const validation = routeSource.indexOf("result.error.code === 'VALIDATION'");
    const branch = routeSource.slice(validation, validation + 700);
    assert.match(branch, /console\.error/);
    assert.doesNotMatch(branch, /console\.warn/);

    const notFound = routeSource.indexOf("result.error.code === 'NOT_FOUND'");
    assert.match(routeSource.slice(notFound, notFound + 500), /console\.warn/);
  });

  test('it reports which fields failed, so it can be diagnosed', () => {
    const at = routeSource.indexOf("result.error.code === 'VALIDATION'");
    const branch = routeSource.slice(at, at + 700);
    assert.match(branch, /fields: Object\.keys\(result\.error\.details \?\? \{\}\)/);
    assert.match(branch, /bodyLength: message\.body\.length/);
  });

  test('and never logs the body — the content is the thing being protected', () => {
    const at = routeSource.indexOf("result.error.code === 'VALIDATION'");
    const branch = routeSource.slice(at, at + 700);
    assert.doesNotMatch(branch, /body: message\.body/);
    assert.doesNotMatch(branch, /text: message\.body/);
  });

  test('it stays a 200 — redelivery cannot make a malformed message valid', () => {
    const at = routeSource.indexOf("result.error.code === 'VALIDATION'");
    const branch = routeSource.slice(at, at + 700);
    assert.doesNotMatch(branch, /status: 5\d\d/);
    assert.doesNotMatch(branch, /status: 4\d\d/);
    assert.match(branch, /continue;/);
  });

  test('the 500 path still exists for failures a retry could fix', () => {
    assert.match(routeSource, /status: 500/);
    const five = routeSource.indexOf('status: 500');
    assert.ok(five > routeSource.indexOf("result.error.code === 'VALIDATION'"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The route stays thin, and sends nothing
// ═══════════════════════════════════════════════════════════════════════════

describe('the route', () => {
  test('reads the raw body once, bounded, before verifying', () => {
    const read = routeSource.indexOf('readBoundedBody(request, MAX_BODY_BYTES)');
    const verify = routeSource.indexOf('authorizeSignature(');
    assert.ok(read > 0 && verify > read, 'the raw body must be read before it can be verified');
    // Never re-parsed via request.json() — the HMAC is over the exact bytes.
    assert.doesNotMatch(routeSource, /await request\.json\(\)/);
  });

  test('the signature is checked before the payload is parsed or ingested', () => {
    const verify = routeSource.indexOf('authorizeSignature(');
    assert.ok(verify < routeSource.indexOf('JSON.parse(rawBody)'));
    assert.ok(verify < routeSource.indexOf('ingestInboundMessage('));
  });

  test('the body is read with a hard byte ceiling, streamed, not buffered whole then measured', () => {
    // request.text() would buffer up to the platform limit before any ceiling
    // of ours applied — attacker-controlled memory on an unauthenticated
    // endpoint. The bounded reader stops at the ceiling instead.
    assert.match(routeSource, /readBoundedBody\(request, MAX_BODY_BYTES\)/);
    assert.doesNotMatch(routeSource, /await request\.text\(\)/);
    assert.match(routeSource, /status: 413/);
    // Byte-accurate, not JS string .length (UTF-16 code units).
    assert.doesNotMatch(routeSource, /rawBody\.length > MAX_BODY_BYTES/);
  });

  test('a signed batch is never refused for its message count — that would lose real messages', () => {
    // No count ceiling: the byte bound already limits the batch, every message
    // passed the signature, and refusing would make Meta redeliver forever.
    assert.doesNotMatch(routeSource, /MAX_MESSAGES_PER_DELIVERY/);
    assert.doesNotMatch(routeSource, /messages\.slice\(/);
  });

  test('it holds no business logic — one ingest call, no crm tables', () => {
    assert.equal((routeSource.match(/ingestInboundMessage\(/g) ?? []).length, 1);
    assert.doesNotMatch(routeSource, /\.from\(['"](leads|contacts|conversations)['"]\)/);
    assert.doesNotMatch(routeSource, /\.rpc\(/);
  });

  test('it sends nothing — no outbound call of any kind', () => {
    const withoutComments = routeSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(withoutComments, /\bfetch\(/);
    assert.doesNotMatch(withoutComments, /graph\.facebook/);
    assert.doesNotMatch(withoutComments, /messages\/send/);
  });

  test('it is the nodejs runtime — the HMAC needs node:crypto', () => {
    assert.match(routeSource, /export const runtime = 'nodejs'/);
    assert.doesNotMatch(routeSource, /runtime = 'edge'/);
  });

  test('it lives at the path ARCHITECTURE.md §7.3 sanctions for the service role', () => {
    // app/api/webhooks/* is permitted call site #2 in src/lib/db/admin.ts.
    assert.match(routeSource, /createAdminClient/);
  });

  test('the signature header is the one Meta actually sends', () => {
    assert.equal(SIGNATURE_HEADER, 'x-hub-signature-256');
  });
});
