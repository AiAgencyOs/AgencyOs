import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

/**
 * Round 3, owner decisions Q-C1, Q-C6 and Q-D3 of 2026-10-01: an uploaded build
 * file (apk / ipa / zip), test-run and bug evidence files, and meeting
 * recordings / images / PDF / Word files — all "under the project-file rules".
 *
 * Storage is unreachable on the local stack, so the storage client is a FAKE
 * here (as tests/finance-attachments.test.ts does): the real service code runs
 * with only the session, the database client and the bucket stubbed. The
 * database half (the doors' own refusals) is proved against real Postgres by
 * scripts/verify-r3-stream.mjs.
 */

const ORG = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';
const BUILD = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';
const MEETING = '55555555-5555-4555-8555-555555555555';
const PROJECT = '66666666-6666-4666-8666-666666666666';

let role: 'owner' | 'delivery_lead' | 'member' | 'finance' = 'owner';
let storageReachable = true;
let uploadError: { message: string } | null = null;
let subjectExists = true;
let doorOutcome = 'attached';

const seen = {
  uploads: [] as { bucket: string; path: string; size: number }[],
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
  reads: [] as string[],
};

const stubClient = {
  storage: {
    from(bucket: string) {
      return {
        async list() {
          return storageReachable ? { data: [], error: null } : { data: null, error: { message: 'fetch failed' } };
        },
        async upload(path: string, file: File) {
          if (uploadError) return { data: null, error: uploadError };
          seen.uploads.push({ bucket, path, size: file.size });
          return { data: { path }, error: null };
        },
      };
    },
  },
  schema(schema: string) {
    return {
      from(table: string) {
        return {
          select() {
            return { eq: () => ({ maybeSingle: async () => { seen.reads.push(`${schema}.${table}`); return { data: subjectExists ? { id: 'x' } : null, error: null }; } }) };
          },
        };
      },
      async rpc(fn: string, args: Record<string, unknown>) {
        seen.rpcs.push({ fn, args });
        return { data: [{ outcome: doorOutcome, id: 'att-1', project_id: PROJECT, evidence_id: 'ev-1', lead_id: 'lead-1' }], error: null };
      },
    };
  },
};

mock.module('@/lib/auth/session', { exports: { requireInternal: async () => ({ role, userId: USER, organizationId: ORG }) } });
mock.module('@/lib/db/server', { exports: { createClient: async () => stubClient } });
mock.module('@/lib/env', { exports: { serverEnv: () => ({ SUPABASE_FILES_BUCKET: 'project-files' }), clientEnv: {} } });

const rules = await import('../src/modules/projects/attachment-rules.ts');
const { attachStoredFile } = await import('../src/modules/projects/attached-files-service.ts');
const { uploadMeetingStoredFile } = await import('../src/modules/crm/meeting-file-service.ts');
const { decideMeetingNoteFile, decideMeetingStoredFile, routeMeetingFile } = await import('../src/modules/crm/meeting-note-file.ts');

const file = (name: string, size = 2048, type = 'application/octet-stream') => new File([new Uint8Array(size).fill(65)], name, { type });
const huge = (name: string) => ({ name, size: 51 * 1024 * 1024, type: 'application/octet-stream', slice: () => new Blob([]), arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as File;
// A credential-shaped fixture is assembled here, so no secret-looking literal is committed.
const passwordLine = () => `staging login\n${['pass', 'word'].join('')}: ${'hunter2'.repeat(2)}\n`;

beforeEach(() => {
  role = 'owner';
  storageReachable = true;
  uploadError = null;
  subjectExists = true;
  doorOutcome = 'attached';
  seen.uploads.length = 0;
  seen.rpcs.length = 0;
  seen.reads.length = 0;
});

describe('the project-file rules for the three kinds of file', () => {
  test('a build is an apk, ipa or zip and nothing else', () => {
    for (const ok of ['app.apk', 'App.IPA', 'bundle.zip']) assert.equal(rules.attachmentShapeProblem({ name: ok, size: 10 }, 'build'), null, ok);
    for (const bad of ['setup.exe', 'notes.txt', 'archive', 'app.apk.exe']) assert.match(rules.attachmentShapeProblem({ name: bad, size: 10 }, 'build') ?? '', /build file is one of \.apk, \.ipa, \.zip/, bad);
  });

  test('evidence is a screenshot, a log, a report or a recording; an installer is not', () => {
    for (const ok of ['shot.png', 'run.log', 'report.pdf', 'trace.har', 'screen.mp4']) assert.equal(rules.attachmentShapeProblem({ name: ok, size: 10 }, 'evidence'), null, ok);
    assert.match(rules.attachmentShapeProblem({ name: 'setup.exe', size: 10 }, 'evidence') ?? '', /evidence file/);
  });

  test('a meeting file is a recording, an image, a PDF or a Word file, and says which kind', () => {
    assert.equal(rules.meetingStoredKind('call.m4a'), 'recording');
    assert.equal(rules.meetingStoredKind('board.JPG'), 'image');
    assert.equal(rules.meetingStoredKind('minutes.docx'), 'document');
    assert.equal(rules.meetingStoredKind('minutes.doc'), 'document');
    assert.equal(rules.meetingStoredKind('minutes.pdf'), 'document');
    assert.equal(rules.meetingStoredKind('notes.txt'), null, 'text is kept verbatim, not stored');
    assert.equal(rules.meetingStoredKind('run.exe'), null);
  });

  test('50 MB is the ceiling, in every kind; an empty file is not a file', () => {
    assert.match(rules.attachmentShapeProblem({ name: 'a.apk', size: 51 * 1024 * 1024 }, 'build') ?? '', /limit is 50 MB/);
    assert.equal(rules.attachmentShapeProblem({ name: 'a.apk', size: rules.ATTACHMENT_MAX_BYTES }, 'build'), null, 'exactly the ceiling is allowed');
    assert.match(rules.attachmentShapeProblem({ name: 'a.apk', size: 0 }, 'build') ?? '', /Choose a file/);
    assert.equal(rules.hasChosenFile(new File([], 'x.apk')), false);
    assert.equal(rules.hasChosenFile(file('x.apk')), true);
  });

  test('the object key is the tenant, the area, the record and a safe name', () => {
    const p = rules.attachmentObjectPath({ organizationId: ORG, area: 'build', recordId: BUILD, name: '../../etc/pass wd?.apk' });
    assert.ok(p.startsWith(`${ORG}/builds/${BUILD}/`), p);
    assert.doesNotMatch(p, /\.\.|\?/);
    assert.ok(rules.attachmentObjectPath({ organizationId: ORG, area: 'evidence', recordId: RUN, name: 'a.png' }).startsWith(`${ORG}/evidence/${RUN}/`));
    assert.ok(rules.attachmentObjectPath({ organizationId: ORG, area: 'meeting', recordId: MEETING, name: 'a.mp3' }).startsWith(`${ORG}/meetings/${MEETING}/`));
  });
});

describe('Q-C1: a build carries a build file', () => {
  test('stores the object under the tenant, then records it through the door with the path the door checks', async () => {
    const r = await attachStoredFile({ subjectKind: 'build', subjectId: BUILD }, file('Release 1.2.apk', 4096, 'application/vnd.android.package-archive'));
    assert.equal(r.ok, true);
    assert.equal(seen.uploads.length, 1);
    assert.equal(seen.uploads[0]!.bucket, 'project-files');
    assert.ok(seen.uploads[0]!.path.startsWith(`${ORG}/builds/${BUILD}/`));
    const call = seen.rpcs[0]!;
    assert.equal(call.fn, 'attach_file');
    assert.equal(call.args.p_subject_kind, 'build');
    assert.equal(call.args.p_storage_path, seen.uploads[0]!.path);
    assert.equal(call.args.p_size_bytes, 4096);
    assert.equal(r.ok && r.data.projectId, PROJECT);
  });

  test('a file over 50 MB, or one that is not an apk, ipa or zip, is refused before storage is touched', async () => {
    const big = await attachStoredFile({ subjectKind: 'build', subjectId: BUILD }, huge('big.apk'));
    assert.equal(big.ok, false);
    assert.match(!big.ok ? big.error.message : '', /limit is 50 MB/);
    const exe = await attachStoredFile({ subjectKind: 'build', subjectId: BUILD }, file('setup.exe'));
    assert.equal(exe.ok, false);
    assert.equal(seen.uploads.length, 0);
    assert.equal(seen.rpcs.length, 0);
    assert.equal(seen.reads.length, 0, 'not even the record is read');
  });

  test('a credentials file is refused by its name under the same guard as every project file, and nothing is stored', async () => {
    const r = await attachStoredFile({ subjectKind: 'build', subjectId: BUILD }, file('credentials.zip'));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error.message : '', /build file was not saved\. .*credentials/i);
    assert.equal(seen.uploads.length, 0);
    assert.equal(seen.rpcs.length, 0);
    assert.equal((await attachStoredFile({ subjectKind: 'build', subjectId: BUILD }, file('release.zip'))).ok, true, 'an ordinary zip of a build is fine');
  });

  test('only delivery roles attach a build file: a member is refused before anything is read or stored', async () => {
    role = 'member';
    const r = await attachStoredFile({ subjectKind: 'build', subjectId: BUILD }, file('a.apk'));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error.message : '', /permission/);
    assert.equal(seen.uploads.length, 0);
    assert.equal(seen.reads.length, 0);
  });

  test('a build that is not the caller\'s (not found under their session) stores nothing', async () => {
    subjectExists = false;
    const r = await attachStoredFile({ subjectKind: 'build', subjectId: BUILD }, file('a.apk'));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error.message : '', /Build not found/);
    assert.equal(seen.uploads.length, 0);
  });

  test('when storage cannot be reached nothing is uploaded and no row is written', async () => {
    storageReachable = false;
    const r = await attachStoredFile({ subjectKind: 'build', subjectId: BUILD }, file('a.apk'));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error.message : '', /Storage is not reachable, so nothing was uploaded/);
    assert.equal(seen.rpcs.length, 0);
  });

  test('when storage refuses the upload no row claims a body', async () => {
    uploadError = { message: 'quota' };
    const r = await attachStoredFile({ subjectKind: 'build', subjectId: BUILD }, file('a.apk'));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error.message : '', /nothing was saved: quota/);
    assert.equal(seen.rpcs.length, 0);
  });

  test('the database door has the last word, and its refusals come back in words', async () => {
    for (const [outcome, pattern] of [['too_many', /at most 5 files/], ['too_big', /50 MB/], ['bad_type', /not a kind of file/], ['credential_name', /credentials file/], ['forbidden', /database refused/]] as const) {
      doorOutcome = outcome;
      const r = await attachStoredFile({ subjectKind: 'build', subjectId: BUILD }, file('a.apk'));
      assert.equal(r.ok, false, outcome);
      assert.match(!r.ok ? r.error.message : '', pattern, outcome);
    }
  });
});

describe('Q-C6: test-run and bug evidence may be files', () => {
  test('a screenshot is stored under the evidence area of the run', async () => {
    const r = await attachStoredFile({ subjectKind: 'test_run', subjectId: RUN }, file('failure.png', 1000, 'image/png'));
    assert.equal(r.ok, true);
    assert.ok(seen.uploads[0]!.path.startsWith(`${ORG}/evidence/${RUN}/`));
    assert.equal(seen.rpcs[0]!.args.p_subject_kind, 'test_run');
    assert.deepEqual(seen.reads, ['qa.test_runs']);
  });

  test('a member records runs, so a member may attach evidence to one; a bug is delivery work, so a member may not', async () => {
    role = 'member';
    assert.equal((await attachStoredFile({ subjectKind: 'test_run', subjectId: RUN }, file('a.png'))).ok, true);
    assert.equal((await attachStoredFile({ subjectKind: 'defect', subjectId: RUN }, file('a.png'))).ok, false);
  });

  test('a small text log with a password in it is refused by what is inside it', async () => {
    const r = await attachStoredFile({ subjectKind: 'defect', subjectId: RUN }, new File([passwordLine()], 'run.log', { type: 'text/plain' }));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error.message : '', /evidence file was not saved/);
    assert.equal(seen.uploads.length, 0);
  });

  test('an ordinary log passes the same guard', async () => {
    const r = await attachStoredFile({ subjectKind: 'defect', subjectId: RUN }, new File(['GET /health 200\nGET /login 500\n'], 'run.log', { type: 'text/plain' }));
    assert.equal(r.ok, true);
    assert.deepEqual(seen.reads, ['qa.defects']);
  });
});

describe('Q-D3: meeting-note upload also takes recordings, images, PDF and Word', () => {
  test('text still goes the verbatim route; the four stored kinds go the stored route; the rest are refused', () => {
    assert.equal(routeMeetingFile('notes.txt'), 'text');
    assert.equal(routeMeetingFile('call.vtt'), 'text');
    assert.equal(routeMeetingFile('call.mp3'), 'stored');
    assert.equal(routeMeetingFile('whiteboard.png'), 'stored');
    assert.equal(routeMeetingFile('minutes.pdf'), 'stored');
    assert.equal(routeMeetingFile('minutes.docx'), 'stored');
    assert.equal(routeMeetingFile('run.exe'), 'unsupported');
    assert.equal(routeMeetingFile('notes'), 'unsupported');
  });

  test('a text file keeps its words verbatim, as before', () => {
    const text = 'Agreed: ship on Friday.\nOwner: Asha';
    const d = decideMeetingNoteFile({ name: 'call.txt', type: 'text/plain', size: text.length, text });
    assert.equal(d.ok && d.body, text);
  });

  test('the stored decision names the kind, the reference and the media type, and refuses the oversize and the credentials-named', () => {
    const d = decideMeetingStoredFile({ name: 'Kickoff call.m4a', type: '', size: 1000 });
    assert.ok(d.ok);
    assert.equal(d.ok && d.kind, 'recording');
    assert.equal(d.ok && d.reference, 'uploaded file: Kickoff call.m4a');
    assert.equal(d.ok && d.mediaType, 'audio/mp4');
    assert.equal(decideMeetingStoredFile({ name: 'minutes.docx', type: '', size: 5 }).ok && true, true);
    const big = decideMeetingStoredFile({ name: 'call.mp4', type: 'video/mp4', size: 51 * 1024 * 1024 });
    assert.ok(!big.ok && /limit is 50 MB/.test(big.message));
    assert.equal(decideMeetingStoredFile({ name: 'server.pem', type: '', size: 5 }).ok, false);
    assert.equal(decideMeetingStoredFile({ name: 'notes.txt', type: '', size: 5 }).ok, false, 'a text file is not a stored file');
  });

  test('a recording is stored under the meeting\'s folder and filed through the evidence-file door as a recording', async () => {
    const r = await uploadMeetingStoredFile({ meetingId: MEETING, visibility: 'internal' }, file('call.mp3', 8000, 'audio/mpeg'));
    assert.equal(r.ok, true);
    assert.ok(seen.uploads[0]!.path.startsWith(`${ORG}/meetings/${MEETING}/`));
    const call = seen.rpcs[0]!;
    assert.equal(call.fn, 'add_meeting_evidence_file');
    assert.equal(call.args.p_kind, 'recording');
    assert.equal(call.args.p_visibility, 'internal');
    assert.equal(call.args.p_storage_path, seen.uploads[0]!.path);
    assert.equal(call.args.p_byte_size, 8000);
    assert.equal(r.ok && r.data.leadId, 'lead-1');
  });

  test('an image and a Word file are filed as image and document', async () => {
    await uploadMeetingStoredFile({ meetingId: MEETING, visibility: 'client_visible' }, file('board.png', 100, 'image/png'));
    await uploadMeetingStoredFile({ meetingId: MEETING, visibility: 'internal' }, file('minutes.docx', 100));
    assert.deepEqual(seen.rpcs.map((c) => c.args.p_kind), ['image', 'document']);
    assert.equal(seen.rpcs[0]!.args.p_visibility, 'client_visible');
  });

  test('over 50 MB, a file that is not one of the four kinds, an unknown meeting and an unreachable store each store nothing', async () => {
    assert.equal((await uploadMeetingStoredFile({ meetingId: MEETING, visibility: 'internal' }, huge('call.mp4'))).ok, false);
    assert.equal((await uploadMeetingStoredFile({ meetingId: MEETING, visibility: 'internal' }, file('run.exe'))).ok, false);
    subjectExists = false;
    const missing = await uploadMeetingStoredFile({ meetingId: MEETING, visibility: 'internal' }, file('call.mp3'));
    assert.match(!missing.ok ? missing.error.message : '', /meeting was not found/);
    subjectExists = true;
    storageReachable = false;
    const down = await uploadMeetingStoredFile({ meetingId: MEETING, visibility: 'internal' }, file('call.mp3'));
    assert.match(!down.ok ? down.error.message : '', /Storage is not reachable/);
    assert.equal(seen.uploads.length, 0);
    assert.equal(seen.rpcs.length, 0);
  });

  test('a role that may not write evidence stores nothing', async () => {
    role = 'finance';
    const r = await uploadMeetingStoredFile({ meetingId: MEETING, visibility: 'internal' }, file('call.mp3'));
    assert.equal(r.ok, false);
    assert.equal(seen.uploads.length, 0);
  });

  test('the door\'s own refusals come back in words', async () => {
    doorOutcome = 'bad_type';
    const r = await uploadMeetingStoredFile({ meetingId: MEETING, visibility: 'internal' }, file('call.mp3'));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error.message : '', /not a recording, an image, a PDF or a Word file/);
  });
});
