import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { classifyInbound, newTextOf, parseMail } from '../src/lib/email/inbound-parse.ts';

const crlf = (s: string) => s.replace(/\n/g, '\r\n');

const plain = crlf(`From: Asha Rao <asha@client.example>
To: care@sonushah.com
Subject: Re: Your quotation
Message-ID: <abc123@mail.client.example>
In-Reply-To: <sent-1@sonushah.com>
Date: Sat, 04 Oct 2026 10:00:00 +0530
Content-Type: text/plain; charset=utf-8

Yes, please go ahead with the second option.

On Fri, 3 Oct 2026 at 18:00, Sonu <care@sonushah.com> wrote:
> Please confirm which option you prefer.
> Unsubscribe here: https://example/unsub
`);

describe('reading a received email', () => {
  test('headers, the sender address and the thread it answers', () => {
    const m = parseMail(plain);
    assert.equal(m.from, 'asha@client.example');
    assert.equal(m.messageId, 'abc123@mail.client.example');
    assert.equal(m.inReplyTo, 'sent-1@sonushah.com');
    assert.equal(m.subject, 'Re: Your quotation');
    assert.ok(m.date instanceof Date);
  });

  test('quoted-printable, base64 and an encoded subject are decoded (and Devanagari survives)', () => {
    const qp = parseMail(crlf(`From: a@b.example\nSubject: =?utf-8?B?4KSF4KSa4KWN4KSb4KS+?=\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\nCaf=C3=A9 =E0=A4=B9=E0=A5=88 soft=\nbreak\n`));
    assert.equal(qp.subject, 'अच्छा');
    assert.equal(qp.text.trim(), 'Café है softbreak');
    const b64 = parseMail(crlf(`From: a@b.example\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: base64\n\n${Buffer.from('नमस्ते, कीमत क्या है?').toString('base64')}\n`));
    assert.equal(b64.text.trim(), 'नमस्ते, कीमत क्या है?');
  });

  test('multipart/alternative prefers the text part; an HTML-only mail is reduced to its text', () => {
    const alt = parseMail(crlf(`From: a@b.example\nContent-Type: multipart/alternative; boundary="XX"\n\n--XX\nContent-Type: text/plain\n\nPLAIN WORDS\n--XX\nContent-Type: text/html\n\n<p>HTML <b>WORDS</b></p>\n--XX--\n`));
    assert.equal(alt.text.trim(), 'PLAIN WORDS');
    const html = parseMail(crlf(`From: a@b.example\nContent-Type: text/html\n\n<div>Hello&nbsp;<b>there</b></div><script>x()</script>\n`));
    assert.equal(html.text.trim(), 'Hello there');
  });

  test('only what the sender wrote is kept: the quoted thread and the "wrote:" header are cut', () => {
    const t = newTextOf(parseMail(plain).text);
    assert.equal(t, 'Yes, please go ahead with the second option.');
  });
});

describe('what kind of message it is', () => {
  test('a person\'s answer is a reply - on either lane', () => {
    assert.equal(classifyInbound(parseMail(plain), 'client').kind, 'reply');
    assert.equal(classifyInbound(parseMail(plain), 'outreach').kind, 'reply');
  });

  test('"unsubscribe" counts only when THEY wrote it, only on the outreach lane - never from our own quoted footer', () => {
    const asked = parseMail(crlf(`From: p@prospect.example\nSubject: Re: hello\nContent-Type: text/plain\n\nPlease unsubscribe me.\n\n> Our footer: to unsubscribe click here\n`));
    assert.equal(classifyInbound(asked, 'outreach').kind, 'unsubscribe');
    assert.equal(classifyInbound(asked, 'client').kind, 'reply', 'a client writing "unsubscribe" is a message for a person, not a suppression');
    const quotedOnly = parseMail(crlf(`From: p@prospect.example\nSubject: Re: hello\nContent-Type: text/plain\n\nSounds good, call me.\n\n> to unsubscribe click here\n`));
    assert.equal(classifyInbound(quotedOnly, 'outreach').kind, 'reply');
    assert.equal(classifyInbound(parseMail(crlf('From: p@x.example\nContent-Type: text/plain\n\nSTOP\n')), 'outreach').kind, 'unsubscribe');
  });

  test('a permanent delivery failure names the address that bounced; a temporary one is ignored', () => {
    const dsn = (status: string, action: string) =>
      parseMail(crlf(`From: Mail Delivery System <MAILER-DAEMON@mx.example>\nSubject: Undelivered Mail Returned to Sender\nContent-Type: multipart/report; report-type=delivery-status; boundary="BB"\n\n--BB\nContent-Type: text/plain\n\nCould not deliver.\n--BB\nContent-Type: message/delivery-status\n\nReporting-MTA: dns; mx.example\n\nFinal-Recipient: rfc822; Gone@Prospect.example\nAction: ${action}\nStatus: ${status}\n\n--BB--\n`));
    const hard = classifyInbound(dsn('5.1.1', 'failed'), 'outreach');
    assert.deepEqual(hard, { kind: 'hard_bounce', bouncedEmail: 'gone@prospect.example' });
    assert.equal(classifyInbound(dsn('4.2.2', 'delayed'), 'outreach').kind, 'auto_reply');
    assert.equal(classifyInbound(dsn('4.2.2', 'failed'), 'outreach').kind, 'auto_reply', 'a 4.x failure is mailbox-full, not a dead address');
  });

  test('out-of-office, auto-submitted and machine senders are never treated as a person answering', () => {
    for (const raw of [
      'From: a@b.example\nSubject: Automatic reply: hello\nContent-Type: text/plain\n\nI am away.\n',
      'From: a@b.example\nSubject: hi\nAuto-Submitted: auto-replied\nContent-Type: text/plain\n\nx\n',
      'From: a@b.example\nSubject: hi\nPrecedence: bulk\nContent-Type: text/plain\n\nx\n',
      'From: noreply@b.example\nSubject: hi\nContent-Type: text/plain\n\nx\n',
    ]) assert.equal(classifyInbound(parseMail(crlf(raw)), 'client').kind, 'auto_reply', raw.split('\n')[1] ?? '');
  });
});
