import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { imageReadingSchema, redactLongDigitRuns } from '../src/modules/crm/schema.ts';
import {
  deliveryOf,
  readingIsTheirWords,
  transcriptContent,
  transcriptForModel,
} from '../src/modules/crm/types.ts';
import { parseDelivery } from '../src/lib/whatsapp/payload.ts';
import { HANDLER_JOB_KIND, subscribersFor } from '../src/lib/events/catalog.ts';
import { sqlCode } from './_code-only.ts';
import { RUNNER_SOURCE } from './_runner-source.ts';

/**
 * A client's image, from the wire to the transcript — brief 2026-08-22 §28/§29.
 *
 * The instruction has two halves and they pull in opposite directions:
 *
 *   "Do not say 'Not transcribed' if the system actually has the capability to
 *    inspect the image."
 *   "If image understanding is unavailable: do not pretend."
 *
 * A system that satisfies one by a rule and the other by a different rule can
 * drift into satisfying neither. Here both come from a single fact — whether a
 * description exists — which is why the tests below can check them together.
 */

// `media.ts` reaches serverEnv(), which pulls in @/lib/env and its eager parse
// of the public variables. Placeholders, set before the dynamic import below;
// nothing here reaches a network.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';

const { mediaUrlIsAllowed, maxBytesFor, bareMediaType, MAX_IMAGE_BYTES, MAX_AUDIO_BYTES } =
  await import('../src/lib/whatsapp/media.ts');

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

/**
 * One feature, two migrations, read as one.
 *
 * The first brought the columns, the freeze and the ordering; the second
 * widened the ordering to a recording and renamed what had become a lie. A
 * test that read only the newer file would report the freeze missing, which is
 * a fact about which file it opened rather than about the database.
 */
const MIGRATION = [
  'supabase/migrations/20260823120000_an_image_is_read_before_it_is_answered.sql',
  'supabase/migrations/20260823130000_a_voice_note_is_words_somebody_said.sql',
].map(read).join('\n');

describe('A. the door records what a reading will need', () => {
  const delivery = (message: Record<string, unknown>) =>
    parseDelivery({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: { metadata: { phone_number_id: '123' }, messages: [message] },
            },
          ],
        },
      ],
    });

  test('an image carries its handle, without which nothing can ever look at it', () => {
    const { messages } = delivery({
      from: '919000000000',
      id: 'wamid.1',
      type: 'image',
      image: { id: 'media-abc', mime_type: 'image/jpeg' },
    });
    assert.equal(messages[0]?.mediaType, 'image');
    assert.equal(messages[0]?.mediaId, 'media-abc');
  });

  test('the caption is the client speaking, and it used to be thrown away', () => {
    const { messages } = delivery({
      from: '919000000000',
      id: 'wamid.2',
      type: 'image',
      image: { id: 'media-abc', caption: 'isme jo login screen hai wo chahiye' },
    });
    assert.equal(messages[0]?.caption, 'isme jo login screen hai wo chahiye');
    // Still not the body: the row constraint says a media message carries none,
    // and a caption is neither the file nor a transcription of it.
    assert.equal(messages[0]?.body, '');
  });

  test('a kind with no file — a location — carries neither, and is not invented', () => {
    const { messages } = delivery({
      from: '919000000000',
      id: 'wamid.3',
      type: 'location',
      location: { latitude: 1, longitude: 2 },
    });
    assert.equal(messages[0]?.mediaType, 'location');
    assert.equal(messages[0]?.mediaId, undefined);
    assert.equal(messages[0]?.caption, undefined);
  });

  test('a text message is untouched — no handle, no caption, a body', () => {
    const { messages } = delivery({
      from: '919000000000',
      id: 'wamid.4',
      type: 'text',
      text: { body: 'hello' },
    });
    assert.equal(messages[0]?.body, 'hello');
    assert.equal(messages[0]?.mediaType, undefined);
    assert.equal(messages[0]?.mediaId, undefined);
  });
});

describe('B. the transcript says exactly what happened, in both directions', () => {
  test('an image nobody looked at still says so', () => {
    assert.equal(transcriptContent('', 'image'), '[photo — not transcribed]');
    assert.equal(
      transcriptContent('', 'image', { description: null }),
      '[photo — not transcribed]',
    );
  });

  test('an image that WAS read says what was seen, attributed', () => {
    const line = transcriptContent('', 'image', { description: 'a login screen with a blue button' });
    assert.equal(line, '[photo — read by the agent: a login screen with a blue button]');
    // The one thing it must never do: present a machine's reading as the
    // client's own words, which a later reader could not tell apart.
    assert.ok(line.includes('read by the agent'), 'the reading must be attributed');
    assert.doesNotMatch(line, /not transcribed/);
  });

  test('the caption is quoted as theirs, whether or not the file could be read', () => {
    assert.equal(
      transcriptContent('', 'image', { caption: 'yeh wala design chahiye' }),
      '[photo, captioned “yeh wala design chahiye” — not transcribed]',
    );
    assert.equal(
      transcriptContent('', 'image', { caption: 'yeh wala', description: 'a dashboard' }),
      '[photo, captioned “yeh wala” — read by the agent: a dashboard]',
    );
  });

  test('a voice note nobody heard still says so', () => {
    assert.equal(
      transcriptContent('', 'audio', { description: null }),
      '[voice note — not transcribed]',
    );
  });

  /**
   * The distinction that is not cosmetic.
   *
   * A description of a photograph is the AGENT'S sentence about what it saw,
   * so the transcript attributes it. A transcript is what the CLIENT said,
   * written down, so it is quoted — and labelled `transcribed`, because a
   * recording can be misheard and the audio in WhatsApp is still the original.
   */
  test('a voice note that WAS heard is quoted as theirs, not attributed to the agent', () => {
    const line = transcriptContent('', 'audio', { description: 'mujhe delivery app banwana hai' });
    assert.equal(line, '[voice note, transcribed: “mujhe delivery app banwana hai”]');
    assert.doesNotMatch(line, /read by the agent/, 'their words are not the agent\'s reading');
  });

  test('and the two are told apart by one function, asked in both places', () => {
    assert.equal(readingIsTheirWords('audio'), true);
    assert.equal(readingIsTheirWords('image'), false);
    assert.equal(readingIsTheirWords(null), false);
  });

  test('text is text, and a description cannot displace it', () => {
    assert.equal(
      transcriptContent('Mujhe app chahiye', null, { description: 'ignored' }),
      'Mujhe app chahiye',
    );
  });

  test('the whole document carries the reading through', () => {
    const doc = transcriptForModel([
      { author_type: 'client', body: 'dekho', metadata: {}, media_description: null },
      {
        author_type: 'client',
        body: '',
        metadata: { media_type: 'image', caption: 'aisa hi' },
        media_description: 'a food delivery app home screen',
      },
    ]);
    assert.equal(
      doc,
      'Client: dekho\nClient: [photo, captioned “aisa hi” — read by the agent: a food delivery app home screen]',
    );
  });

  test('the caption and the handle are read out of metadata, defensively', () => {
    assert.equal(deliveryOf({ caption: '  spaced  ' }).caption, 'spaced');
    assert.equal(deliveryOf({ caption: '   ' }).caption, null);
    assert.equal(deliveryOf({ caption: 42 }).caption, null);
    assert.equal(deliveryOf({ media_id: 'abc' }).mediaId, 'abc');
    assert.equal(deliveryOf({}).mediaId, null);
  });
});

describe('C. the fetch will not send its token wherever it is told to', () => {
  const GRAPH = 'https://graph.facebook.com/v21.0';

  test('Meta’s own media hosts are allowed', () => {
    assert.equal(mediaUrlIsAllowed('https://lookaside.fbsbx.com/whatsapp/x', GRAPH), true);
    assert.equal(mediaUrlIsAllowed('https://scontent.xx.fbcdn.net/v/t1', GRAPH), true);
  });

  test('the configured base is allowed, which is what makes a local stub work', () => {
    assert.equal(mediaUrlIsAllowed('http://127.0.0.1:54398/media/1', 'http://127.0.0.1:54398'), true);
    // …and only that base. A stub on one port does not open every port.
    assert.equal(mediaUrlIsAllowed('http://127.0.0.1:9999/media/1', 'http://127.0.0.1:54398'), false);
  });

  test('anywhere else is refused — this is an authenticated server-side fetch', () => {
    assert.equal(mediaUrlIsAllowed('https://evil.example/steal', GRAPH), false);
    assert.equal(mediaUrlIsAllowed('http://169.254.169.254/latest/meta-data/', GRAPH), false);
    assert.equal(mediaUrlIsAllowed('http://localhost:5432/', GRAPH), false);
    assert.equal(mediaUrlIsAllowed('file:///etc/passwd', GRAPH), false);
    assert.equal(mediaUrlIsAllowed('not a url', GRAPH), false);
  });

  test('a lookalike host does not pass — the suffix is a suffix, not a substring', () => {
    assert.equal(mediaUrlIsAllowed('https://lookaside.fbsbx.com.evil.example/x', GRAPH), false);
    assert.equal(mediaUrlIsAllowed('https://evil.example/?x=.fbcdn.net', GRAPH), false);
  });

  test('http is refused even on an allowed host — the token would be in clear', () => {
    assert.equal(mediaUrlIsAllowed('http://lookaside.fbsbx.com/whatsapp/x', GRAPH), false);
  });

  test('the size ceiling leaves room for base64, which inflates by a third', () => {
    assert.ok(MAX_IMAGE_BYTES * (4 / 3) < 5_000_000, 'base64 of the ceiling must fit a 5 MB limit');
  });

  test('a recording gets its own, larger ceiling — nothing base64s a voice note', () => {
    assert.ok(MAX_AUDIO_BYTES > MAX_IMAGE_BYTES);
    assert.equal(maxBytesFor('image'), MAX_IMAGE_BYTES);
    assert.equal(maxBytesFor('audio'), MAX_AUDIO_BYTES);
  });

  test('the codec parameter is not the format — audio/ogg; codecs=opus is audio/ogg', () => {
    assert.equal(bareMediaType('audio/ogg; codecs=opus'), 'audio/ogg');
    assert.equal(bareMediaType('image/jpeg'), 'image/jpeg');
    assert.equal(bareMediaType(undefined), '');
  });
});

describe('D. what a reading may contain, and what it may never', () => {
  test('a description and the language of the words in it', () => {
    const parsed = imageReadingSchema.safeParse({
      description: 'a handwritten list of features',
      textLanguage: 'hi-en',
    });
    assert.equal(parsed.success, true);
  });

  test('no words in the image is null, not a guess at English', () => {
    assert.equal(imageReadingSchema.safeParse({ description: 'a photo of an office', textLanguage: null }).success, true);
  });

  /**
   * The absence is the control. A model that could return a suggested status,
   * a requirement or a price would be a model deciding something from a
   * photograph — and a client's most common attachment is a competitor's
   * pricing page, where reading a number and treating it as ours breaks
   * ADM-22 by way of a screenshot.
   */
  test('there is no field a reading could act through', () => {
    for (const field of ['status', 'price', 'amount', 'requirement', 'suggestedStatus', 'nextStep']) {
      assert.equal(
        imageReadingSchema.safeParse({ description: 'x', textLanguage: null, [field]: 'anything' })
          .success,
        false,
        `${field} must not be accepted`,
      );
    }
  });

  test('an empty description is refused — say what you see or say you cannot', () => {
    assert.equal(imageReadingSchema.safeParse({ description: '   ', textLanguage: null }).success, false);
  });
});

describe('E. a number long enough to be an account number is not written down', () => {
  test('a card number is removed however it is spaced', () => {
    assert.equal(
      redactLongDigitRuns('the screenshot shows 4111 1111 1111 1111 on a bank page'),
      'the screenshot shows [number removed] on a bank page',
    );
    assert.equal(redactLongDigitRuns('account 123456789012345'), 'account [number removed]');
  });

  test('the things that are not account numbers survive', () => {
    for (const kept of [
      'a 2026 launch',
      'they want 500 users',
      'the OTP field shows 6 digits',
      'phone 9000000000 on the contact page',
      'version 1.2.3',
    ]) {
      assert.equal(redactLongDigitRuns(kept), kept, `must not redact: ${kept}`);
    }
  });

  test('it cannot fail — redaction returns a string for anything', () => {
    assert.equal(redactLongDigitRuns(''), '');
    assert.equal(typeof redactLongDigitRuns('1'.repeat(400)), 'string');
  });
});

describe('F. the ordering rule lives in one condition', () => {
  const code = sqlCode(MIGRATION);

  /**
   * The LAST definition, never the first.
   *
   * Two migrations define `emit_message_received`, and the live one is the
   * later. Reading the first is how a red-proof in this session silently did
   * not run: the guard had been carried forward by the very change under test,
   * so mangling the older copy removed nothing at all.
   */
  const liveBody = (name: string) => {
    // Anchored on the DEFINITION, not on any mention: `execute function
    // crm.x()` on a trigger is a later occurrence of the same name and holds
    // no body at all.
    const at = code.lastIndexOf(`create or replace function crm.${name}`);
    assert.ok(at > 0, `no definition of crm.${name}`);
    const rest = code.slice(at);
    return rest.slice(0, rest.indexOf('$$;'));
  };

  test('the three deferrals ask the same function', () => {
    const asks = [...code.matchAll(/crm\.awaits_media_reading\(/g)].length;
    assert.ok(asks >= 4, `expected the definition and three callers, found ${asks}`);
    for (const fn of ['emit_message_received', 'emit_reply_due', 'emit_media_received']) {
      assert.match(liveBody(`${fn}()`), /awaits_media_reading/, `${fn} must ask it`);
    }
  });

  test('it refuses to hold a message whose file nobody could fetch', () => {
    assert.match(liveBody('awaits_media_reading'), /media_id/);
  });

  test('and only the two kinds anything here can actually read', () => {
    const body = liveBody('awaits_media_reading');
    assert.match(body, /'image', 'audio'/);
    for (const unreadable of ['video', 'document', 'sticker', 'location']) {
      assert.doesNotMatch(body, new RegExp(`'${unreadable}'`), `${unreadable} must hold nothing back`);
    }
  });

  test('the reading is written once, at the row', () => {
    assert.match(code, /create trigger freeze_message_media_reading/);
    assert.match(code, /before update of media_read_at, media_description/);
  });

  test('the release fires on the transition, not on every update', () => {
    assert.match(liveBody('emit_media_read()'), /old\.media_read_at is not null or new\.media_read_at is null/);
  });

  test('the names that became lies are gone, not left beside the new ones', () => {
    // A function nothing calls is a function somebody will call, and two
    // conditions that must agree are the defect this codebase keeps finding.
    for (const dropped of ['awaits_image_reading', 'emit_image_received()', 'emit_image_read()']) {
      assert.match(code, new RegExp(`drop function if exists crm\\.${dropped.replace('()', '\\(')}`),
        `crm.${dropped} must be dropped`);
    }
  });

  test('extraction is queued only when there is something to extract', () => {
    const slice = liveBody('emit_media_read()');
    const queue = slice.indexOf("'requirement.extract'");
    assert.ok(queue > 0, 'the extraction must be queued here');
    assert.ok(
      slice.lastIndexOf('media_description is not null', queue) > 0,
      'and only behind a description',
    );
  });

  test('no image bytes are stored anywhere — there is no column for one', () => {
    assert.doesNotMatch(code, /media_bytes|media_blob|image_data|storage\.objects/);
  });
});

describe('G. the workflow, and the state in which nobody is answered', () => {
  const source = RUNNER_SOURCE;

  test('it is registered, on the sales agent, as internal work', () => {
    assert.equal(HANDLER_JOB_KIND['sales:readMedia'], 'message.describe');
    assert.deepEqual(subscribersFor('image.received'), ['sales:readMedia']);
    const slice = source.slice(source.indexOf('const MEDIA_READ'));
    assert.match(slice.slice(0, 900), /agentKey: 'sales'/);
    assert.match(slice.slice(0, 900), /workClass: 'internal_plan'/);
  });

  /**
   * The failure that would be worst, and the one the design is arranged around.
   *
   * `media_read_at` is what releases the reply. A job that dies without ever
   * setting it makes a client's photograph the reason nobody answered them —
   * a silence caused by failing to read a picture, which is far worse than
   * answering without having read it.
   */
  test('a permanent failure and a last attempt both release the conversation', () => {
    const slice = source.slice(source.indexOf('const MEDIA_READ'));
    const body = slice.slice(0, slice.indexOf('\n};'));
    assert.match(body, /const lastAttempt = job\.attempts \+ 1 >= job\.max_attempts/);
    assert.match(body, /if \(fetched\.permanent \|\| lastAttempt\)/);
    assert.match(body, /if \(call\.kind === 'no_provider' \|\| lastAttempt\)/);
    // …and each of those three — the fetch that will never work, the provider
    // that cannot read images, and the answer that did not validate — releases
    // with NO description, so the transcript says "not transcribed", which is
    // the truth.
    assert.equal((body.match(/await markRead\(null\)/g) ?? []).length, 3);
    // The one remaining failure is the write itself, which has no release
    // because writing null would fail for the same reason.
    assert.match(body, /const detail = 'the reading could not be saved'/);
  });

  test('the reading is redacted before it is written, not after', () => {
    const slice = source.slice(source.indexOf('const MEDIA_READ'));
    const body = slice.slice(0, slice.indexOf('\n};'));
    const redact = body.indexOf('redactLongDigitRuns(validated.data.description)');
    const write = body.indexOf('markRead(description)');
    assert.ok(redact > 0 && write > redact, 'redaction must precede the write');
  });

  /**
   * The defect the owner's first real image found.
   *
   * A failed fetch cost no run row, as an economy — and what it bought was a
   * system that knew exactly why it could not read a client's image and
   * recorded it nowhere a person could look. The reason was inferable only
   * from a different job's `last_error` a minute later.
   */
  test('every attempt to read an image leaves a row saying how it went', () => {
    const slice = source.slice(source.indexOf('const MEDIA_READ'));
    const body = slice.slice(0, slice.indexOf('\n};'));
    const open = body.indexOf('const runId = await openRun');
    const fetchAt = body.indexOf('await fetchWhatsAppMedia');
    assert.ok(open > 0 && fetchAt > open, 'the run must be opened before the fetch, not after it');
    assert.match(body, /await finishRun\(admin, runId, 'failed', fetched\.message\)/);
  });

  test('the bytes are not put in the run record', () => {
    const slice = source.slice(source.indexOf('const MEDIA_READ'));
    const body = slice.slice(0, slice.indexOf('\n};'));
    // The two places a run's own record is written: what it started from and
    // what it produced. Neither may carry the picture.
    const opened = body.slice(body.indexOf('await openRun('), body.indexOf('await fetchWhatsAppMedia'));
    const finished = body.slice(body.indexOf('await succeedRun('));
    for (const [where, text] of [['openRun', opened], ['succeedRun', finished]]) {
      assert.doesNotMatch(text!, /dataBase64/, `${where} must not record the bytes`);
    }
    // What IS recorded is how big it was and what type — enough to reconcile a
    // cost, and not the picture.
    assert.match(finished, /byteLength: fetched\.byteLength/);
  });

  /**
   * A photograph has no language, and saying it does is not free.
   *
   * `crm.maintain_preferred_language` writes `crm.contacts.preferred_language`
   * from the FIRST message that carries one and never again. A client whose
   * opening message is a caption-less screenshot would therefore be answered
   * in the language of the agent's own description — English — for the life of
   * the relationship. Found on production, where a screenshot came back
   * tagged `en`.
   */
  test('a message with no words of the client’s own can report no language', async () => {
    const { messageIntentSchema } = await import('../src/modules/crm/schema.ts');
    const base = { intent: 'requirement_sharing', quote: 'sent a screenshot', clientFact: null };
    assert.equal(messageIntentSchema.safeParse({ ...base, language: null }).success, true);
    assert.equal(messageIntentSchema.safeParse({ ...base, language: 'hi-en' }).success, true);
    // …and it is still a tag when there is one. Nullable is not unconstrained.
    assert.equal(messageIntentSchema.safeParse({ ...base, language: 'Hinglish' }).success, false);
  });

  test('the intent read is told which words are the client’s own', () => {
    const slice = source.slice(source.indexOf('function clientTurn'));
    const body = slice.slice(0, slice.indexOf('\n}\n'));
    assert.match(body, /media\.caption/, 'a caption IS the client writing');
    // And a transcript is too — they spoke instead of typing. A description of
    // a photograph is not, and `readingIsTheirWords` owns that one distinction
    // for both this and the transcript renderer.
    assert.match(body, /readingIsTheirWords\(media\.mediaKind\)/);
    assert.match(body, /They used no words at all/);
    // And the workflow uses it rather than the transcript line alone, which is
    // what conflated "what this means" with "what language they wrote in".
    assert.match(source, /content: clientTurn\(message\)/);
  });

  test('the prompt asks for the language of the words, never assuming English', () => {
    const prompt = source.slice(source.indexOf('const IMAGE_PROMPT'), source.indexOf('const MEDIA_READ'));
    assert.match(prompt, /Do not assume that language is English/);
    assert.match(prompt, /Hinglish/);
    assert.match(prompt, /DO NOT copy a card number/);
    assert.match(prompt, /DO NOT decide anything/);
  });

  test('and the intent prompt says a photograph has no language of its own', () => {
    const prompt = source.slice(source.indexOf('const INTENT_PROMPT'), source.indexOf('const MESSAGE_INTENT'));
    assert.match(prompt, /a photograph with no caption — the language is null/);
    assert.match(prompt, /not theirs/);
  });
});

/**
 * H. speech to text — ADM-94, Doc 08 §9.
 *
 * `20260821120000` deferred this with three reasons: no provider, no decision
 * about which, and no rule for what an uncertain transcript may be used for.
 * The rule is the one the image established and these tests already cover —
 * a reading lives in its own column and the transcript says whose words it is.
 * What is asserted here is the part that is genuinely new: a third capability,
 * kept out of the generation port on purpose, and inert without a key.
 */
describe('H. hearing is a third capability, and its own decision', () => {
  const routerSource = read('src/lib/ai/router.ts');
  const typesSource = read('src/lib/ai/types.ts');
  const openaiSource = read('src/lib/ai/openai.ts');

  /**
   * ADM-84 §5: *"generation and embeddings are different capabilities"*, and a
   * vendor named for one is not thereby chosen for another. Transcription is a
   * third. Folding it into `AiProvider` would make Anthropic — which cannot
   * hear anything — look like a candidate for it.
   */
  test('AiProvider cannot be asked to transcribe', () => {
    const provider = typesSource.slice(typesSource.indexOf('export interface AiProvider'));
    assert.doesNotMatch(provider.slice(0, provider.indexOf('}')), /transcribe/);
    assert.match(typesSource, /export interface AiTranscriber/);
  });

  test('and it has its own registry, so a generation model can never resolve to it', () => {
    assert.match(routerSource, /export function resolveTranscriber/);
    const resolve = routerSource.slice(routerSource.indexOf('export function resolveProvider'));
    assert.doesNotMatch(resolve.slice(0, resolve.indexOf('\n}')), /ranscrib/);
  });

  test('no key, no transcriber — a deployment without one behaves as it did before', () => {
    assert.match(openaiSource, /const key = apiKey\(\);\n {2}if \(!key\) return null;/);
    assert.match(routerSource, /No transcription service is configured/);
  });

  test('the recording is uploaded, never base64ed and never written down', () => {
    assert.match(openaiSource, /new Blob\(/);
    assert.doesNotMatch(openaiSource, /toString\('base64'\)/);
    // Nothing writes the bytes anywhere: the step trace records a byte count.
    const runner = RUNNER_SOURCE.slice(RUNNER_SOURCE.indexOf('async function hear'));
    const body = runner.slice(0, runner.indexOf('\n}\n'));
    assert.doesNotMatch(body.slice(body.indexOf('recordModelCall')), /audio\.bytes/);
    assert.match(body, /audio\/\$\{audio\.byteLength\} bytes/);
  });

  test('a transcription service error never leaks the key', () => {
    assert.match(openaiSource, /function redactSecrets/);
    const log = openaiSource.slice(openaiSource.indexOf("scope: 'openai.transcribe'"));
    assert.match(log.slice(0, 300), /redactSecrets\(/);
  });

  test('silence is an error, not an empty transcript', () => {
    assert.match(openaiSource, /Nothing could be made out in the recording/);
    // Writing an empty one would say the client said nothing. They did speak.
    assert.doesNotMatch(openaiSource, /text: ''/);
  });

  test('a language the column would refuse becomes null rather than losing the words', async () => {
    const { toTag } = await import('../src/lib/ai/openai.ts');
    assert.equal(toTag('hindi'), 'hi');
    assert.equal(toTag('English'), 'en');
    assert.equal(toTag('hi'), 'hi');
    assert.equal(toTag('Serbo-Croatian'), null);
    assert.equal(toTag(undefined), null);
    assert.equal(toTag(42), null);
  });

  test('the transcript is redacted like a description — people read numbers aloud', () => {
    const runner = RUNNER_SOURCE.slice(RUNNER_SOURCE.indexOf('async function hear'));
    const body = runner.slice(0, runner.indexOf('\n}\n'));
    const redact = body.indexOf('redactLongDigitRuns(heard.text)');
    const write = body.indexOf('markRead(said');
    assert.ok(redact > 0 && write > redact, 'redaction must precede the write');
  });

  test('nothing to hear with releases the conversation rather than holding it', () => {
    const runner = RUNNER_SOURCE.slice(RUNNER_SOURCE.indexOf('async function hear'));
    const body = runner.slice(0, runner.indexOf('\n}\n'));
    const noTranscriber = body.slice(body.indexOf('if (!transcriber.ok)'));
    assert.match(noTranscriber.slice(0, 700), /await markRead\(null, null\)/);
    assert.match(body, /if \(heard\.permanent \|\| lastAttempt\)/);
  });

  test('a voice note sets the language, because speech IS them using one', () => {
    const runner = RUNNER_SOURCE.slice(RUNNER_SOURCE.indexOf('const MEDIA_READ'));
    const body = runner.slice(0, runner.indexOf('\n};'));
    assert.match(body, /\.\.\.\(language \? \{ language \} : \{\}\)/);
    // …and a photograph passes null, so it never fills the column.
    assert.match(body, /language: string \| null = null/);
  });

  test('the model id is a constant, and says so rather than pretending to be data', async () => {
    const { TRANSCRIPTION_MODEL } = await import('../src/lib/ai/openai.ts');
    assert.equal(typeof TRANSCRIPTION_MODEL, 'string');
    assert.match(openaiSource, /honest version of "not configurable yet"/);
  });

  test('an external base URL is forbidden in production, as for every other vendor', () => {
    const env = read('src/lib/env-schema.ts');
    assert.match(env, /'WHATSAPP_GRAPH_BASE_URL', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL'/);
  });
});

/**
 * I. the two lists that must agree, and did not.
 *
 * `serverSchema` declares what a variable must look like; `serverEnv()` reads
 * each one by an explicit `process.env.X` literal, because Next only inlines
 * static references. Adding OPENAI_API_KEY to the schema and forgetting the
 * read cost an afternoon: every variable here is `.optional()`, so the missing
 * read parsed as `undefined` and the transcriber reported itself unconfigured
 * on a deployment that had configured it. Nothing failed. It just did not
 * work.
 *
 * A literal map cannot be derived — that is the point of it — so it is
 * checked instead.
 */
describe('I. every server variable the schema declares is actually read', () => {
  test('the schema and the reader name the same set', () => {
    const schema = read('src/lib/env-schema.ts');
    const env = read('src/lib/env.ts');

    const block = schema.slice(schema.indexOf('export const serverSchema'));
    const declared = [
      ...block.slice(0, block.indexOf('\n});')).matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm),
    ].map((m) => m[1]!);

    const reader = env.slice(env.indexOf('serverSchema.safeParse({'));
    const wired = new Set(
      [...reader.slice(0, reader.indexOf('});')).matchAll(/([A-Z][A-Z0-9_]+): process\.env\./g)].map(
        (m) => m[1]!,
      ),
    );

    assert.ok(declared.length >= 10, `expected the server variables, found ${declared.length}`);
    const missing = declared.filter((name) => !wired.has(name));
    assert.deepEqual(missing, [], `declared but never read: ${missing.join(', ')}`);
  });
});
