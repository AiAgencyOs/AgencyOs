import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * An inbound STOP is heard — G-222, ADM-101.
 *
 * Consent was asymmetric: `crm.record_inbound_consent` (ADM-92) granted on the
 * first inbound message, and nothing ever withdrew. A client could reply "STOP"
 * and keep being messaged, because the blocking machinery (`hasConsent`,
 * `send_outbound_message`) reads a `withdrawn` row that nothing wrote.
 *
 * These pin the decisions the migration makes. The BEHAVIOUR — that the trigger
 * actually flips a granted row to withdrawn on an inbound STOP, that a later
 * message does not re-grant, and that the send is then refused — is proved
 * against real Postgres in `scripts/verify-consent.mjs` (section on opt-out).
 * A trigger over a regex is exactly the thing that reads correct and behaves
 * otherwise, so the matcher's positives and negatives are asserted here against
 * the actual pattern text, and re-run live there.
 */

const migration = readdirSync(fileURLToPath(new URL('../supabase/migrations', import.meta.url)))
  .filter((f) => f.includes('an_inbound_stop_is_heard'))
  .map((f) => readFileSync(fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url)), 'utf8'))
  .join('\n');

describe('A. the withdrawal is a producer on the row, mirroring the grant', () => {
  test('the migration exists and defines the matcher and the trigger', () => {
    assert.ok(migration.length > 0, 'migration an_inbound_stop_is_heard not found');
    assert.match(migration, /create or replace function crm\.reads_as_opt_out/);
    assert.match(migration, /create or replace function crm\.record_inbound_opt_out/);
    assert.match(migration, /create trigger record_inbound_opt_out/);
  });

  test('it fires after insert on the message row, for client authors only', () => {
    // The same firing point and the same author gate as record_inbound_consent,
    // so a message arriving by any path is heard the same way.
    assert.match(migration, /after insert on crm\.conversation_messages/);
    assert.match(migration, /new\.author_type <> 'client'/);
  });

  test('withdrawal flips the row in place — never delete-and-insert', () => {
    // consent_reject_delete / consent_freeze_identity (20260815130000) refuse
    // delete and reparent; the forge is delete-withdrawn-then-insert-granted.
    // ON CONFLICT DO UPDATE is the only guard-safe path, and the audit trigger
    // records the UPDATE.
    assert.match(migration, /on conflict \(organization_id, contact_id, channel\) do update/);
    assert.match(migration, /set status = 'withdrawn'/);
    assert.ok(
      !/delete from crm\.communication_consent/.test(migration),
      'the migration deletes a consent row, which the forge guards refuse',
    );
  });

  test('it sends nothing back — ADM-101 silent withdraw', () => {
    // A confirmation would be an automated send to a contact who just opted
    // out, which is the shape send_outbound_message refuses. The comments name
    // that function to explain the design, so assert on an actual CALL — a
    // perform/select of a send function — not on the word appearing anywhere.
    assert.ok(
      !/(perform|select)\s+crm\.send_outbound_message/i.test(migration),
      'the opt-out path calls a send function, which ADM-101 decided against',
    );
  });

  test('a group thread is skipped — it has no single contact', () => {
    assert.match(migration, /v_contact is null/);
  });
});

/**
 * B. the matcher, positives and negatives.
 *
 * The regexes are transcribed from the migration and applied here with the same
 * flags Postgres uses (~* is case-insensitive; ~ is case-sensitive for the
 * Devanagari patterns). If the migration's pattern changes, this transcription
 * must change with it — that is deliberate, because the failure that matters is
 * a live client silenced by a false positive, and it is worth pinning twice.
 *
 * Postgres `\y` (word boundary) is JavaScript `\b`; Postgres has no lookbehind
 * needs here. The English "opt out" allows an optional separator, matching the
 * migration's `opt\s*[- ]?\s*out`.
 */
const OPT_OUT_PATTERNS: RegExp[] = [
  // Unambiguous — match anywhere.
  /\b(unsubscribe|remove\s+me|opt\s*[- ]?\s*out)\b/i,
  // Ambiguous command words — match ONLY when the whole message is the command.
  /^\s*(please\s+)?(stop|cancel|quit|end)\b(\s+(me|it|this|these|them|all|now|everything|sending|messaging|texting|contacting|messages?|msgs?|texts?|sms|notifications?|updates?|spam|please|the))*\s*[.!]*\s*$/i,
  // Hindi / Hinglish, whole-phrase.
  /\bb[a]?nd\s+k[a]?ro\b/i,
  /\b(message|msg|sms)?\s*mat\s+(bhejo|karo|kro|bhejna)\b/i,
  /\bn[a]?h?i+\s+chah?iye\b/i,
  /बंद\s*कर(ो|ें|ना)?/,
  /मत\s*भेज(ो|ें|ना)?/,
  /नहीं\s*चाहिए/,
];

const readsAsOptOut = (body: string): boolean => OPT_OUT_PATTERNS.some((p) => p.test(body));

describe('B. messages that opt out', () => {
  const positives = [
    'STOP',
    'stop',
    'Please stop',
    'stop sending me messages',
    'UNSUBSCRIBE',
    'please unsubscribe me',
    'cancel',
    'quit',
    'stop please',
    'stop messaging me',
    'cancel these messages',
    'remove me from this list',
    'opt out',
    'opt-out',
    'end',
    'please end',
    'end it',
    'stop it',
    'band karo',
    'bnd kro',
    'bhai band karo',
    'mat bhejo',
    'message mat karo',
    'msg mat bhejo',
    'nahi chahiye',
    'nhi chahiye',
    'बंद करो',
    'मत भेजो',
    'नहीं चाहिए',
  ];

  for (const body of positives) {
    test(`opts out: ${JSON.stringify(body)}`, () => {
      assert.equal(readsAsOptOut(body), true);
    });
  }
});

describe('C. messages that do NOT opt out — the false positives that silence a client', () => {
  const negatives = [
    'stopwatch',
    'non-stop delivery please',
    'I stopped by your office yesterday',
    'can you add a stop button to the app',
    'the bus stop feature is broken',
    // whole word, mid-sentence: ordinary agency requests, NOT opt-outs. These
    // are the false positives a bare whole-word match would silence a client on.
    'stop the ads for now',
    'please stop the facebook campaign',
    'cancel the meeting tomorrow',
    'can we cancel the shoot',
    'quit dragging the deadline',
    'end of month report please',
    'send me the quote',
    'recommend a plan',
    'we had a great weekend, thanks',
    'please remove the logo from the header',
    'I want to add more features',
    'chahiye — I want the premium plan', // wants it, not "nahi chahiye"
    'kab tak ho jayega',
    'thoda mat samajhna galat', // contains "mat" but not the opt-out shape
    '',
  ];

  for (const body of negatives) {
    test(`does not opt out: ${JSON.stringify(body)}`, () => {
      assert.equal(readsAsOptOut(body), false);
    });
  }
});
