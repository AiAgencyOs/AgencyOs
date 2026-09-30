import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { deviceTiles, platformOf, platformSummary, thumbnailOf, type DeviceRun } from '../src/modules/qa/device-tiles.ts';
import { groupQaTeam } from '../src/modules/qa/qa-team.ts';

const run = (over: Partial<DeviceRun>): DeviceRun => ({ device: 'Pixel 8', os: 'Android 14', browser: 'Chrome', evidenceUrl: null, failed: 0, blocked: 0, status: 'closed', executedAt: '2026-09-01T10:00:00Z', ...over });

describe('the platform a tile sits under is what the tester wrote', () => {
  test('phones, tablets, TVs and browsers are told apart', () => {
    assert.equal(platformOf({ device: 'Samsung Galaxy S24', os: 'Android 14', browser: null }), 'android');
    assert.equal(platformOf({ device: 'iPhone 15', os: 'iOS 17', browser: 'Safari' }), 'ios');
    assert.equal(platformOf({ device: 'iPad Air', os: 'iPadOS 17', browser: 'Safari' }), 'tablet');
    assert.equal(platformOf({ device: 'LG Smart TV', os: 'webOS 6', browser: null }), 'tv');
    assert.equal(platformOf({ device: 'MacBook Pro', os: 'macOS 14', browser: 'Chrome' }), 'web');
  });
  test('words that say nothing are Other, not a guess', () => {
    assert.equal(platformOf({ device: 'Lab rig 3', os: null, browser: null }), 'other');
  });
});

describe('a thumbnail is only ever the run\'s own image link', () => {
  test('https image links are thumbnails; any other evidence is not', () => {
    assert.equal(thumbnailOf('https://cdn.example.com/s24.png'), 'https://cdn.example.com/s24.png');
    assert.equal(thumbnailOf('https://cdn.example.com/s24.JPG?x=1'), 'https://cdn.example.com/s24.JPG?x=1');
    assert.equal(thumbnailOf('http://cdn.example.com/s24.png'), null);
    assert.equal(thumbnailOf('https://drive.example.com/folder/abc'), null);
    assert.equal(thumbnailOf(null), null);
  });
});

describe('one tile per device, from its newest run', () => {
  test('newest run decides the state; older evidence still supplies a picture', () => {
    const tiles = deviceTiles([
      run({ executedAt: '2026-09-02T10:00:00Z', failed: 2 }),
      run({ executedAt: '2026-09-01T10:00:00Z', evidenceUrl: 'https://cdn.example.com/p8.webp' }),
      run({ device: 'pixel 8 ', executedAt: '2026-08-01T10:00:00Z' }),
      run({ device: null }),
    ]);
    assert.equal(tiles.length, 1);
    assert.equal(tiles[0]!.state, 'failed');
    assert.equal(tiles[0]!.runs, 3);
    assert.equal(tiles[0]!.thumbnailUrl, 'https://cdn.example.com/p8.webp');
  });
  test('an open run is in progress, not tested', () => {
    assert.equal(deviceTiles([run({ status: 'open' })])[0]!.state, 'in_progress');
  });
  test('tab counts and the tested figure come from the tiles', () => {
    const tiles = deviceTiles([run({}), run({ device: 'Galaxy S24', failed: 1 }), run({ device: 'iPhone 15', os: 'iOS 17' })]);
    assert.deepEqual(platformSummary(tiles), [{ platform: 'android', count: 2, tested: 1 }, { platform: 'ios', count: 1, tested: 1 }]);
  });
});

describe('the QA team is the project roster\'s QA role, once per person', () => {
  test('a person on two projects is one row with two projects', () => {
    const team = groupQaTeam([
      { userId: 'b', fullName: 'Neha', projectId: 'p1', projectName: 'One' },
      { userId: 'a', fullName: 'Amit', projectId: 'p1', projectName: 'One' },
      { userId: 'b', fullName: 'Neha', projectId: 'p2', projectName: 'Two' },
      { userId: 'b', fullName: 'Neha', projectId: 'p2', projectName: 'Two' },
    ]);
    assert.deepEqual(team.map((m) => [m.fullName, m.projects.length]), [['Amit', 1], ['Neha', 2]]);
  });
});
