import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { describe, mock, test } from 'node:test';

import { parseProspectCsv, splitCsvLine } from '../src/modules/crm/outreach/csv.ts';
import { classifySmtpFailure, renderOutreach, unsubscribeHeaders } from '../src/modules/crm/outreach/render.ts';
import { signUnsubscribe, verifyUnsubscribe } from '../src/modules/crm/outreach/unsubscribe-token.ts';

const read = (p: string) => readFileSync(p, 'utf8');
const model = read('supabase/migrations/20261012300000_email_outreach_is_a_governed_campaign.sql');
const doors = read('supabase/migrations/20261012310000_the_outreach_doors.sql');

// Owner, 2026-10-04: info@ is for lead generation and email marketing. Governance first: suppression is permanent,
// every send passes one chokepoint, a second person approves, an unsubscribe always works, a bouncing run stops itself.

describe('the unsubscribe link', () => {
  const key = 'a-signing-key-for-the-test';
  const claim = { organizationId: '00000000-0000-4000-8000-000000000001', email: 'Asha@Example.com' };

  test('round-trips, lowercases the address, and never expires', () => {
    const token = signUnsubscribe(claim, key);
    assert.deepEqual(verifyUnsubscribe(token, key), { organizationId: claim.organizationId, email: 'asha@example.com' });
  });

  test('a changed address, a changed signature or another key is refused', () => {
    const token = signUnsubscribe(claim, key);
    const [payload, sig] = token.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ o: claim.organizationId, e: 'victim@example.com' })).toString('base64url');
    assert.equal(verifyUnsubscribe(`${forged}.${sig}`, key), null);
    assert.equal(verifyUnsubscribe(`${payload}.${sig.slice(0, -2)}xx`, key), null);
    assert.equal(verifyUnsubscribe(token, 'another-key'), null);
    assert.equal(verifyUnsubscribe('garbage', key), null);
    assert.equal(verifyUnsubscribe(token, ''), null);
  });

  test('with no key an email cannot be signed - a message with no working unsubscribe is never sent', () => {
    assert.throws(() => signUnsubscribe(claim, ''), /never be sent without a working unsubscribe/);
  });
});

describe('what leaves: the template plus the lawful frame the system adds', () => {
  const base = { subject: 'Hello {{first_name}}', body: 'Hi {{first_name}}, a note for {{company}}.\n- {{sender_name}}', firstName: 'Asha', company: 'Rao Pharmacy', senderName: 'Sonu Shah', postalAddress: '12 Example Road, Delhi 110001', unsubscribeUrl: 'https://app.example/unsubscribe/TOKEN', basis: 'b2b_legitimate_interest' as const, language: 'en' as const };

  test('fills the placeholders and always appends identity, address, the reason, and the unsubscribe link', () => {
    const r = renderOutreach(base);
    assert.equal(r.subject, 'Hello Asha');
    assert.match(r.text, /Hi Asha, a note for Rao Pharmacy\./);
    assert.match(r.text, /Sonu Shah\n12 Example Road, Delhi 110001/);
    assert.match(r.text, /publicly listed/);
    assert.match(r.text, /unsubscribe here: https:\/\/app\.example\/unsubscribe\/TOKEN/);
  });

  test('the stated reason follows the lawful basis, and never claims consent that was not given', () => {
    assert.match(renderOutreach({ ...base, basis: 'consent' }).text, /you agreed to hear from us/);
    assert.match(renderOutreach({ ...base, basis: 'existing_relationship' }).text, /worked with us or asked us/);
    assert.doesNotMatch(renderOutreach(base).text, /you agreed/);
  });

  test('missing names fall back to a polite default in the reader\'s language, and a subject can never carry a line break', () => {
    assert.match(renderOutreach({ ...base, firstName: null, company: null }).text, /Hi there, a note for your business\./);
    assert.match(renderOutreach({ ...base, firstName: null, language: 'hinglish' }).subject, /Hello ji/);
    assert.equal(renderOutreach({ ...base, subject: 'Hi\r\nBcc: x@y.z' }).subject.includes('\n'), false);
  });

  test('the footer exists in all three languages', () => {
    for (const language of ['en', 'hinglish', 'hindi'] as const) assert.match(renderOutreach({ ...base, language }).text, /https:\/\/app\.example\/unsubscribe\/TOKEN/);
  });

  test('the one-click headers (RFC 8058) are single-line and name the POST target', () => {
    const h = unsubscribeHeaders('https://app.example/api/outreach/unsubscribe/T', 'reply@example.com');
    assert.equal(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.match(h['List-Unsubscribe'] ?? '', /^<https:\/\/app\.example\/api\/outreach\/unsubscribe\/T>, <mailto:reply@example\.com\?subject=unsubscribe>$/);
    assert.doesNotMatch(JSON.stringify(h), /\\n|\\r/);
  });
});

describe('a refusal is a bounce only when the ADDRESS is dead', () => {
  test('a refused recipient is a hard bounce (suppress for good)', () => {
    assert.equal(classifySmtpFailure('The SMTP transport refused: RCPT TO:<x@y.z> → 550 5.1.1 user unknown'), 'bounced');
    assert.equal(classifySmtpFailure('RCPT TO:<x@y.z> → 553 mailbox does not exist'), 'bounced');
  });
  test('everything that may pass - a timeout, a greylist, a busy server, bad credentials - is a retry, never a suppression', () => {
    for (const r of ['no answer from smtp within 20 s', 'RCPT TO:<x@y.z> → 451 try again later', 'RCPT TO:<x@y.z> → 450 greylisted', 'AUTH LOGIN → 535 authentication failed', 'MAIL FROM:<a@b.c> → 550 sender rejected', 'the server closed the connection', 'RCPT TO:<x@y.z> → 421 too many connections']) {
      assert.equal(classifySmtpFailure(r), 'failed', r);
    }
  });
});

describe('the pasted list', () => {
  test('quoted commas and doubled quotes survive', () => {
    assert.deepEqual(splitCsvLine('a@b.co,"Rao, Asha","say ""hi"""'), ['a@b.co', 'Rao, Asha', 'say "hi"']);
  });

  test('a header row is required and email must be one of its columns', () => {
    assert.match(parseProspectCsv('only one line').problems[0]?.problem ?? '', /header row/);
    assert.match(parseProspectCsv('name,company\nAsha,Rao').problems[0]?.problem ?? '', /"email" column/);
  });

  test('every person needs a provenance (their own, or one for the list), and a basis that exists', () => {
    const r = parseProspectCsv('email,name,tags\nasha@example.com,Asha,pharmacy;delhi\nbad,Bob,\nraj@example.com,Raj,', { provenance: 'Directory, 4 Oct', lawfulBasis: 'b2b_legitimate_interest' });
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows[0]?.tags, ['pharmacy', 'delhi']);
    assert.equal(r.rows[0]?.provenance, 'Directory, 4 Oct');
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0]?.problem ?? '', /not an email address/);
    assert.match(parseProspectCsv('email\nasha@example.com').problems[0]?.problem ?? '', /how this address was obtained/);
    assert.match(parseProspectCsv('email,basis\nasha@example.com,magic', { provenance: 'x list' }).problems[0]?.problem ?? '', /unknown basis/);
  });

  test('a list over 2,000 people is refused outright', () => {
    const csv = ['email'].concat(Array.from({ length: 2001 }, (_, i) => `p${i}@example.com`)).join('\n');
    assert.match(parseProspectCsv(csv, { provenance: 'a list' }).problems[0]?.problem ?? '', /2,000/);
  });
});

describe('the database holds the line, whatever the code does', () => {
  test('suppression is permanent: no update, no delete', () => {
    assert.match(model, /before update or delete on crm\.email_suppressions[\s\S]{0,80}suppression_is_permanent|suppression_is_permanent[\s\S]{0,200}before update or delete on crm\.email_suppressions/);
    assert.match(model, /raise exception 'a suppression is permanent/);
  });

  test('a campaign is approved by someone else, a template by someone else, and an approved template is frozen', () => {
    assert.match(model, /email_campaign_four_eyes check \(approved_by is null or approved_by <> created_by\)/);
    assert.match(doors, /if v_t\.created_by = v_actor then return query select 'author_cannot_approve'/);
    assert.match(doors, /if v_c\.created_by = v_actor then return query select 'creator_cannot_approve'/);
    assert.match(model, /an approved template is not edited/);
  });

  test('a template may not state a price, name AI tooling, fake an unsubscribe line or use an unknown placeholder', () => {
    for (const rule of [/state a price, a discount or a guarantee/, /internal AI tooling/, /write the message only; the unsubscribe line/, /only use \{\{first_name\}\}, \{\{company\}\} or \{\{sender_name\}\}/]) assert.match(model, rule);
  });

  test('the owner alone can switch cold outreach on, and the default is OFF', () => {
    assert.match(model, /cold_basis_enabled\s+boolean not null default false/);
    assert.match(model, /p_cold_basis_enabled is not null and not coalesce\(\(select core\.is_owner\(\)\), false\)/);
  });

  test('the chokepoint checks every gate, in the database, before it reserves', () => {
    const start = doors.indexOf('create or replace function crm.claim_outreach_sends');
    const body = doors.slice(start, doors.indexOf('create or replace function crm.record_outreach_result', start));
    const order = ["core.org_paused(p_organization_id, 'outbound_paused')", 'sender_name is null or v_set.postal_address is null', 'crm.outreach_cap_today', 'email_suppressions', "'prospect_stopped'", 'b2b_legitimate_interest', "'no_consent'", "t.status = 'approved'", 'insert into crm.email_outreach_sends'];
    let at = -1;
    for (const needle of order) {
      const next = body.indexOf(needle, at + 1);
      assert.ok(next > at, `${needle} is missing or out of order`);
      at = next;
    }
  });

  test('a send is reserved BEFORE it is attempted: one per recipient per step', () => {
    assert.match(model, /unique \(recipient_id, step_number\)/);
    assert.match(doors, /on conflict on constraint email_outreach_sends_recipient_id_step_number_key do update/);
  });

  test('every table is closed to end-user writes; only the service role can insert', () => {
    for (const t of ['outreach_settings', 'email_suppressions', 'outreach_prospects', 'email_templates']) {
      assert.match(model, new RegExp(`revoke all on table crm\\.${t} from public, anon, authenticated`));
    }
    for (const t of ['email_campaigns', 'email_campaign_steps', 'email_campaign_recipients', 'email_outreach_sends']) assert.match(model, new RegExp(`revoke all on table crm\\.${t} from public, anon, authenticated`));
    assert.doesNotMatch(model + doors, /grant (insert|update|delete)[^;]*to[^;]*authenticated/);
  });

  test('the worker doors are callable by the service role alone', () => {
    for (const fn of ['claim_outreach_sends(uuid, int)', 'record_outreach_result(uuid, text, text, text)', 'record_unsubscribe(uuid, text, text)']) {
      assert.ok(doors.includes(`grant execute on function crm.${fn} to service_role`), fn);
    }
  });
});

describe('the sweep', () => {
  test('it is the only caller of the outreach lane, and it never touches the provider or the client mailbox', () => {
    const worker = read('src/modules/crm/outreach/worker.ts');
    assert.match(worker, /lane: 'outreach'/);
    assert.doesNotMatch(worker, /lane: 'client'|api\.resend\.com|smtp\.hostinger/);
    assert.match(worker, /claim_outreach_sends/);
    assert.match(worker, /record_outreach_result/);
    // The tick is wired.
    assert.match(read('app/api/jobs/run/route.ts'), /await runOutreach\(admin\)/);
  });

  test('the public unsubscribe changes nothing on GET', () => {
    const page = read('app/unsubscribe/[token]/page.tsx');
    assert.doesNotMatch(page, /record_unsubscribe/);
    const api = read('app/api/outreach/unsubscribe/[token]/route.ts');
    assert.match(api, /export async function POST/);
    assert.doesNotMatch(api, /export async function GET/);
  });
});

// ── the sweep, run against a fake mailbox ─────────────────────────────────────────

type Seen = { users: string[]; mailFrom: string[]; rcpt: string[]; data: string[] };

function fakeSmtp(refuse: string[] = []): Promise<{ server: Server; port: number; seen: Seen }> {
  const seen: Seen = { users: [], mailFrom: [], rcpt: [], data: [] };
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      let inData = false;
      let step: 'none' | 'user' | 'pass' = 'none';
      socket.write('220 fake\r\n');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (inData) {
          if (buffer.includes('\r\n.\r\n')) { seen.data.push(buffer); buffer = ''; inData = false; socket.write('250 queued as Q1\r\n'); }
          return;
        }
        let i: number;
        while ((i = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          if (step === 'user') { seen.users.push(Buffer.from(line, 'base64').toString()); step = 'pass'; socket.write('334 UGFzcw==\r\n'); continue; }
          if (step === 'pass') { step = 'none'; socket.write('235 ok\r\n'); continue; }
          if (/^EHLO/i.test(line)) socket.write('250-fake\r\n250 AUTH LOGIN\r\n');
          else if (/^AUTH LOGIN/i.test(line)) { step = 'user'; socket.write('334 VXNlcg==\r\n'); }
          else if (/^MAIL FROM/i.test(line)) { seen.mailFrom.push(line); socket.write('250 ok\r\n'); }
          else if (/^RCPT TO/i.test(line)) { seen.rcpt.push(line); socket.write(refuse.some((r) => line.includes(r)) ? '550 5.1.1 user unknown\r\n' : '250 ok\r\n'); }
          else if (/^DATA/i.test(line)) { socket.write('354 go\r\n'); inData = true; break; }
          else if (/^QUIT/i.test(line)) { socket.write('221 bye\r\n'); socket.end(); }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, seen }));
  });
}

describe('the sweep, end to end against a fake mailbox', () => {
  const env: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  mock.module('server-only', { exports: {} });
  mock.module('@/lib/env', { exports: { serverEnv: () => env, clientEnv: { NEXT_PUBLIC_APP_URL: 'https://app.example' } } });
  mock.module('@/lib/secrets/resolve', {
    exports: {
      secretConfigured: async (k: string) => Boolean(secrets[k] ?? env[k]),
      resolveSecret: async (k: string) => secrets[k] ?? (env[k] === undefined ? null : String(env[k])),
    },
  });

  function fakeAdmin(claims: Record<string, unknown>[], org = { timezone: 'Asia/Kolkata', settings: { outreach_window_start_hour: 0, outreach_window_end_hour: 23 } }, rules: { allowed: boolean; reason: string } | 'unreadable' = { allowed: true, reason: 'ok' }) {
    const results: { send: string; outcome: string; error: string }[] = [];
    const admin = {
      schema: (s: string) => ({
        rpc: async (fn: string, args: Record<string, unknown>) => {
          if (fn === 'orgs_with_running_email_campaigns') return { data: [{ organization_id: 'org-1' }], error: null };
          if (fn === 'p13_notification_decision') return rules === 'unreadable' ? { data: null, error: { message: 'rules unreadable' } } : { data: [rules], error: null };
          if (fn === 'claim_outreach_sends') return { data: claims, error: null };
          if (fn === 'record_outreach_result') { results.push({ send: String(args.p_send_id), outcome: String(args.p_outcome), error: String(args.p_error) }); return { data: [{ outcome: 'recorded' }], error: null }; }
          return { data: null, error: { message: `unexpected rpc ${s}.${fn}` } };
        },
        from: (t: string) => ({
          select: () => {
            const chain: Record<string, unknown> = {};
            chain.eq = () => chain;
            chain.maybeSingle = async () => ({ data: t === 'organizations' ? org : { lawful_basis: 'consent' }, error: null });
            return chain;
          },
        }),
      }),
    };
    return { admin, results };
  }

  const claim = (n: number, email: string) => ({ send_id: `s${n}`, recipient_id: `r${n}`, campaign_id: 'c1', step_number: 1, email, first_name: 'Asha', company: 'Rao Pharmacy', language: 'en', subject: 'Hello {{first_name}}', body: 'A note for {{company}}, from {{sender_name}}.', sender_name: 'Sonu Shah', postal_address: '12 Example Road, Delhi', reply_to: 'info@sonushah.com' });

  test('sends from info@ with the footer and one-click headers, records the result, and a dead address is a bounce', async () => {
    const fake = await fakeSmtp(['dead@example.com']);
    try {
      for (const k of Object.keys(env)) delete env[k];
      Object.assign(env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: fake.port, SMTP_SECURE: 'false', SMTP_USER: 'care@sonushah.com', EMAIL_FROM: 'care@sonushah.com', SMTP_OUTREACH_USER: 'info@sonushah.com', EMAIL_OUTREACH_FROM: 'info@sonushah.com', VAULT_ENCRYPTION_KEY: 'k'.repeat(32) });
      secrets.SMTP_PASS = 'care-pass';
      secrets.SMTP_OUTREACH_PASS = 'info-pass';
      const { runOutreach } = await import('../src/modules/crm/outreach/worker.ts');
      const { admin, results } = fakeAdmin([claim(1, 'asha@example.com'), claim(2, 'dead@example.com')]);
      const sweep = await runOutreach(admin as never, { now: new Date('2026-10-05T06:00:00Z') });
      assert.deepEqual({ sent: sweep.sent, bounced: sweep.bounced, failed: sweep.failed }, { sent: 1, bounced: 1, failed: 0 });
      assert.deepEqual(results.map((r) => r.outcome), ['sent', 'bounced']);
      assert.deepEqual([...new Set(fake.seen.users)], ['info@sonushah.com'], 'it logged in as info@, never care@');
      assert.ok(fake.seen.mailFrom.every((m) => m.includes('info@sonushah.com')));
      const mail = fake.seen.data[0] ?? '';
      assert.match(mail, /List-Unsubscribe: <https:\/\/app\.example\/api\/outreach\/unsubscribe\/[^>]+>, <mailto:info@sonushah\.com\?subject=unsubscribe>/);
      assert.match(mail, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
      assert.match(mail, /Reply-To: info@sonushah\.com/);
      const body = Buffer.from((mail.split('base64\r\n\r\n')[1] ?? '').split('\r\n--')[0]!.replace(/\r\n/g, ''), 'base64').toString();
      assert.match(body, /A note for Rao Pharmacy, from Sonu Shah\./);
      assert.match(body, /12 Example Road, Delhi/);
      assert.match(body, /https:\/\/app\.example\/unsubscribe\//);
    } finally {
      fake.server.close();
    }
  });

  test('P1R: the notification rules hold the sweep BEFORE the claim reserves anything (quiet hours, switched off, or unreadable)', async () => {
    for (const rules of [{ allowed: false, reason: 'quiet_hours' }, { allowed: false, reason: 'disabled' }, 'unreadable'] as const) {
      const fake = await fakeSmtp();
      try {
        for (const k of Object.keys(env)) delete env[k];
        Object.assign(env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: fake.port, SMTP_SECURE: 'false', SMTP_OUTREACH_USER: 'info@sonushah.com', EMAIL_OUTREACH_FROM: 'info@sonushah.com', VAULT_ENCRYPTION_KEY: 'k'.repeat(32) });
        secrets.SMTP_OUTREACH_PASS = 'info-pass';
        const { runOutreach } = await import('../src/modules/crm/outreach/worker.ts');
        const { admin, results } = fakeAdmin([claim(1, 'asha@example.com')], undefined, rules);
        const sweep = await runOutreach(admin as never, { now: new Date('2026-10-05T06:00:00Z') });
        assert.equal(sweep.claimed, 0, 'nothing was reserved');
        assert.match(sweep.skipped.join(), /held by the notification rules/);
        assert.equal(fake.seen.rcpt.length, 0);
        assert.equal(results.length, 0);
      } finally {
        fake.server.close();
      }
    }
  });

  test('outside the sending window nothing leaves, and the claim door is not even asked', async () => {
    const fake = await fakeSmtp();
    try {
      for (const k of Object.keys(env)) delete env[k];
      Object.assign(env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: fake.port, SMTP_SECURE: 'false', SMTP_OUTREACH_USER: 'info@sonushah.com', EMAIL_OUTREACH_FROM: 'info@sonushah.com', VAULT_ENCRYPTION_KEY: 'k'.repeat(32) });
      secrets.SMTP_OUTREACH_PASS = 'info-pass';
      const { runOutreach } = await import('../src/modules/crm/outreach/worker.ts');
      const { admin } = fakeAdmin([claim(1, 'asha@example.com')], { timezone: 'Asia/Kolkata', settings: { outreach_window_start_hour: 10, outreach_window_end_hour: 19 } });
      const sunday = await runOutreach(admin as never, { now: new Date('2026-10-04T06:00:00Z') });
      const lateNight = await runOutreach(admin as never, { now: new Date('2026-10-05T20:30:00Z') });
      assert.equal(sunday.claimed + lateNight.claimed, 0);
      assert.match(sunday.skipped.join(), /outside the sending window/);
      assert.match(lateNight.skipped.join(), /outside the sending window/);
      assert.equal(fake.seen.rcpt.length, 0);
    } finally {
      fake.server.close();
    }
  });

  test('with no outreach mailbox, or no way to sign an unsubscribe, nothing is attempted', async () => {
    for (const k of Object.keys(env)) delete env[k];
    delete secrets.SMTP_OUTREACH_PASS;
    Object.assign(env, { SMTP_HOST: '127.0.0.1', VAULT_ENCRYPTION_KEY: 'k'.repeat(32) });
    const { runOutreach } = await import('../src/modules/crm/outreach/worker.ts');
    const { admin } = fakeAdmin([claim(1, 'asha@example.com')]);
    const noMailbox = await runOutreach(admin as never, { now: new Date('2026-10-05T06:00:00Z') });
    assert.equal(noMailbox.claimed, 0);
    assert.match(noMailbox.skipped.join(), /outreach mailbox is not configured/);
    for (const k of Object.keys(env)) delete env[k];
    const noKey = await runOutreach(admin as never, { now: new Date('2026-10-05T06:00:00Z') });
    assert.match(noKey.skipped.join(), /unsubscribe link is never sent/);
  });
});

describe('the mailbox test', () => {
  const service = read('src/modules/crm/outreach/service.ts');
  const start = service.indexOf('export async function sendMailboxTest');
  const body = service.slice(start, service.indexOf('\n}\n', start) + 3);
  assert.ok(start > 0 && body.length > 200, 'the region is the whole function');

  test('only the owner can send one, and it goes through the one chokepoint on the chosen lane', () => {
    assert.match(body, /!hasRole\(context, 'owner'\)\) return err\('FORBIDDEN'/);
    assert.match(body, /await sendEmail\(\{\s*lane,/);
    assert.match(body, /lane: EmailLane = input\.lane === 'outreach' \? 'outreach' : 'client'/);
  });

  test('it records nothing: no database call, so no campaign, prospect or suppression is read or written', () => {
    assert.doesNotMatch(body, /createClient|\.rpc\(|\.from\(/);
  });

  test('the page offers it to the owner only', () => {
    const page = read('app/(internal)/communication/email-outreach/page.tsx');
    assert.match(page, /\{isOwner \? \(\s*<Card>\s*<CardHeader title="Test a mailbox"/);
  });
});
