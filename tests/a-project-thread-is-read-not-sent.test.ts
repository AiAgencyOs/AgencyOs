import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { conversationTitle, filterThreads, isWaiting, messageCounts, previewOf, share, sortThreads, tabOf, type ThreadRow } from '../src/modules/projects/project-communication.ts';

const thread = (over: Partial<ThreadRow>): ThreadRow => ({ id: 't', kind: 'project_group', title: 'Group', channel: 'whatsapp', messages: 3, lastAt: '2026-09-02T10:00:00Z', lastPreview: 'hello', lastAuthor: 'user', ...over });

describe('a conversation is classified only by who is on it', () => {
  test('the agency\'s own groups are internal; everything with a client on it is client-facing', () => {
    assert.equal(tabOf('project_group'), 'client');
    assert.equal(tabOf('client_account'), 'client');
    assert.equal(tabOf('direct'), 'client');
    assert.equal(tabOf('internal_group'), 'internal');
    assert.equal(tabOf('internal_direct'), 'internal');
  });
  test('waiting on you means the client spoke last — never that something is unread', () => {
    assert.equal(isWaiting({ lastAuthor: 'client' }), true);
    assert.equal(isWaiting({ lastAuthor: 'user' }), false);
    assert.equal(isWaiting({ lastAuthor: null }), false);
  });
});

describe('the list', () => {
  const list = [thread({ id: 'a', lastAuthor: 'client', lastAt: '2026-09-03T00:00:00Z' }), thread({ id: 'b', kind: 'internal_group', title: 'Team', lastAt: '2026-09-05T00:00:00Z' }), thread({ id: 'c', lastAt: null, lastPreview: null, lastAuthor: null })];
  test('filters by tab and by words in the title or the last line', () => {
    assert.deepEqual(filterThreads(list, 'client', '').map((t) => t.id), ['a', 'c']);
    assert.deepEqual(filterThreads(list, 'internal', '').map((t) => t.id), ['b']);
    assert.deepEqual(filterThreads(list, 'waiting', '').map((t) => t.id), ['a']);
    assert.deepEqual(filterThreads(list, 'all', 'TEAM').map((t) => t.id), ['b']);
  });
  test('newest activity first, and a thread with no message last', () => {
    assert.deepEqual(sortThreads(list).map((t) => t.id), ['b', 'a', 'c']);
  });
  test('a title is what was recorded, else a name built from the project or client', () => {
    const names = { project: 'Northwind', client: 'Northwind Retail' };
    assert.equal(conversationTitle({ kind: 'project_group', title: ' Ganx group ' }, names), 'Ganx group');
    assert.equal(conversationTitle({ kind: 'project_group', title: null }, names), 'Northwind — project group');
    assert.equal(conversationTitle({ kind: 'client_account', title: null }, names), 'Northwind Retail — client thread');
    assert.equal(conversationTitle({ kind: 'client_account', title: null }, { project: 'x', client: null }), 'Client thread');
  });
});

describe('the figures are counted from the messages', () => {
  const now = Date.parse('2026-09-10T00:00:00Z');
  test('client and team are author types; this week is the last seven days', () => {
    const c = messageCounts(
      [
        { author_type: 'client', occurred_at: '2026-09-09T00:00:00Z' },
        { author_type: 'user', occurred_at: '2026-09-08T00:00:00Z' },
        { author_type: 'agent', occurred_at: '2026-08-01T00:00:00Z' },
        { author_type: 'system', occurred_at: '2026-09-09T12:00:00Z' },
      ],
      now,
    );
    assert.deepEqual(c, { total: 4, thisWeek: 3, client: 1, team: 2 });
  });
  test('a share of nothing is 0%, not NaN', () => {
    assert.equal(share(0, 0), '0%');
    assert.equal(share(3, 5), '60%');
  });
  test('a file with no text previews as its kind; long text is cut', () => {
    assert.equal(previewOf('', 'image'), '[image]');
    assert.equal(previewOf('  a\n b  ', undefined), 'a b');
    assert.equal(previewOf('x'.repeat(200), undefined).length, 88);
  });
});
