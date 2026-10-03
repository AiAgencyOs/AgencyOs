import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { collaborationFeed, lastAnnouncement, meetingSignals } from '../src/modules/crm/client-collaboration.ts';

const ANALYSIS = 'AI analysis — PROPOSED\n\nAgency committed to\n• Send the quote by Friday\n\nClient committed to\n• Share logo files\n\nUnresolved\n• Which payment gateway?\n• Who supplies photos?\n\nNext action: Draft the quote';

describe('SCR-017 header: meeting decisions and open questions', () => {
  test('counts what an analysis note holds and names how many notes were analysed', () => {
    assert.deepEqual(meetingSignals([{ body: ANALYSIS }, { body: 'typed by a person' }, { body: null }]), { notes: 3, analysed: 1, decisions: 2, openQuestions: 2 });
  });
  test('no notes is zero, never a guess', () => {
    assert.deepEqual(meetingSignals([]), { notes: 0, analysed: 0, decisions: 0, openQuestions: 0 });
  });
});

describe('SCR-017 header: last announcement', () => {
  test('is the newest published one; a draft with no publish time never counts', () => {
    const rows = [
      { id: 'a', publishedAt: '2026-09-01T00:00:00Z' },
      { id: 'b', publishedAt: '2026-09-20T00:00:00Z' },
      { id: 'c', publishedAt: null },
    ];
    assert.equal(lastAnnouncement(rows)?.id, 'b');
    assert.equal(lastAnnouncement([{ id: 'c', publishedAt: null }]), null);
  });
});

describe('SCR-017 activity: every record keeps author, time, source and linkage', () => {
  const feed = collaborationFeed({
    clientName: 'Northwind Retail',
    announcements: [{ id: 'a1', title: 'Holiday hours', publishedAt: '2026-09-10T08:00:00Z', projectName: null, clientName: null }],
    uploads: [{ id: 'u1', title: 'brief.pdf', projectName: 'Loyalty app', category: 'client_files', uploadedAt: '2026-09-12T08:00:00Z', uploadedByEmail: 'asha@agency.test', version: 2 }],
    meetingNotes: [{ id: 'm1', meetingId: 'mm', kind: 'summary', body: ANALYSIS, uploadedAt: '2026-09-11T08:00:00Z', meetingAt: null }, { id: 'm2', meetingId: 'mm', kind: 'notes', body: 'Agreed to meet again', uploadedAt: '2026-09-09T08:00:00Z', meetingAt: null }],
    internalNotes: [{ id: 'n1', body: 'Prefers calls after 5', createdAt: '2026-09-13T08:00:00Z', createdByEmail: 'ravi@agency.test' }],
    unread: [{ conversationId: 'c1', title: 'Project Group - Northwind', kind: 'project_group', unread: 2, latestAt: '2026-09-14T08:00:00Z', latestBody: 'Any update?' }],
  });

  test('newest first across all five sources', () => {
    assert.deepEqual(feed.map((e) => e.kind), ['client_reply', 'internal_note', 'upload', 'meeting_note', 'announcement', 'meeting_note']);
  });
  test('an internal note is marked internal and carries its author; nothing else is', () => {
    const note = feed.find((e) => e.kind === 'internal_note')!;
    assert.equal(note.internal, true);
    assert.equal(note.by, 'ravi');
    assert.equal(feed.filter((e) => e.internal).length, 1);
  });
  test('a file names who uploaded it and which project holds it', () => {
    const up = feed.find((e) => e.kind === 'upload')!;
    assert.equal(up.by, 'asha');
    assert.match(up.linkage, /Project Loyalty app/);
    assert.match(up.title, /v2/);
  });
  test('an analysis note is shown as proposed, and its text is not echoed', () => {
    const m = feed.find((e) => e.key === 'meeting-note-m1')!;
    assert.match(m.title, /proposed/);
    assert.equal(m.detail, null);
  });
  test('an unpublished announcement is not an event', () => {
    const none = collaborationFeed({ clientName: 'X', announcements: [{ id: 'a', title: 't', publishedAt: null, projectName: null, clientName: null }], uploads: [], meetingNotes: [], internalNotes: [], unread: [] });
    assert.equal(none.length, 0);
  });
});
