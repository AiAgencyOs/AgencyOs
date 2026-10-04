import 'server-only';

import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

import { resolveSecret, secretConfigured } from '@/lib/secrets/resolve';

/**
 * The one way an email leaves AgencyOS — bucket F, SCR-051 "Send by email".
 *
 * Two transports, chosen by what the deployment configured (`src/lib/env`):
 * Resend's HTTP API when `RESEND_API_KEY` is set, a plain SMTP session when
 * `SMTP_HOST` is. Neither, and `emailTransportState()` says `not configured`
 * with the variables that would change that — the invoice page shows those
 * words instead of a button, and no send record is written. Nothing here
 * decides WHO may send what; the finance door does, before it calls this.
 *
 * The SMTP client is deliberately small: EHLO, STARTTLS when offered (or
 * implicit TLS on `SMTP_SECURE=true`), AUTH LOGIN when a user is set, one
 * sender, one recipient, one DATA. It is not a mail library, and it says so
 * in every refusal it returns rather than pretending a 5xx was a success.
 */

export type EmailAttachment = { filename: string; contentType: string; bytes: Uint8Array };

/**
 * Which mailbox a message leaves from. `client` (care@) carries everything a
 * client is owed: quotation, invoice, confirmation, update, delivery, handover.
 * `outreach` (info@) carries lead generation and email marketing ONLY. They are
 * separate mailboxes on purpose, and outreach never falls back to the client
 * mailbox (or the other way round): a spam complaint about a campaign must not
 * land on the mailbox that sends invoices. Omitted means `client`.
 */
export type EmailLane = 'client' | 'outreach';

export type EmailMessage = {
  lane?: EmailLane;
  to: string;
  subject: string;
  text: string;
  attachments?: EmailAttachment[];
};

export type EmailTransportState =
  | { configured: true; kind: 'resend' | 'smtp'; from: string; label: string }
  | { configured: false; reason: string };

export type EmailSendResult = { ok: true; kind: 'resend' | 'smtp'; messageRef: string | null } | { ok: false; reason: string };

const RESEND_API = 'https://api.resend.com/emails';

/**
 * Everything the mail lanes need, read through the resolver: a value set in the
 * hosting environment wins, the Keys & secrets screen is the fallback, so the
 * whole thing can be managed from the admin panel with no redeploy.
 */
async function mailConfig() {
  const [host, port, secure, user, from, outreachUser, outreachFrom] = await Promise.all([
    resolveSecret('SMTP_HOST'),
    resolveSecret('SMTP_PORT'),
    resolveSecret('SMTP_SECURE'),
    resolveSecret('SMTP_USER'),
    resolveSecret('EMAIL_FROM'),
    resolveSecret('SMTP_OUTREACH_USER'),
    resolveSecret('EMAIL_OUTREACH_FROM'),
  ]);
  return { host, port: port ? Number(port) : null, secure: secure === 'true', user, from, outreachUser, outreachFrom };
}

export async function emailTransportState(lane: EmailLane = 'client'): Promise<EmailTransportState> {
  const cfg = await mailConfig();
  if (lane === 'outreach') {
    const missing = [
      !cfg.host && 'SMTP_HOST',
      !cfg.outreachFrom && 'EMAIL_OUTREACH_FROM',
      !cfg.outreachUser && 'SMTP_OUTREACH_USER',
      !(await secretConfigured('SMTP_OUTREACH_PASS')) && 'SMTP_OUTREACH_PASS',
    ].filter(Boolean);
    if (missing.length > 0) {
      return { configured: false, reason: `The outreach mailbox is not configured (missing ${missing.join(', ')}) - set it under Security › Keys & secrets. It never borrows the client mailbox.` };
    }
    return { configured: true, kind: 'smtp', from: cfg.outreachFrom!, label: `SMTP via ${cfg.host}, outreach from ${cfg.outreachFrom}` };
  }
  if (!cfg.from) {
    return { configured: false, reason: 'EMAIL_FROM is not set - the sender address every email needs. Set it under Security › Keys & secrets.' };
  }
  if (await secretConfigured('RESEND_API_KEY')) {
    return { configured: true, kind: 'resend', from: cfg.from, label: `Resend, from ${cfg.from}` };
  }
  if (cfg.host) {
    return { configured: true, kind: 'smtp', from: cfg.from, label: `SMTP via ${cfg.host}, from ${cfg.from}` };
  }
  return { configured: false, reason: 'No email transport is configured. Set the mail server, mailbox and password under Security › Keys & secrets (or RESEND_API_KEY).' };
}

export async function sendEmail(message: EmailMessage): Promise<EmailSendResult> {
  const lane = message.lane ?? 'client';
  const state = await emailTransportState(lane);
  if (!state.configured) return { ok: false, reason: state.reason };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.to)) return { ok: false, reason: `"${message.to}" is not an email address.` };

  try {
    return state.kind === 'resend' ? await sendViaResend(state.from, message) : await sendViaSmtp(state.from, message, lane);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.error(JSON.stringify({ level: 'error', scope: 'sendEmail', kind: state.kind, detail }));
    return { ok: false, reason: `The ${state.kind === 'resend' ? 'Resend' : 'SMTP'} transport refused: ${detail}` };
  }
}

// ── Resend ──────────────────────────────────────────────────────────────────

async function sendViaResend(from: string, message: EmailMessage): Promise<EmailSendResult> {
  const apiKey = await resolveSecret('RESEND_API_KEY');
  const response = await fetch(RESEND_API, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      attachments: (message.attachments ?? []).map((a) => ({ filename: a.filename, content: Buffer.from(a.bytes).toString('base64') })),
    }),
  });
  const body = (await response.json().catch(() => null)) as { id?: string; message?: string; name?: string } | null;
  if (!response.ok) {
    return { ok: false, reason: `Resend answered ${response.status}${body?.message ? `: ${body.message}` : ''}` };
  }
  return { ok: true, kind: 'resend', messageRef: body?.id ?? null };
}

// ── SMTP ────────────────────────────────────────────────────────────────────

type Line = { code: number; text: string; extended: boolean };

class SmtpSession {
  private socket: Socket;
  private buffer = '';
  private waiters: ((line: Line[]) => void)[] = [];
  private pending: Line[] = [];
  private closed: string | null = null;

  constructor(socket: Socket) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: Socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (e: Error) => this.fail(e.message));
    socket.on('close', () => this.fail('the server closed the connection'));
  }

  private fail(reason: string) {
    if (this.closed) return;
    this.closed = reason;
    for (const w of this.waiters.splice(0)) w([{ code: 0, text: reason, extended: false }]);
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\r\n')) >= 0) {
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      const match = /^(\d{3})([ -])(.*)$/.exec(raw);
      if (!match) continue;
      this.pending.push({ code: Number(match[1]), text: match[3] ?? '', extended: match[2] === '-' });
      if (match[2] === ' ') {
        const reply = this.pending.splice(0);
        const waiter = this.waiters.shift();
        if (waiter) waiter(reply);
      }
    }
  }

  read(): Promise<Line[]> {
    if (this.closed) return Promise.resolve([{ code: 0, text: this.closed, extended: false }]);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async command(line: string, expect: number[]): Promise<Line[]> {
    this.socket.write(`${line}\r\n`);
    const reply = await this.read();
    const code = reply[reply.length - 1]?.code ?? 0;
    if (!expect.includes(code)) {
      const shown = line.startsWith('AUTH') || /^[A-Za-z0-9+/=]+$/.test(line) ? '(credentials)' : line;
      throw new Error(`${shown} → ${code} ${reply.map((l) => l.text).join(' ')}`.trim());
    }
    return reply;
  }

  async upgrade(host: string): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');
    const secure = tlsConnect({ socket: plain, servername: host });
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', () => resolve());
      secure.once('error', reject);
    });
    this.attach(secure);
  }

  end() {
    this.socket.end();
  }
}

function mime(from: string, message: EmailMessage): string {
  const boundary = `----agencyos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const headers = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: =?UTF-8?B?${Buffer.from(message.subject, 'utf8').toString('base64')}?=`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(Buffer.from(message.text, 'utf8').toString('base64'))}`,
    ...(message.attachments ?? []).map(
      (a) =>
        `--${boundary}\r\nContent-Type: ${a.contentType}; name="${a.filename}"\r\nContent-Disposition: attachment; filename="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(Buffer.from(a.bytes).toString('base64'))}`,
    ),
  ];
  const body = `${parts.join('\r\n')}\r\n--${boundary}--\r\n`;
  // Dot-stuffing: a line that is exactly "." would end DATA early.
  return `${headers.join('\r\n')}\r\n\r\n${body}`.replace(/\r\n\./g, '\r\n..');
}

function wrap(base64: string): string {
  return base64.replace(/(.{76})/g, '$1\r\n');
}

async function sendViaSmtp(from: string, message: EmailMessage, lane: EmailLane): Promise<EmailSendResult> {
  const cfg = await mailConfig();
  const smtpUser = lane === 'outreach' ? cfg.outreachUser : cfg.user;
  const smtpPass = (lane === 'outreach' ? await resolveSecret('SMTP_OUTREACH_PASS') : await resolveSecret('SMTP_PASS')) ?? '';
  const host = cfg.host!;
  const secure = cfg.secure;
  const port = cfg.port ?? (secure ? 465 : 587);

  const socket: Socket = await new Promise((resolve, reject) => {
    const s = secure ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
    s.setTimeout(20_000, () => {
      s.destroy();
      reject(new Error(`no answer from ${host}:${port} within 20 s`));
    });
    s.once('error', reject);
    s.once(secure ? 'secureConnect' : 'connect', () => resolve(s as Socket));
  });

  const session = new SmtpSession(socket);
  try {
    const greeting = await session.read();
    if (greeting[greeting.length - 1]?.code !== 220) throw new Error(`greeting was ${greeting.map((l) => `${l.code} ${l.text}`).join(' ')}`);

    let ehlo = await session.command('EHLO agencyos.local', [250]);
    if (!secure && ehlo.some((l) => /^STARTTLS/i.test(l.text))) {
      await session.command('STARTTLS', [220]);
      await session.upgrade(host);
      ehlo = await session.command('EHLO agencyos.local', [250]);
    }

    if (smtpUser) {
      const offersLogin = ehlo.some((l) => /^AUTH\b.*\bLOGIN\b/i.test(l.text));
      const offersPlain = ehlo.some((l) => /^AUTH\b.*\bPLAIN\b/i.test(l.text));
      if (offersLogin || !offersPlain) {
        await session.command('AUTH LOGIN', [334]);
        await session.command(Buffer.from(smtpUser, 'utf8').toString('base64'), [334]);
        await session.command(Buffer.from(smtpPass, 'utf8').toString('base64'), [235]);
      } else {
        const token = Buffer.from(`\0${smtpUser}\0${smtpPass}`, 'utf8').toString('base64');
        await session.command(`AUTH PLAIN ${token}`, [235]);
      }
    }

    await session.command(`MAIL FROM:<${from}>`, [250]);
    await session.command(`RCPT TO:<${message.to}>`, [250, 251]);
    await session.command('DATA', [354]);
    const accepted = await session.command(`${mime(from, message)}\r\n.`, [250]);
    const ref = /queued as ([^\s]+)/i.exec(accepted[accepted.length - 1]?.text ?? '')?.[1] ?? null;
    await session.command('QUIT', [221]).catch(() => undefined);
    return { ok: true, kind: 'smtp', messageRef: ref };
  } finally {
    session.end();
  }
}
