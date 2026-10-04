/**
 * Reading a received email - pure, no I/O.
 *
 * Small on purpose, like the SMTP client: headers (with folding), multipart bodies, quoted-printable and base64, the first text part,
 * delivery-status reports and the signals that say "a machine wrote this". It is not a mail library; what it cannot read it says so
 * (`text` empty) rather than guessing, and the worker then records the message without a body instead of inventing one.
 */

export type ParsedMail = {
  messageId: string | null;
  from: string | null;
  subject: string;
  date: Date | null;
  inReplyTo: string | null;
  /** The readable text: the first text/plain part (or the HTML with its tags removed), before any reply trimming. */
  text: string;
  autoSubmitted: boolean;
  /** A delivery report: what it says happened, and to whom. */
  dsn: { action: string; status: string; recipient: string | null } | null;
};

type Headers = Map<string, string>;

function splitHeadBody(raw: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) } : { head: raw, body: '' };
}

function parseHeaders(head: string): Headers {
  const out: Headers = new Map();
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!out.has(name)) out.set(name, line.slice(i + 1).trim());
  }
  return out;
}

/** RFC 2047 encoded words in a header value (=?utf-8?B?...?= and ?Q?). */
export function decodeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, data: string) => {
    try {
      const bytes = enc.toLowerCase() === 'b' ? Buffer.from(data, 'base64') : Buffer.from(qpBytes(data.replace(/_/g, ' ')));
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch {
      return data;
    }
  });
}

function qpBytes(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of Buffer.from(c ?? '', 'utf8')) bytes.push(b);
    }
  }
  return Uint8Array.from(bytes);
}

function decodeBody(body: string, encoding: string | undefined, charset: string): string {
  const enc = (encoding ?? '7bit').toLowerCase();
  let bytes: Uint8Array;
  if (enc === 'base64') bytes = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  else if (enc === 'quoted-printable') bytes = qpBytes(body.replace(/=\r?\n/g, ''));
  else bytes = Buffer.from(body, 'latin1');
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function param(contentType: string, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(contentType);
  return m ? (m[2] ?? m[1]) : undefined;
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

type Part = { type: string; headers: Headers; text: string | null; children: Part[]; body: string };

function parsePart(raw: string, depth = 0): Part {
  const { head, body } = splitHeadBody(raw);
  const headers = parseHeaders(head);
  const contentType = headers.get('content-type') ?? 'text/plain; charset=us-ascii';
  const type = (contentType.split(';')[0] ?? 'text/plain').trim().toLowerCase();
  const part: Part = { type, headers, text: null, children: [], body };
  const boundary = param(contentType, 'boundary');
  if (type.startsWith('multipart/') && boundary && depth < 6) {
    const pieces = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`));
    part.children = pieces.slice(1).filter((p) => p.trim() !== '').map((p) => parsePart(p, depth + 1));
  } else if (type.startsWith('text/')) {
    part.text = decodeBody(body, headers.get('content-transfer-encoding'), param(contentType, 'charset') ?? 'utf-8');
  }
  return part;
}

function findFirst(part: Part, type: string): Part | null {
  if (part.type === type) return part;
  for (const c of part.children) {
    const f = findFirst(c, type);
    if (f) return f;
  }
  return null;
}

function bareAddress(value: string | undefined): string | null {
  if (!value) return null;
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(value) ?? /([^\s<>,;"']+@[^\s<>,;"']+)/.exec(value);
  return m?.[1] ? m[1].toLowerCase() : null;
}

function readDsn(root: Part): ParsedMail['dsn'] {
  if (root.type !== 'multipart/report') return null;
  const status = findFirst(root, 'message/delivery-status');
  if (!status) return null;
  // The delivery-status part's body is itself header blocks; the per-recipient block holds Final-Recipient, Action and Status.
  const blocks = status.body.split(/\r?\n\r?\n/).map(parseHeaders);
  const per = blocks.find((b) => b.has('final-recipient') || b.has('original-recipient')) ?? blocks[blocks.length - 1] ?? new Map();
  const recipientRaw = per.get('final-recipient') ?? per.get('original-recipient');
  return {
    action: (per.get('action') ?? '').toLowerCase(),
    status: (per.get('status') ?? '').trim(),
    recipient: bareAddress(recipientRaw?.replace(/^[^;]*;/, '')),
  };
}

export function parseMail(raw: string): ParsedMail {
  const root = parsePart(raw);
  const h = root.headers;
  const text = (() => {
    const plain = findFirst(root, 'text/plain');
    if (plain?.text && plain.text.trim() !== '') return plain.text;
    const html = findFirst(root, 'text/html');
    return html?.text ? stripHtml(html.text) : '';
  })();
  const date = h.get('date') ? new Date(h.get('date') as string) : null;
  const autoSubmitted = ((h.get('auto-submitted') ?? 'no').toLowerCase() !== 'no') || /bulk|junk|list|auto_reply/i.test(h.get('precedence') ?? '') || h.has('x-autoreply') || h.has('x-autorespond');
  return {
    messageId: h.get('message-id')?.replace(/^<|>$/g, '').trim() ?? null,
    from: bareAddress(h.get('from')),
    subject: decodeWords(h.get('subject') ?? ''),
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    inReplyTo: h.get('in-reply-to')?.replace(/^<|>$/g, '').trim() ?? null,
    text,
    autoSubmitted,
    dsn: readDsn(root),
  };
}

// ── classification ──

export type InboundKind = 'reply' | 'hard_bounce' | 'unsubscribe' | 'auto_reply';

export type Classified = { kind: InboundKind; bouncedEmail?: string };

const MACHINE_SENDER = /^(mailer-daemon|postmaster|no-?reply|donotreply|do-not-reply|bounce[s]?|notifications?)@/i;
const AUTO_SUBJECT = /^\s*(automatic reply|auto(matic)?[ -]?reply|autoreply|auto:|out of (the )?office|undeliverable|delivery status notification|mail delivery (failed|subsystem))/i;
const UNSUBSCRIBE = /\b(un-?subscribe|stop (sending|emailing|these|all)|remove me|take me off|do not (email|contact)|don'?t (email|contact)|opt[- ]?out)\b|^\s*stop\s*[.!]?\s*$/i;

/**
 * Only what the sender WROTE: the quoted thread, the signature separator and the "On ... wrote:" header are cut, so an
 * "unsubscribe" in OUR quoted footer is never mistaken for theirs.
 */
export function newTextOf(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*(on .{5,200} wrote:|-{2,}\s*original message\s*-{2,}|_{5,}|from:\s.+@.+|-- ?$)/i.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

export function classifyInbound(mail: ParsedMail, lane: 'client' | 'outreach'): Classified {
  if (mail.dsn) {
    const hard = mail.dsn.action === 'failed' && /^5\./.test(mail.dsn.status);
    return hard && mail.dsn.recipient ? { kind: 'hard_bounce', bouncedEmail: mail.dsn.recipient } : { kind: 'auto_reply' };
  }
  if (mail.autoSubmitted || AUTO_SUBJECT.test(mail.subject) || (mail.from !== null && MACHINE_SENDER.test(mail.from))) return { kind: 'auto_reply' };
  if (lane === 'outreach' && UNSUBSCRIBE.test(newTextOf(mail.text).slice(0, 400))) return { kind: 'unsubscribe' };
  return { kind: 'reply' };
}
