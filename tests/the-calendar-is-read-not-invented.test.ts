import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';

import { filterSlots, offerableSlots, readAvailabilityFrom } from '../src/lib/scheduling/availability.ts';

/**
 * The calendar is read, not invented — G-242, ADM-102.
 *
 * A stand-in Google on 127.0.0.1 answers the token exchange, free/busy and
 * the events API; a key pair minted for this process signs the assertion.
 * What is proved: the credential is exchanged the way RFC 7523 says (and the
 * stand-in VERIFIES the signature with the public half); busy blocks become
 * free windows and nothing more; §5's filters narrow what was read; an event
 * comes back with Google's id and Meet link or a named refusal; a refusal
 * from Google is `unreadable` with its reason, never an empty calendar; and
 * with no credential the answer is `unconfigured`, exactly as before.
 */

type Reply = { status: number; body: unknown };
let server: Server;
let base: string;
let lastAssertionValid: boolean | null = null;
let lastEventBody: Record<string, unknown> = {};
let lastEventPath = '';
let replies: Record<string, Reply> = {};
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

const config = () => ({
  serviceAccountEmail: 'scheduler@agencyos-test.iam.gserviceaccount.com',
  privateKeyPem: PEM,
  calendarId: 'meetings@agency.example',
  impersonate: 'meetings@agency.example',
  tokenUrl: `${base}/token`,
  calendarUrl: `${base}/calendar/v3`,
});

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = req.url ?? '';
      if (url === '/token') {
        const assertion = new URLSearchParams(raw).get('assertion') ?? '';
        const [h, c, sig] = assertion.split('.');
        lastAssertionValid = createVerify('RSA-SHA256').update(`${h}.${c}`).end().verify(publicKey, Buffer.from(sig ?? '', 'base64url'));
        const claims = JSON.parse(Buffer.from(c ?? '', 'base64url').toString()) as Record<string, unknown>;
        (globalThis as { __claims?: unknown }).__claims = claims;
        const reply = replies.token ?? { status: 200, body: { access_token: 'ya29.test-token', expires_in: 3600 } };
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
        return;
      }
      if (url.endsWith('/freeBusy')) {
        const reply = replies.freebusy ?? { status: 200, body: { calendars: { 'meetings@agency.example': { busy: [] } } } };
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
        return;
      }
      if (url.includes('/events') && req.method === 'POST') {
        lastEventBody = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        lastEventPath = url;
        const reply = replies.event ?? { status: 200, body: { id: 'evt_1', hangoutLink: 'https://meet.google.com/abc-defg-hij', htmlLink: 'https://calendar.google.com/x' } };
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
        return;
      }
      if (url.includes('/events/') && req.method === 'DELETE') {
        const reply = replies.cancel ?? { status: 204, body: '' };
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.status === 204 ? '' : JSON.stringify(reply.body));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'no such route in the stand-in' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

async function adapter() {
  const { createGoogleCalendar } = await import('../src/lib/scheduling/google.ts');
  const made = createGoogleCalendar(config());
  assert.ok(made);
  return made;
}

describe('A. the credential is exchanged the way the standard says, and never logged', () => {
  test('the assertion is RS256-signed by the key, names the account, the impersonated user, the scope and the token audience', async () => {
    replies = {};
    const a = await adapter();
    const answer = await a.readAvailability({ from: '2026-09-15T00:00:00.000Z', to: '2026-09-16T00:00:00.000Z' });
    assert.equal(answer.state, 'read');
    assert.equal(lastAssertionValid, true, 'the stand-in verified the signature with the public half');
    const claims = (globalThis as { __claims?: Record<string, unknown> }).__claims!;
    assert.equal(claims.iss, 'scheduler@agencyos-test.iam.gserviceaccount.com');
    assert.equal(claims.sub, 'meetings@agency.example');
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/calendar');
    assert.equal(claims.aud, `${base}/token`);
    assert.ok(typeof claims.exp === 'number' && typeof claims.iat === 'number' && claims.exp - claims.iat === 300, 'five minutes, no more');
  });

  test('the PEM is found in whatever was pasted — escaped newlines, CRLF, quotes, the JSON label, the whole file, indentation', async () => {
    const { serviceAccountAssertion, pemFromPaste } = await import('../src/lib/scheduling/google.ts');
    const escaped = PEM.replace(/\n/g, '\\n');
    const pastes: Record<string, string> = {
      clean: PEM,
      escaped,
      quoted: `"${escaped}"`,
      crlf: PEM.replace(/\n/g, '\r\n'),
      // What the first production paste (2026-09-13) most likely was: the line out of the JSON file.
      labelled: `"private_key": "${escaped}",`,
      wholeFile: JSON.stringify({ type: 'service_account', private_key: PEM, client_email: 'x@y.iam.gserviceaccount.com' }),
      indented: PEM.split('\n').map((l) => `    ${l}   `).join('\n'),
      trailingJunk: `${escaped}\n              `,
    };
    for (const [name, paste] of Object.entries(pastes)) {
      const pem = pemFromPaste(paste);
      assert.doesNotThrow(() => serviceAccountAssertion({ ...config(), privateKeyPem: pem }, 1_700_000_000), name);
    }
    // And the real reader goes through the same function (not a copy of it in the test).
    assert.match(readFileSync(new URL('../src/lib/scheduling/google.ts', import.meta.url), 'utf8'), /privateKeyPem: pemFromPaste\(key\)/);
    // Nothing found: handed back untouched, so the signer's refusal names the variable.
    assert.equal(pemFromPaste('not a key'), 'not a key');
    assert.throws(() => serviceAccountAssertion({ ...config(), privateKeyPem: pemFromPaste('not a key') }, 1_700_000_000));
  });

  test('a shared Gmail calendar: no impersonated user, no sub claim, no Meet asked for — and the event is still created, said as unavailable', async () => {
    replies = {};
    const { createGoogleCalendar } = await import('../src/lib/scheduling/google.ts');
    const gmail = createGoogleCalendar({ ...config(), impersonate: null });
    assert.ok(gmail && gmail.canCreateMeet === false);
    const answer = await gmail!.readAvailability({ from: '2026-09-15T00:00:00.000Z', to: '2026-09-16T00:00:00.000Z' });
    assert.equal(answer.state, 'read');
    const claims = (globalThis as { __claims?: Record<string, unknown> }).__claims!;
    assert.equal('sub' in claims, false, 'the account acts as itself');
    const result = await gmail!.createEvent({ summary: 'x', startAt: '2026-09-15T10:00:00Z', endAt: '2026-09-15T10:30:00Z', timezone: 'UTC', requestId: 'k', withMeet: true });
    assert.ok(result.ok && result.meet === 'unavailable' && result.eventId === 'evt_1');
    assert.equal('conferenceData' in lastEventBody, false, 'no Meet request was sent for Google to refuse');
  });

  test('with no credential there is no adapter, and the port answers unconfigured — as it always did', async () => {
    const { createGoogleCalendar } = await import('../src/lib/scheduling/google.ts');
    assert.equal(createGoogleCalendar(null), null);
    assert.deepEqual(await readAvailabilityFrom(null, { from: '2026-09-15T00:00:00.000Z', to: '2026-09-16T00:00:00.000Z' }), { state: 'unconfigured' });
  });
});

describe('B. busy becomes free, and nothing more', () => {
  test('busy blocks are subtracted (merged, clipped to the window) and the rest is what may be offered', async () => {
    replies = { freebusy: { status: 200, body: { calendars: { 'meetings@agency.example': { busy: [
      { start: '2026-09-15T10:00:00Z', end: '2026-09-15T11:00:00Z' },
      { start: '2026-09-15T10:30:00Z', end: '2026-09-15T12:00:00Z' },
      { start: '2026-09-14T23:00:00Z', end: '2026-09-15T01:00:00Z' },
    ] } } } } };
    const a = await adapter();
    const answer = await readAvailabilityFrom(a, { from: '2026-09-15T00:00:00.000Z', to: '2026-09-15T14:00:00.000Z' });
    assert.equal(answer.state, 'read');
    if (answer.state !== 'read') return;
    assert.deepEqual(answer.source, { provider: 'google', calendarId: 'meetings@agency.example' });
    assert.deepEqual(answer.slots, [
      { startAt: '2026-09-15T01:00:00.000Z', endAt: '2026-09-15T10:00:00.000Z' },
      { startAt: '2026-09-15T12:00:00.000Z', endAt: '2026-09-15T14:00:00.000Z' },
    ]);
    // §5's own filters narrow what was read; they never add.
    // Minimum notice drops a window that STARTS too soon (the 01:00 one, at 10:00 with an hour's notice); it does not trim it.
    const usable = filterSlots(answer.slots, { durationMinutes: 30, minimumNoticeMinutes: 60, bufferMinutes: 15 }, '2026-09-15T10:00:00.000Z');
    assert.deepEqual(usable, [{ startAt: '2026-09-15T12:00:00.000Z', endAt: '2026-09-15T14:00:00.000Z' }]);
    const offer = offerableSlots(answer, { requestedStartAt: '2026-09-15T12:00:00.000Z' }, { durationMinutes: 30, minimumNoticeMinutes: 0, bufferMinutes: 0 }, '2026-09-15T09:00:00.000Z');
    assert.ok(offer.ok && offer.slots[0]?.startAt === '2026-09-15T12:00:00.000Z');
  });

  test('a calendar that is entirely busy reads as a full calendar — empty, and still `read`', async () => {
    replies = { freebusy: { status: 200, body: { calendars: { 'meetings@agency.example': { busy: [{ start: '2026-09-15T00:00:00Z', end: '2026-09-16T00:00:00Z' }] } } } } };
    const answer = await (await adapter()).readAvailability({ from: '2026-09-15T00:00:00.000Z', to: '2026-09-16T00:00:00.000Z' });
    assert.equal(answer.state, 'read');
    if (answer.state === 'read') assert.deepEqual(answer.slots, []);
  });
});

describe('C. a refusal is unreadable with its reason — never an empty calendar', () => {
  test('a rejected credential', async () => {
    replies = { token: { status: 401, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } } };
    const answer = await (await adapter()).readAvailability({ from: '2026-09-15T00:00:00.000Z', to: '2026-09-16T00:00:00.000Z' });
    assert.equal(answer.state, 'unreadable');
    if (answer.state === 'unreadable') assert.match(answer.reason, /rejected the service-account credential/);
  });

  test('a calendar the account may not read, and an answer about a different calendar', async () => {
    replies = { freebusy: { status: 200, body: { calendars: { 'meetings@agency.example': { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] } } } } };
    const a = await adapter();
    const refused = await a.readAvailability({ from: '2026-09-15T00:00:00.000Z', to: '2026-09-16T00:00:00.000Z' });
    assert.equal(refused.state, 'unreadable');
    replies = { freebusy: { status: 200, body: { calendars: { 'someone-else@agency.example': { busy: [] } } } } };
    const wrong = await a.readAvailability({ from: '2026-09-15T00:00:00.000Z', to: '2026-09-16T00:00:00.000Z' });
    assert.equal(wrong.state, 'unreadable');
    if (wrong.state === 'unreadable') assert.match(wrong.reason, /not about the calendar asked for/);
  });

  test('a 403 on the calendar API', async () => {
    replies = { freebusy: { status: 403, body: { error: { message: 'Forbidden' } } } };
    const answer = await (await adapter()).readAvailability({ from: '2026-09-15T00:00:00.000Z', to: '2026-09-16T00:00:00.000Z' });
    assert.equal(answer.state, 'unreadable');
    if (answer.state === 'unreadable') assert.match(answer.reason, /may not use this calendar/);
  });
});

describe('D. an event is created with a Meet link, verified before success — or refused by name', () => {
  test('the request carries the times in the zone, the Meet conference request keyed on the booking, and the answer is the provider’s id and link', async () => {
    replies = {};
    const a = await adapter();
    const result = await a.createEvent({
      summary: 'Discovery call — Tiffin app', startAt: '2026-09-15T10:00:00+05:30', endAt: '2026-09-15T10:30:00+05:30', timezone: 'Asia/Kolkata',
      requestId: 'zztest-book-1', attendees: [{ email: 'client@example.invalid' }], withMeet: true,
    });
    assert.deepEqual(result, { ok: true, eventId: 'evt_1', meetUrl: 'https://meet.google.com/abc-defg-hij', meet: 'created', htmlLink: 'https://calendar.google.com/x' });
    assert.deepEqual(lastEventBody.start, { dateTime: '2026-09-15T10:00:00+05:30', timeZone: 'Asia/Kolkata' });
    assert.ok(lastEventPath.includes('sendUpdates=none'), 'Google does not email the attendees; AgencyOS tells the client itself (§6.4)');
    assert.deepEqual(lastEventBody.conferenceData, { createRequest: { requestId: 'zztest-book-1', conferenceSolutionKey: { type: 'hangoutsMeet' } } });
    assert.deepEqual(lastEventBody.attendees, [{ email: 'client@example.invalid' }]);
  });

  test('a 200 without an event id is NOT a booking (§6.3 verify the provider response)', async () => {
    replies = { event: { status: 200, body: { kind: 'calendar#event' } } };
    const result = await (await adapter()).createEvent({ summary: 'x', startAt: '2026-09-15T10:00:00Z', endAt: '2026-09-15T10:30:00Z', timezone: 'UTC', requestId: 'k', withMeet: false });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /without an event id; the booking is not confirmed/);
  });

  test('a refusal names itself; cancelling an event that is already gone is not a failure', async () => {
    replies = { event: { status: 403, body: { error: { message: 'Forbidden' } } }, cancel: { status: 410, body: { error: { message: 'Gone' } } } };
    const a = await adapter();
    const refused = await a.createEvent({ summary: 'x', startAt: '2026-09-15T10:00:00Z', endAt: '2026-09-15T10:30:00Z', timezone: 'UTC', requestId: 'k', withMeet: false });
    assert.ok(!refused.ok && refused.permanent && /may not use this calendar/.test(refused.message));
    assert.deepEqual(await a.cancelEvent('evt_gone'), { ok: true, outcome: 'already_gone' });
    replies = {};
    assert.deepEqual(await a.cancelEvent('evt_1'), { ok: true, outcome: 'cancelled' });
  });
});

describe('E. free windows, as a function', () => {
  test('overlapping and out-of-window busy blocks are merged and clipped; sub-minute gaps are not windows', async () => {
    const { freeWindows } = await import('../src/lib/scheduling/google.ts');
    assert.deepEqual(freeWindows({ from: '2026-09-15T09:00:00.000Z', to: '2026-09-15T12:00:00.000Z' }, [
      { startAt: '2026-09-15T08:00:00.000Z', endAt: '2026-09-15T09:00:30.000Z' },
      { startAt: '2026-09-15T10:00:00.000Z', endAt: '2026-09-15T10:30:00.000Z' },
      { startAt: '2026-09-15T10:15:00.000Z', endAt: '2026-09-15T11:00:00.000Z' },
    ]), [
      { startAt: '2026-09-15T09:00:30.000Z', endAt: '2026-09-15T10:00:00.000Z' },
      { startAt: '2026-09-15T11:00:00.000Z', endAt: '2026-09-15T12:00:00.000Z' },
    ]);
    assert.deepEqual(freeWindows({ from: 'garbage', to: '2026-09-15T12:00:00.000Z' }, []), []);
  });
});
