import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { describe, mock, test } from 'node:test';

import { renderAnnouncementText, saveAnnouncementTemplateSchema } from '../src/modules/crm/announcement-templates-schema.ts';
import { conversationHref } from '../src/modules/crm/conversation-href.ts';
import { addDeviceSchema, mergeDeviceCards, unsupportedFor, type DeviceConfiguration } from '../src/modules/qa/device-config.ts';
import { deviceTiles } from '../src/modules/qa/device-tiles.ts';
import { addRunEvidenceSchema } from '../src/modules/qa/run-lifecycle-schema.ts';
import { recordVerificationSchema } from '../src/modules/projects/handover-release-schema.ts';
import { retryFailedDeliverySchema } from '../src/modules/crm/delivery-retry-schema.ts';
import { resendEmailSchema, sendCenterEmailSchema } from '../src/modules/crm/email-schema.ts';

/**
 * Theme W5 — QA, release, communication. The pure rules behind the screens,
 * called with real inputs; the database rules are in
 * scripts/verify-w5-qa-release-comms.mjs (npm run db:verify:w5).
 */

const uuid = '11111111-1111-4111-8111-111111111111';

describe('a conversation with no lead never links to /leads/null', () => {
  test('a direct thread opens its lead', () => {
    assert.equal(conversationHref({ leadId: uuid, projectId: null }), `/leads/${uuid}`);
  });
  test('a project group opens its project communication tab', () => {
    assert.equal(conversationHref({ leadId: null, projectId: uuid }), `/projects/${uuid}/communication`);
  });
  test('a group with neither is not a link at all', () => {
    assert.equal(conversationHref({ leadId: null, projectId: null }), null);
  });
});

describe('an unsupported device must say why', () => {
  test('the form refuses unsupported with no reason, and a blank one', () => {
    assert.equal(addDeviceSchema.safeParse({ name: 'Galaxy Fold', platform: 'android', status: 'unsupported' }).success, false);
    assert.equal(addDeviceSchema.safeParse({ name: 'Galaxy Fold', platform: 'android', status: 'unsupported', reason: '   ' }).success, false);
    assert.equal(addDeviceSchema.safeParse({ name: 'Galaxy Fold', platform: 'android', status: 'unsupported', reason: 'Excluded by contract.' }).success, true);
  });
  test('a supported device needs no reason', () => {
    assert.equal(addDeviceSchema.safeParse({ name: 'iPhone 15', platform: 'ios' }).success, true);
  });

  const configs: DeviceConfiguration[] = [
    { id: 'a', name: 'Galaxy Fold', platform: 'android', os: 'Android 9', browser: null, status: 'unsupported', reason: 'Excluded by contract.', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'b', name: 'Pixel 8', platform: 'android', os: null, browser: 'Opera Mini', status: 'unsupported', reason: 'No Opera Mini.', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'c', name: 'iPad', platform: 'tablet', os: null, browser: null, status: 'supported', reason: null, createdAt: '2026-09-01T00:00:00Z' },
  ];

  test('a device-wide refusal covers every browser; a browser refusal only that browser', () => {
    assert.equal(unsupportedFor(configs, 'galaxy fold', 'Safari')?.reason, 'Excluded by contract.');
    assert.equal(unsupportedFor(configs, 'Pixel 8', 'opera mini')?.reason, 'No Opera Mini.');
    assert.equal(unsupportedFor(configs, 'Pixel 8', 'Chrome'), null);
    assert.equal(unsupportedFor(configs, 'iPad', 'Safari'), null);
  });

  test('the tiles gain registered devices; a run on a refused device does not make it supported', () => {
    const tiles = deviceTiles([
      { device: 'Galaxy Fold', os: 'Android 9', browser: 'Chrome', evidenceUrl: null, failed: 0, blocked: 0, status: 'closed', executedAt: '2026-09-20T00:00:00Z' },
    ]);
    const cards = mergeDeviceCards(tiles, configs);
    const fold = cards.find((c) => c.name === 'Galaxy Fold');
    assert.equal(fold?.state, 'unsupported');
    assert.equal(fold?.reason, 'Excluded by contract.');
    assert.equal(cards.find((c) => c.name === 'iPad')?.state, 'untested', 'a registered, never-run device is untested, not tested');
    assert.equal(cards.some((c) => c.name.startsWith('Pixel 8')), true);
  });
});

describe('run evidence and release verification refuse what cannot be evidence', () => {
  const base = { projectId: uuid, runId: uuid };
  test('a screenshot, log, report or recording is a link; a note is words', () => {
    assert.equal(addRunEvidenceSchema.safeParse({ ...base, kind: 'screenshot', value: 'not a link' }).success, false);
    assert.equal(addRunEvidenceSchema.safeParse({ ...base, kind: 'screenshot', value: 'https://files.example/a.png' }).success, true);
    assert.equal(addRunEvidenceSchema.safeParse({ ...base, kind: 'note', value: 'Fails on the second attempt.' }).success, true);
    assert.equal(addRunEvidenceSchema.safeParse({ ...base, kind: 'video', value: 'https://x.example' }).success, false);
  });
  test('a partial or failed verification must say what was found', () => {
    const v = { projectId: uuid, environment: 'production', outcome: 'failed' };
    assert.equal(recordVerificationSchema.safeParse(v).success, false);
    assert.equal(recordVerificationSchema.safeParse({ ...v, notes: 'Checkout 500s.' }).success, true);
    assert.equal(recordVerificationSchema.safeParse({ ...v, outcome: 'passed' }).success, true);
  });
});

describe('announcement templates and the retry reason', () => {
  test('the four placeholders become the project, client, milestone and due date', () => {
    assert.equal(
      renderAnnouncementText('{{milestone}} done on {{project}} for {{client}} (due {{due}}) — {{milestone}}', { project: 'Northwind', client: 'Acme', milestone: 'Design approved', due: '2026-10-01' }),
      'Design approved done on Northwind for Acme (due 2026-10-01) — Design approved',
    );
  });
  test('a placeholder with no value disappears rather than printing braces', () => {
    assert.equal(renderAnnouncementText('Hello {{client}}{{project}}', {}), 'Hello ');
  });
  test('a template needs a name, a title and a body, and only two kinds exist', () => {
    const t = { name: 'Milestone', kind: 'milestone', audience: 'clients', titleTemplate: '{{milestone}}', bodyTemplate: 'Done.' };
    assert.equal(saveAnnouncementTemplateSchema.safeParse(t).success, true);
    assert.equal(saveAnnouncementTemplateSchema.safeParse({ ...t, kind: 'weekly' }).success, false);
    assert.equal(saveAnnouncementTemplateSchema.safeParse({ ...t, titleTemplate: ' ' }).success, false);
  });
  test('a delivery retry and an email resend each need a reason of at least five characters', () => {
    assert.equal(retryFailedDeliverySchema.safeParse({ messageId: uuid, reason: 'no' }).success, false);
    assert.equal(retryFailedDeliverySchema.safeParse({ messageId: uuid, reason: 'The window reopened.' }).success, true);
    assert.equal(resendEmailSchema.safeParse({ emailId: uuid, reason: '' }).success, false);
    assert.equal(resendEmailSchema.safeParse({ emailId: uuid, reason: 'SMTP is fixed.' }).success, true);
  });
  test('an email needs a real address, a subject and a body', () => {
    const e = { kind: 'client_update', to: 'client@example.com', subject: 'Update', body: 'Design is approved.' };
    assert.equal(sendCenterEmailSchema.safeParse(e).success, true);
    assert.equal(sendCenterEmailSchema.safeParse({ ...e, to: 'nobody' }).success, false);
    assert.equal(sendCenterEmailSchema.safeParse({ ...e, subject: '' }).success, false);
  });
});

// ── the email transport, against a local fake SMTP server ───────────────────
//
// The brief: email needs credentials that cannot exist locally, so the door is
// built and tested against a fake. This one speaks enough SMTP for the
// transport's session (EHLO, MAIL, RCPT, DATA, QUIT) and either accepts the
// message or refuses the recipient, so both outcomes the lane records are real.

type Fake = { server: Server; port: number; received: string[] };

function fakeSmtp(refuseRecipient: boolean): Promise<Fake> {
  const received: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      let data = false;
      let buffer = '';
      socket.write('220 fake ESMTP\r\n');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (data) {
          if (buffer.includes('\r\n.\r\n')) {
            received.push(buffer);
            buffer = '';
            data = false;
            socket.write('250 queued as FAKE123\r\n');
          }
          return;
        }
        let i: number;
        while ((i = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          if (/^EHLO/i.test(line)) socket.write('250 fake\r\n');
          else if (/^MAIL FROM/i.test(line)) socket.write('250 ok\r\n');
          else if (/^RCPT TO/i.test(line)) socket.write(refuseRecipient ? '550 mailbox unavailable\r\n' : '250 ok\r\n');
          else if (/^DATA/i.test(line)) {
            socket.write('354 go\r\n');
            data = true;
            break;
          } else if (/^QUIT/i.test(line)) {
            socket.write('221 bye\r\n');
            socket.end();
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, received }));
  });
}

describe('the email lane sends through the transport and reports the provider honestly', () => {
  const env: Record<string, unknown> = {};
  mock.module('@/lib/env', { exports: { serverEnv: () => env } });
  const fromEnv = (k: string) => (env[k] === undefined || env[k] === null ? null : String(env[k]));
  mock.module('@/lib/secrets/resolve', { exports: { secretConfigured: async () => false, resolveSecret: async (k: string) => fromEnv(k) } });

  test('an accepted message is delivered to the fake and carries its queue reference', async () => {
    const fake = await fakeSmtp(false);
    try {
      Object.assign(env, { EMAIL_FROM: 'agency@example.com', SMTP_HOST: '127.0.0.1', SMTP_PORT: fake.port, SMTP_SECURE: 'false' });
      const { sendEmail } = await import('../src/lib/email/transport.ts');
      const result = await sendEmail({ to: 'client@example.com', subject: 'Weekly update', text: 'Design is approved.' });
      assert.equal(result.ok, true);
      assert.equal(result.ok && result.kind, 'smtp');
      assert.equal(result.ok && result.messageRef, 'FAKE123');
      assert.equal(fake.received.length, 1);
    } finally {
      fake.server.close();
    }
  });

  test('a refused recipient is a failure with the provider\'s own words, not a success', async () => {
    const fake = await fakeSmtp(true);
    try {
      Object.assign(env, { EMAIL_FROM: 'agency@example.com', SMTP_HOST: '127.0.0.1', SMTP_PORT: fake.port, SMTP_SECURE: 'false' });
      const { sendEmail } = await import('../src/lib/email/transport.ts');
      const result = await sendEmail({ to: 'nobody@example.com', subject: 's', text: 'b' });
      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.reason, /550 mailbox unavailable/);
      assert.equal(fake.received.length, 0, 'nothing was delivered');
    } finally {
      fake.server.close();
    }
  });

  test('with no transport configured nothing is attempted and the reason names what to set', async () => {
    for (const k of Object.keys(env)) delete env[k];
    env.EMAIL_FROM = 'agency@example.com';
    const { emailTransportState, sendEmail } = await import('../src/lib/email/transport.ts');
    const state = await emailTransportState();
    assert.equal(state.configured, false);
    const result = await sendEmail({ to: 'client@example.com', subject: 's', text: 'b' });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /RESEND_API_KEY|SMTP_HOST/);
  });
});
