import assert from 'node:assert/strict';
import { crc32 as nodeCrc32 } from 'node:zlib';
import { describe, test } from 'node:test';

import { buildZip, crc32, safeZipName } from '../src/lib/export/zip.ts';
import { prototypeSendBlockers } from '../src/modules/projects/build-details-schema.ts';
import { filterRequirementProjects, pageOf, parseOpenFilter, parseScopeFilter, type RequirementProjectRow } from '../src/modules/projects/requirements-dashboard-filter.ts';

const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint32(at, true);
const u16 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint16(at, true);

describe('the design handoff bundle is a readable ZIP', () => {
  const text = (s: string) => new TextEncoder().encode(s);
  test('crc32 agrees with the platform implementation', () => {
    for (const s of ['', 'a', 'The quick brown fox', 'x'.repeat(5000)]) assert.equal(crc32(text(s)), nodeCrc32(s) >>> 0);
  });
  test('the end record counts the entries and the central directory names each file with its size and checksum', () => {
    const files = [{ name: 'manifest.json', data: text('{"a":1}') }, { name: 'files/logo/Logo-v1.svg', data: text('<svg/>') }, { name: 'brand-kit.md', data: text('# Brand') }];
    const zip = buildZip(files, new Date(2026, 9, 6, 12, 0, 0));
    const end = zip.length - 22;
    assert.equal(u32(zip, end), 0x06054b50);
    assert.equal(u16(zip, end + 10), 3);
    let at = u32(zip, end + 16);
    for (const f of files) {
      assert.equal(u32(zip, at), 0x02014b50);
      assert.equal(u32(zip, at + 16), nodeCrc32(f.data) >>> 0);
      assert.equal(u32(zip, at + 24), f.data.length);
      const nameLen = u16(zip, at + 28);
      assert.equal(new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen)), f.name);
      // the local header at the recorded offset carries the same name and the bytes follow it
      const local = u32(zip, at + 42);
      assert.equal(u32(zip, local), 0x04034b50);
      const data = zip.subarray(local + 30 + nameLen, local + 30 + nameLen + f.data.length);
      assert.deepEqual([...data], [...f.data]);
      at += 46 + nameLen;
    }
  });
  test('a name cannot climb out of the archive', () => {
    assert.equal(safeZipName('../../etc/passwd'), 'etc/passwd');
    assert.equal(safeZipName('/abs/path\\win.txt'), 'abs/path/win.txt');
  });
});

describe('the requirements dashboard filter', () => {
  const row = (over: Partial<RequirementProjectRow>): RequirementProjectRow => ({ projectId: 'p', projectName: 'Northwind app', scopeVersion: 1, scopeStatus: 'active', openChangeRequests: 0, openClarifications: 0, ...over });
  const rows = [
    row({ projectId: '1', projectName: 'Northwind app' }),
    row({ projectId: '2', projectName: 'Acme portal', scopeVersion: 2, scopeStatus: 'draft', openClarifications: 3 }),
    row({ projectId: '3', projectName: 'Loyalty', scopeVersion: null, scopeStatus: null, openChangeRequests: 1 }),
  ];
  const ids = (r: RequirementProjectRow[]) => r.map((x) => x.projectId);
  test('search is by project name, any case', () => {
    assert.deepEqual(ids(filterRequirementProjects(rows, { q: 'ACME', scope: 'all', open: 'all' })), ['2']);
  });
  test('the scope filters: frozen is a version past draft, none has no version', () => {
    assert.deepEqual(ids(filterRequirementProjects(rows, { q: '', scope: 'frozen', open: 'all' })), ['1']);
    assert.deepEqual(ids(filterRequirementProjects(rows, { q: '', scope: 'draft', open: 'all' })), ['2']);
    assert.deepEqual(ids(filterRequirementProjects(rows, { q: '', scope: 'none', open: 'all' })), ['3']);
  });
  test('the open filters keep only projects with the thing', () => {
    assert.deepEqual(ids(filterRequirementProjects(rows, { q: '', scope: 'all', open: 'questions' })), ['2']);
    assert.deepEqual(ids(filterRequirementProjects(rows, { q: '', scope: 'all', open: 'changes' })), ['3']);
  });
  test('filters combine, and an unknown value reads as no filter', () => {
    assert.deepEqual(ids(filterRequirementProjects(rows, { q: 'a', scope: 'draft', open: 'questions' })), ['2']);
    assert.equal(parseScopeFilter('junk'), 'all');
    assert.equal(parseOpenFilter(undefined), 'all');
  });
  test('paging clamps to the last page and never returns an empty page for a non-empty list', () => {
    const many = Array.from({ length: 45 }, (_, i) => i);
    assert.deepEqual(pageOf(many, 1).rows.length, 20);
    assert.deepEqual(pageOf(many, 3).rows, [40, 41, 42, 43, 44]);
    assert.equal(pageOf(many, 99).page, 3);
    assert.equal(pageOf(many, Number.NaN).page, 1);
    assert.deepEqual(pageOf([], 1), { rows: [], page: 1, pages: 1 });
  });
});

describe('what stands between a prototype and the client', () => {
  test('nothing when QA passed and Admin approved', () => {
    assert.deepEqual(prototypeSendBlockers({ qaPassed: true, adminApproved: true, qaSource: 'the prototype QA verdict' }), []);
  });
  test('both are named when neither holds, and no QA evidence says so', () => {
    const b = prototypeSendBlockers({ qaPassed: false, adminApproved: false, qaSource: 'no QA evidence' });
    assert.equal(b.length, 2);
    assert.match(b[0]!, /no QA evidence/);
    assert.match(b[1]!, /Admin has not approved/);
  });
});
