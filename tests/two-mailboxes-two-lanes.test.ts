import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { describe, mock, test } from 'node:test';

// Owner decision 2026-10-04: care@ sends what a client is owed (quotation, invoice,
// confirmation, update, delivery, handover); info@ sends lead generation and email
// marketing only. Separate mailboxes, and neither borrows the other.

type Seen = { users: string[]; mailFrom: string[]; passwords: string[] };

function fakeSmtp(): Promise<{ server: Server; port: number; seen: Seen }> {
  const seen: Seen = { users: [], mailFrom: [], passwords: [] };
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      let data = false;
      let step: 'none' | 'user' | 'pass' = 'none';
      socket.write('220 fake\r\n');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (data) {
          if (buffer.includes('\r\n.\r\n')) {
            buffer = '';
            data = false;
            socket.write('250 queued as OK1\r\n');
          }
          return;
        }
        let i: number;
        while ((i = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          if (step === 'user') { seen.users.push(Buffer.from(line, 'base64').toString()); step = 'pass'; socket.write('334 UGFzc3dvcmQ6\r\n'); continue; }
          if (step === 'pass') { seen.passwords.push(Buffer.from(line, 'base64').toString()); step = 'none'; socket.write('235 ok\r\n'); continue; }
          if (/^EHLO/i.test(line)) socket.write('250-fake\r\n250 AUTH LOGIN\r\n');
          else if (/^AUTH LOGIN/i.test(line)) { step = 'user'; socket.write('334 VXNlcm5hbWU6\r\n'); }
          else if (/^MAIL FROM/i.test(line)) { seen.mailFrom.push(line); socket.write('250 ok\r\n'); }
          else if (/^RCPT TO/i.test(line)) socket.write('250 ok\r\n');
          else if (/^DATA/i.test(line)) { socket.write('354 go\r\n'); data = true; break; }
          else if (/^QUIT/i.test(line)) { socket.write('221 bye\r\n'); socket.end(); }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, seen }));
  });
}

describe('two mailboxes, two lanes', () => {
  const env: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  mock.module('@/lib/env', { exports: { serverEnv: () => env } });
  mock.module('@/lib/secrets/resolve', {
    exports: {
      secretConfigured: async (k: string) => Boolean(secrets[k] ?? env[k]),
      resolveSecret: async (k: string) => secrets[k] ?? (env[k] === undefined ? null : String(env[k])),
    },
  });

  const configure = (port: number, both = true) => {
    for (const k of Object.keys(env)) delete env[k];
    Object.assign(env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: port, SMTP_SECURE: 'false', SMTP_USER: 'care@sonushah.com', EMAIL_FROM: 'care@sonushah.com' });
    secrets.SMTP_PASS = 'care-secret';
    if (both) {
      Object.assign(env, { SMTP_OUTREACH_USER: 'info@sonushah.com', EMAIL_OUTREACH_FROM: 'info@sonushah.com' });
      secrets.SMTP_OUTREACH_PASS = 'info-secret';
    } else delete secrets.SMTP_OUTREACH_PASS;
  };

  test('a message with no lane leaves from care@, logging in as care@ with its own password', async () => {
    const fake = await fakeSmtp();
    try {
      configure(fake.port);
      const { sendEmail } = await import('../src/lib/email/transport.ts');
      const r = await sendEmail({ to: 'client@example.com', subject: 'Invoice', text: 'attached' });
      assert.equal(r.ok, true);
      assert.deepEqual(fake.seen.users, ['care@sonushah.com']);
      assert.deepEqual(fake.seen.passwords, ['care-secret']);
      assert.match(fake.seen.mailFrom[0] ?? '', /care@sonushah\.com/);
    } finally { fake.server.close(); }
  });

  test('an outreach message leaves from info@, logging in as info@ with the OTHER password', async () => {
    const fake = await fakeSmtp();
    try {
      configure(fake.port);
      const { sendEmail } = await import('../src/lib/email/transport.ts');
      const r = await sendEmail({ lane: 'outreach', to: 'prospect@example.com', subject: 'Hello', text: 'We build apps' });
      assert.equal(r.ok, true);
      assert.deepEqual(fake.seen.users, ['info@sonushah.com']);
      assert.deepEqual(fake.seen.passwords, ['info-secret']);
      assert.match(fake.seen.mailFrom[0] ?? '', /info@sonushah\.com/);
      assert.doesNotMatch(fake.seen.mailFrom[0] ?? '', /care@/);
    } finally { fake.server.close(); }
  });

  test('outreach with no info@ mailbox configured sends nothing and never borrows care@', async () => {
    const fake = await fakeSmtp();
    try {
      configure(fake.port, false);
      const { sendEmail, emailTransportState } = await import('../src/lib/email/transport.ts');
      const state = await emailTransportState('outreach');
      assert.equal(state.configured, false);
      const r = await sendEmail({ lane: 'outreach', to: 'prospect@example.com', subject: 'Hello', text: 'x' });
      assert.equal(r.ok, false);
      assert.match(r.ok ? '' : r.reason, /SMTP_OUTREACH_PASS|EMAIL_OUTREACH_FROM|SMTP_OUTREACH_USER/);
      assert.deepEqual(fake.seen.users, [], 'no session was even opened');
    } finally { fake.server.close(); }
  });

  test('the client lane is unaffected when only care@ is configured', async () => {
    const fake = await fakeSmtp();
    try {
      configure(fake.port, false);
      const { emailTransportState } = await import('../src/lib/email/transport.ts');
      const state = await emailTransportState();
      assert.equal(state.configured, true);
      assert.equal(state.configured && state.from, 'care@sonushah.com');
    } finally { fake.server.close(); }
  });
});
