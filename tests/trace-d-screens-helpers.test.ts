import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { statsByJobKind, workflowDefinitions, humanAction, humanEvent } from '../src/lib/admin/automation-workflows-eval.ts';
import { assembleSpend } from '../src/lib/admin/spend-by-project-eval.ts';
import { HANDLER_JOB_KIND, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { matchesAllWords, narrow } from '../src/lib/observability/operations-search.ts';
import { decideMeetingNoteFile, MEETING_NOTE_MAX_CHARS } from '../src/modules/crm/meeting-note-file.ts';
import { AGENT_KEYS } from '../src/modules/agents/registry.ts';

const file = (name: string, text: string, type = 'text/plain') => ({ name, type, size: Buffer.byteLength(text), text });

describe('SCR-060 a meeting note can be uploaded as a text file and the human source is kept', () => {
  test('a text file becomes notes, word for word, with its name, type and size on the row', () => {
    const text = 'Client wants the dashboard first.\nBudget agreed: 4 lakh.\n';
    const d = decideMeetingNoteFile(file('call-notes.txt', text));
    assert.equal(d.ok, true);
    if (!d.ok) return;
    assert.equal(d.body, text, 'the body is the file, not a summary of it');
    assert.equal(d.kind, 'notes');
    assert.equal(d.reference, 'uploaded file: call-notes.txt');
    assert.equal(d.byteSize, Buffer.byteLength(text));
    assert.equal(d.mediaType, 'text/plain');
  });

  test('a caption transcript is filed as a transcript, and a path in the name is reduced to the file name', () => {
    const d = decideMeetingNoteFile(file('C:\\Users\\sam\\kickoff.vtt', 'WEBVTT\n\n00:00.000 --> 00:02.000\nHello', 'text/vtt'));
    assert.equal(d.ok && d.kind, 'transcript');
    assert.equal(d.ok && d.reference, 'uploaded file: kickoff.vtt');
  });

  test('a recording or an image is refused with the reason, not accepted and dropped', () => {
    for (const name of ['call.mp3', 'whiteboard.png', 'notes.docx', 'notes']) {
      const d = decideMeetingNoteFile(file(name, 'x'));
      assert.equal(d.ok, false, name);
      if (!d.ok) assert.match(d.message, /Only a text file/);
    }
  });

  test('an empty file, an over-long file and a binary-looking file are refused', () => {
    assert.equal(decideMeetingNoteFile(file('a.txt', '   \n')).ok, false);
    const tooLong = decideMeetingNoteFile(file('a.txt', 'x'.repeat(MEETING_NOTE_MAX_CHARS + 1)));
    assert.equal(tooLong.ok, false);
    if (!tooLong.ok) assert.match(tooLong.message, /20,000/);
    assert.equal(decideMeetingNoteFile(file('a.txt', 'abc\u0000def')).ok, false);
    assert.equal(decideMeetingNoteFile(file('a.txt', 'x'.repeat(MEETING_NOTE_MAX_CHARS))).ok, true, 'exactly the ceiling is allowed');
  });

  test('a file with a password or a key inside is not kept, as with every shared file', () => {
    const d = decideMeetingNoteFile(file('notes.txt', 'Staging login\npassword: hunter2hunter2\n'));
    assert.equal(d.ok, false);
    if (!d.ok) assert.match(d.message, /was not kept/);
    assert.equal(decideMeetingNoteFile(file('secrets.txt', 'harmless')).ok, false, 'a credentials file by name');
  });
});

describe('SCR-061/065 the automation workflows are listed from the code that runs them', () => {
  const defs = workflowDefinitions(AGENT_KEYS);

  test('every event with a subscriber is listed, and every step names the job kind the dispatcher will enqueue', () => {
    assert.equal(defs.length, Object.values(SUBSCRIPTIONS).filter((h) => h.length > 0).length);
    for (const d of defs) {
      assert.ok(d.steps.length > 0);
      for (const step of d.steps) assert.equal(step.jobKind, HANDLER_JOB_KIND[step.handler]);
    }
  });

  test('a step run by an agent of the registry is marked as one; a module of the application is not', () => {
    const steps = defs.flatMap((d) => d.steps);
    const sales = steps.find((s) => s.actor === 'sales');
    const projects = steps.find((s) => s.actor === 'projects');
    assert.equal(sales?.actorIsAgent, true);
    assert.equal(projects?.actorIsAgent, false);
  });

  test('runs are counted per job kind and a dead or failed job is a failure', () => {
    const stats = statsByJobKind([
      { kind: 'a', status: 'succeeded', created_at: '2026-10-01T10:00:00Z' },
      { kind: 'a', status: 'dead', created_at: '2026-10-03T10:00:00Z' },
      { kind: 'a', status: 'cancelled', created_at: '2026-10-02T10:00:00Z' },
      { kind: 'b', status: 'failed', created_at: '2026-10-02T10:00:00Z' },
    ]);
    assert.deepEqual(stats.get('a'), { runs: 3, failed: 1, lastAt: '2026-10-03T10:00:00Z' });
    assert.deepEqual(stats.get('b'), { runs: 1, failed: 1, lastAt: '2026-10-02T10:00:00Z' });
    assert.equal(stats.get('c'), undefined);
  });

  test('the words read as words', () => {
    assert.equal(humanAction('startPhaseTwo'), 'start phase two');
    assert.equal(humanEvent('project.phase_four_ready'), 'project phase four ready');
  });
});

describe('SCR-062 the people and the channel are not agents', () => {
  test('no agent of the registry is Admin, Client or WhatsApp', () => {
    for (const key of AGENT_KEYS) {
      assert.doesNotMatch(key, /^(admin|client|whatsapp)(_|$)/, `${key} would make a person or a channel an agent`);
    }
    assert.ok(AGENT_KEYS.length > 0);
  });
});

describe('SCR-065 no hidden spend: the run with no project is a line of its own', () => {
  const P1 = '11111111-1111-4111-8111-111111111111';
  const P2 = '22222222-2222-4222-8222-222222222222';
  const rows = [
    { projectId: P1, runs: 4, inputTokens: 100, outputTokens: 50, costMinor: 600 },
    { projectId: null, runs: 9, inputTokens: 10, outputTokens: 5, costMinor: 300 },
    { projectId: P2, runs: 1, inputTokens: 1, outputTokens: 1, costMinor: 100 },
  ];

  test('the unattributed line is kept, last, and the lines add up to the whole', () => {
    const t = assembleSpend(rows, new Map([[P1, 'Northwind'], [P2, 'Acme']]));
    assert.deepEqual(t.lines.map((l) => l.name), ['Northwind', 'Acme', null]);
    assert.deepEqual(t.total, { runs: 14, costMinor: 1000 });
    assert.deepEqual(t.unattributed, { runs: 9, costMinor: 300 });
    assert.deepEqual(t.lines.map((l) => l.sharePercent), [60, 10, 30]);
  });

  test('a project that cannot be named is still shown, and a zero total gives no share rather than a made-up one', () => {
    const t = assembleSpend([{ projectId: P1, runs: 2, inputTokens: 0, outputTokens: 0, costMinor: 0 }], new Map());
    assert.equal(t.lines[0]?.name, 'Unknown project');
    assert.equal(t.lines[0]?.sharePercent, null);
  });
});

describe('SCR-066 the operations lists can be searched without changing a count', () => {
  const jobs = [
    { kind: 'invoice.generate_m1', lastError: 'smtp refused' },
    { kind: 'followup.deliver', lastError: 'window closed' },
    { kind: 'plan.breakdown', lastError: null },
  ];

  test('every word must appear, in any order, ignoring case', () => {
    assert.equal(matchesAllWords('SMTP invoice', 'invoice.generate_m1', 'smtp refused'), true);
    assert.equal(matchesAllWords('smtp window', 'invoice.generate_m1', 'smtp refused'), false);
    assert.equal(matchesAllWords('', 'anything'), true);
  });

  test('narrowing reports how many the list held, and a blank query changes nothing', () => {
    const n = narrow('window', jobs, (j) => [j.kind, j.lastError]);
    assert.deepEqual(n.rows.map((j) => j.kind), ['followup.deliver']);
    assert.equal(n.held, 3);
    assert.equal(narrow('  ', jobs, (j) => [j.kind]).rows.length, 3);
  });
});
