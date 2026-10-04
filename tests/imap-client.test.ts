import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { after, describe, mock, test } from 'node:test';

mock.module('server-only', { exports: {} });
const { readUnseen } = await import('../src/lib/email/imap.ts');

const open: Array<() => void> = [];

/** A tiny IMAP server: just enough of the protocol for one sweep, and it records every command it was sent. */
async function fakeServer(messages: Record<number, string>, opts: { badLogin?: boolean } = {}) {
  const commands: string[] = [];
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    socket.write('* OK fake imap ready\r\n');
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString('latin1');
      let i: number;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        commands.push(line);
        const [tag, cmd = '', ...rest] = line.split(' ');
        const arg = rest.join(' ');
        if (cmd === 'LOGIN') socket.write(opts.badLogin ? `${tag} NO bad credentials\r\n` : `${tag} OK logged in\r\n`);
        else if (cmd === 'SELECT') socket.write(`* 2 EXISTS\r\n${tag} OK selected\r\n`);
        else if (cmd === 'UID' && arg.startsWith('SEARCH')) socket.write(`* SEARCH ${Object.keys(messages).join(' ')}\r\n${tag} OK done\r\n`);
        else if (cmd === 'UID' && arg.startsWith('FETCH')) {
          const uid = Number(/FETCH (\d+)/.exec(arg)?.[1]);
          const bytes = Buffer.from(messages[uid] ?? '', 'utf8');
          const text = bytes.toString('latin1');
          if (/RFC822\.SIZE/.test(arg)) socket.write(`* 1 FETCH (UID ${uid} RFC822.SIZE ${uid === 9 ? 5_000_000 : bytes.length})\r\n${tag} OK done\r\n`);
          else socket.write(Buffer.from(`* 1 FETCH (UID ${uid} BODY[] {${bytes.length}}\r\n${text})\r\n${tag} OK done\r\n`, 'latin1'));
        } else if (cmd === 'UID' && arg.startsWith('STORE')) socket.write(`${tag} OK stored\r\n`);
        else if (cmd === 'LOGOUT') socket.write(`* BYE\r\n${tag} OK bye\r\n`);
        else socket.write(`${tag} BAD unknown\r\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const handle = {
    commands,
    cfg: { host: '127.0.0.1', port, user: 'care@x.example', pass: 'pw', secure: false, timeoutMs: 3000 },
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  };
  open.push(handle.close);
  return handle;
}

describe('reading a mailbox', () => {
  after(() => { for (const c of open) c(); });
  test('each unread message is handed over byte-exact, and only a handled one is flagged seen', async () => {
    // A message whose own text contains a line that looks like the server's tagged OK: it must not end the response early.
    const tricky = 'Subject: tricky\r\n\r\nA003 OK this is the sender\'s text, not the server\'s\r\nsecond line with Unicode é\r\n';
    const srv = await fakeServer({ 1: 'Subject: one\r\n\r\nhello\r\n', 2: tricky });
    const got: Record<number, string> = {};
    const result = await readUnseen(srv.cfg, async ({ uid, raw }) => { got[uid] = raw; return uid === 1; });
    assert.deepEqual(result, { ok: true, seen: 2, handled: 1, skippedOversize: 0 });
    assert.equal(got[1], 'Subject: one\r\n\r\nhello\r\n');
    // On the wire a message is bytes; the client keeps them byte-exact (the parser decodes the charset later).
    assert.equal(got[2], Buffer.from(tricky, 'utf8').toString('latin1'));
    const stores = srv.commands.filter((c) => /STORE/.test(c));
    assert.equal(stores.length, 1, 'only the handled message is flagged');
    assert.ok(/UID STORE 1 \+FLAGS \(\\Seen\)/.test(stores[0] ?? ''));
    assert.ok(srv.commands.some((c) => /BODY\.PEEK\[\]/.test(c)), 'fetching never sets a flag by itself');
    assert.ok(!srv.commands.some((c) => /BODY\[\]/.test(c) && !/PEEK/.test(c)));
    srv.close();
  });

  test('an oversize message is skipped, counted and flagged so it is not retried forever', async () => {
    const srv = await fakeServer({ 9: 'x' });
    let called = false;
    const result = await readUnseen(srv.cfg, async () => { called = true; return true; });
    assert.deepEqual(result, { ok: true, seen: 1, handled: 0, skippedOversize: 1 });
    assert.equal(called, false);
    assert.ok(srv.commands.some((c) => /STORE 9/.test(c)));
    srv.close();
  });

  test('a refused login is a sentence, not a crash - and nothing is fetched', async () => {
    const srv = await fakeServer({ 1: 'x' }, { badLogin: true });
    const result = await readUnseen(srv.cfg, async () => true);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && /refused the login/.test(result.reason));
    assert.ok(!srv.commands.some((c) => /FETCH/.test(c)));
    srv.close();
  });

  test('an unreachable server and a non-TLS remote host are refused with a reason', async () => {
    const down = await readUnseen({ host: '127.0.0.1', port: 1, user: 'u', pass: 'p', secure: false, timeoutMs: 1000 }, async () => true);
    assert.ok(!down.ok && /Could not reach/.test(down.reason));
    const plainRemote = await readUnseen({ host: 'imap.example.com', port: 143, user: 'u', pass: 'p', secure: false }, async () => true);
    assert.ok(!plainRemote.ok && /only read over TLS/.test(plainRemote.reason));
  });
});
