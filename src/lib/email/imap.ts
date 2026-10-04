import 'server-only';

import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

/**
 * Reading a mailbox - the receiving twin of the small SMTP client in transport.ts.
 *
 * One short session per sweep: connect over TLS, LOGIN, SELECT INBOX, find the UNSEEN messages, and for each one hand its full text
 * to the caller; only a message the caller says it HANDLED is flagged \Seen, so a failure leaves it for the next sweep and nothing
 * is lost. Fetching uses BODY.PEEK, which never changes a flag by itself. Not a mail library: no IDLE, no folders other than
 * INBOX, no searching - and every refusal it meets comes back as a sentence, never a pretended success.
 *
 * Plain (non-TLS) sessions exist only for a loopback host (a test server); a real mailbox is always reached over TLS.
 */

export type ImapConfig = { host: string; port: number; user: string; pass: string; secure: boolean; timeoutMs?: number };

export type MailHandler = (mail: { uid: number; raw: string }) => Promise<boolean>;

export type ReadResult = { ok: true; seen: number; handled: number; skippedOversize: number } | { ok: false; reason: string };

const LOOPBACK = /^(127\.0\.0\.1|localhost|::1)$/;
const MAX_MESSAGE_BYTES = 1_000_000;

class Session {
  private buf = Buffer.alloc(0);
  private waiting: (() => void) | null = null;
  private failure: Error | null = null;
  private n = 0;

  private readonly socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.waiting?.();
    });
    socket.on('error', (e) => {
      this.failure = e;
      this.waiting?.();
    });
    socket.on('close', () => {
      this.failure ??= new Error('The mail server closed the connection.');
      this.waiting?.();
    });
  }

  private async until(done: () => number | null): Promise<number> {
    for (;;) {
      const at = done();
      if (at !== null) return at;
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }

  async greeting(): Promise<void> {
    const end = await this.until(() => {
      const i = this.buf.indexOf('\r\n');
      return i === -1 ? null : i + 2;
    });
    const line = this.buf.subarray(0, end).toString('latin1');
    this.buf = this.buf.subarray(end);
    if (!/^\* (OK|PREAUTH)/i.test(line)) throw new Error(`The mail server did not greet us: ${line.trim().slice(0, 80)}`);
  }

  /** Sends a command and returns every untagged line (literals included, byte-exact) plus the tagged status line. */
  async command(text: string): Promise<{ body: string; status: string }> {
    const tag = `A${String((this.n += 1)).padStart(3, '0')}`;
    this.socket.write(`${tag} ${text}\r\n`);
    const end = await this.until(() => this.completeAt(tag));
    const whole = this.buf.subarray(0, end).toString('latin1');
    this.buf = this.buf.subarray(end);
    const at = whole.lastIndexOf(`${tag} `);
    return { body: whole.slice(0, at), status: whole.slice(at).trim() };
  }

  /** Where the tagged response ends - skipping literal payloads, which may contain anything, including a line that looks like a tag. */
  private completeAt(tag: string): number | null {
    const text = this.buf.toString('latin1');
    let i = 0;
    while (i < text.length) {
      const eol = text.indexOf('\r\n', i);
      if (eol === -1) return null;
      const line = text.slice(i, eol);
      if (line.startsWith(`${tag} `)) return eol + 2;
      const lit = /\{(\d+)\}$/.exec(line);
      if (lit) {
        const next = eol + 2 + Number(lit[1]);
        if (next > text.length) return null;
        // The literal's payload is followed by the rest of the same response line, ending in CRLF.
        const tail = text.indexOf('\r\n', next);
        if (tail === -1) return null;
        i = tail + 2;
      } else {
        i = eol + 2;
      }
    }
    return null;
  }

  close(): void {
    this.socket.destroy();
  }
}

const ok = (status: string) => /^A\d+ OK/i.test(status);
const quote = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;

function open(cfg: ImapConfig): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const timeout = cfg.timeoutMs ?? 20_000;
    const done = (s: Socket) => {
      s.setTimeout(timeout, () => s.destroy(new Error('The mail server did not answer in time.')));
      resolve(s);
    };
    if (cfg.secure) {
      const s = tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host }, () => done(s));
      s.once('error', reject);
    } else {
      if (!LOOPBACK.test(cfg.host)) return reject(new Error('A mailbox is only read over TLS.'));
      const s = netConnect({ host: cfg.host, port: cfg.port }, () => done(s));
      s.once('error', reject);
    }
  });
}

export async function readUnseen(cfg: ImapConfig, handle: MailHandler, limit = 25): Promise<ReadResult> {
  let socket: Socket;
  try {
    socket = await open(cfg);
  } catch (cause) {
    return { ok: false, reason: `Could not reach the mail server: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  const session = new Session(socket);
  try {
    await session.greeting();
    const login = await session.command(`LOGIN ${quote(cfg.user)} ${quote(cfg.pass)}`);
    if (!ok(login.status)) return { ok: false, reason: 'The mail server refused the login (check the mailbox address and password).' };
    const select = await session.command('SELECT INBOX');
    if (!ok(select.status)) return { ok: false, reason: 'The mail server would not open the inbox.' };
    const search = await session.command('UID SEARCH UNSEEN');
    if (!ok(search.status)) return { ok: false, reason: 'The mail server could not list unread messages.' };

    const uids = [...search.body.matchAll(/\* SEARCH([\d ]*)/g)].flatMap((m) => (m[1] ?? '').trim().split(/\s+/).filter(Boolean).map(Number)).slice(0, limit);
    let handled = 0;
    let oversize = 0;
    for (const uid of uids) {
      const size = await session.command(`UID FETCH ${uid} (RFC822.SIZE)`);
      const bytes = Number(/RFC822\.SIZE (\d+)/.exec(size.body)?.[1] ?? 0);
      if (bytes > MAX_MESSAGE_BYTES) {
        // Too large to read safely (an attachment-heavy message): flagged seen so it is not retried forever, and counted.
        await session.command(`UID STORE ${uid} +FLAGS (\\Seen)`);
        oversize += 1;
        continue;
      }
      const fetched = await session.command(`UID FETCH ${uid} (BODY.PEEK[])`);
      const lit = /BODY\[\]\s*\{(\d+)\}\r\n/.exec(fetched.body);
      if (!lit || lit.index === undefined) continue;
      const start = lit.index + lit[0].length;
      const raw = fetched.body.slice(start, start + Number(lit[1]));
      if (await handle({ uid, raw })) {
        await session.command(`UID STORE ${uid} +FLAGS (\\Seen)`);
        handled += 1;
      }
    }
    await session.command('LOGOUT').catch(() => undefined);
    return { ok: true, seen: uids.length, handled, skippedOversize: oversize };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    session.close();
  }
}
