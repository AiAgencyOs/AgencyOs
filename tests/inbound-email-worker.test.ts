import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

const secrets: Record<string, string> = {};
mock.module('server-only', { exports: {} });
mock.module('@/lib/secrets/resolve', { exports: { resolveSecret: async (k: string) => secrets[k] ?? null, secretConfigured: async (k: string) => Boolean(secrets[k]) } });
const { runInboundEmail } = await import('../src/modules/crm/inbound-email.ts');

const crlf = (s: string) => s.replace(/\n/g, '\r\n');

type Call = { fn: string; args: Record<string, unknown> };
function fakeAdmin(opts: { claim?: boolean; doorError?: boolean } = {}) {
  const calls: Call[] = [];
  const admin = {
    schema: (schema: string) => ({
      from: () => ({ select: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { id: 'org-1' }, error: null }) }) }) }) }),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn: `${schema}.${fn}`, args });
        if (fn === 'claim_inbound_poll') return { data: opts.claim ?? true, error: null };
        if (fn === 'ingest_inbound_email') return opts.doorError ? { data: null, error: { message: 'boom' } } : { data: [{ outcome: 'recorded' }], error: null };
        return { data: null, error: null };
      },
    }),
  };
  return { admin: admin as never, calls };
}

const configure = () => Object.assign(secrets, { IMAP_HOST: 'imap.example.com', SMTP_USER: 'care@x.example', SMTP_PASS: 'pw', EMAIL_FROM: 'care@x.example', SMTP_OUTREACH_USER: 'info@x.example', SMTP_OUTREACH_PASS: 'pw2', EMAIL_OUTREACH_FROM: 'info@x.example' });
const clear = () => { for (const k of Object.keys(secrets)) delete secrets[k]; };

describe('the mailbox sweep', () => {
  test('with no IMAP host or no mailbox login, nothing is read - and nothing breaks', async () => {
    clear();
    let read = 0;
    const { admin } = fakeAdmin();
    const s = await runInboundEmail(admin, { read: async () => { read += 1; return { ok: true, seen: 0, handled: 0, skippedOversize: 0 }; } });
    assert.deepEqual(s.lanes.map((l) => l.outcome), ['not_configured', 'not_configured']);
    assert.equal(read, 0);
  });

  test('a lane read a moment ago is not read again (the claim says no)', async () => {
    clear(); configure();
    let read = 0;
    const { admin } = fakeAdmin({ claim: false });
    const s = await runInboundEmail(admin, { read: async () => { read += 1; return { ok: true, seen: 0, handled: 0, skippedOversize: 0 }; } });
    assert.deepEqual(s.lanes.map((l) => l.outcome), ['skipped_recent', 'skipped_recent']);
    assert.equal(read, 0);
  });

  test('each message goes through the one door with what was classified, and a handled one is reported as such', async () => {
    clear(); configure();
    const mails = [
      crlf('From: Asha <asha@client.example>\nSubject: Re: quote\nMessage-ID: <m1@c>\nContent-Type: text/plain\n\nGo ahead.\n\n> older text\n'),
      crlf('From: p@prospect.example\nSubject: Re: hi\nMessage-ID: <m2@p>\nContent-Type: text/plain\n\nplease unsubscribe me\n'),
      crlf('From: MAILER-DAEMON@mx.example\nSubject: Undelivered\nMessage-ID: <m3@mx>\nContent-Type: multipart/report; report-type=delivery-status; boundary="B"\n\n--B\nContent-Type: text/plain\n\nno\n--B\nContent-Type: message/delivery-status\n\nReporting-MTA: dns; mx\n\nFinal-Recipient: rfc822; gone@prospect.example\nAction: failed\nStatus: 5.1.1\n\n--B--\n'),
      crlf('From: info@x.example\nSubject: loop\nMessage-ID: <m4@x>\nContent-Type: text/plain\n\nour own mailbox\n'),
    ];
    const { admin, calls } = fakeAdmin();
    const flagged: boolean[] = [];
    const s = await runInboundEmail(admin, {
      read: async (cfg, handle) => {
        assert.equal(cfg.secure, true, 'a real host is always TLS');
        assert.equal(cfg.port, 993);
        for (const raw of mails) flagged.push(await handle({ uid: flagged.length + 1, raw }));
        return { ok: true, seen: mails.length, handled: mails.length, skippedOversize: 0 };
      },
    });
    assert.equal(flagged.length, 8, 'two lanes, four messages each');
    assert.ok(flagged.every(Boolean), 'every message the door accepted is reported handled (so the mailbox flags it seen)');
    const doors = calls.filter((c) => c.fn === 'crm.ingest_inbound_email').map((c) => c.args);
    // Two lanes each read the same four stubbed mails: look at the client lane's first batch.
    const client = doors.slice(0, 4);
    assert.equal(client[0]?.p_kind, 'reply');
    assert.equal(client[0]?.p_from, 'asha@client.example');
    assert.equal(client[0]?.p_body, 'Go ahead.', 'only what they wrote - the quoted text is cut');
    assert.equal(client[0]?.p_message_id, 'm1@c');
    assert.equal(client[1]?.p_kind, 'reply', 'on the client lane "unsubscribe" is a message for a person, not a suppression');
    assert.equal(client[2]?.p_kind, 'hard_bounce');
    assert.equal(client[2]?.p_bounced_email, 'gone@prospect.example');
    const outreach = doors.slice(4, 8);
    assert.equal(outreach[1]?.p_kind, 'unsubscribe', 'on the outreach lane it is');
    assert.equal(outreach[3]?.p_kind, 'auto_reply', 'our own mailbox writing to itself is never somebody replying');
    assert.deepEqual(s.lanes.map((l) => l.outcome), ['read', 'read']);
    assert.ok(calls.some((c) => c.fn === 'crm.record_inbound_poll' && c.args.p_ok === true && c.args.p_handled === 4), 'the poll is recorded');
  });

  test('a door that fails leaves the message UNREAD for the next sweep; a failed read is recorded with its reason', async () => {
    clear(); configure();
    const { admin, calls } = fakeAdmin({ doorError: true });
    let flagged: boolean | null = null;
    await runInboundEmail(admin, {
      read: async (_cfg, handle) => {
        flagged = await handle({ uid: 1, raw: crlf('From: a@b.example\nMessage-ID: <z@b>\nContent-Type: text/plain\n\nhi\n') });
        return { ok: true, seen: 1, handled: 0, skippedOversize: 0 };
      },
    });
    assert.equal(flagged, false);

    const second = fakeAdmin();
    const s = await runInboundEmail(second.admin, { read: async () => ({ ok: false, reason: 'The mail server refused the login (check the mailbox address and password).' }) });
    assert.deepEqual(s.lanes.map((l) => l.outcome), ['failed', 'failed']);
    assert.ok(second.calls.some((c) => c.fn === 'crm.record_inbound_poll' && c.args.p_ok === false && /refused the login/.test(String(c.args.p_detail))));
    void calls;
  });
});
