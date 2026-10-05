import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, test } from 'node:test';

/**
 * A Server Component cannot hand a Client Component a FUNCTION - only data. `next dev` is forgiving about it in places and the
 * production build is not: the Design page threw "Functions cannot be passed directly to Client Components" the moment it rendered
 * on the live deployment (digest 2040980966), while every unit test, every live verifier and the build itself had passed - none of
 * them renders that page. This reads the source instead: in every server file, every Client Component imported from a sibling file is
 * checked for an inline function passed as a prop.
 */

const isClient = (source: string) => /^\s*['"]use client['"]/.test(source);

/** [component, prop] pairs where a server file passes an inline function to a client component it imports from a relative path. */
export function functionPropsPassedToClient(source: string, clientNames: ReadonlySet<string>): Array<[string, string]> {
  const hits: Array<[string, string]> = [];
  for (const name of clientNames) {
    for (const m of source.matchAll(new RegExp(`<${name}\\b`, 'g'))) {
      let depth = 0;
      let j = m.index + m[0].length;
      const start = j;
      for (; j < source.length; j += 1) {
        const c = source[j];
        if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
        else if (c === '>' && depth === 0 && source[j - 1] !== '=') break;
      }
      const attrs = source.slice(start, j);
      for (const a of attrs.matchAll(/(\w+)=\{\s*(?:async\s*)?(?:function\b|\(?[\w,\s{}:]*\)?\s*=>)/g)) hits.push([name, a[1] as string]);
    }
  }
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

function clientImports(file: string, source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.[^']*)'/g)) {
    const base = normalize(join(dirname(file), m[2] as string));
    const target = [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx')].find((c) => existsSync(c));
    if (!target || !isClient(readFileSync(target, 'utf8'))) continue;
    for (const raw of (m[1] as string).split(',')) {
      const n = raw.trim().split(' as ').pop()?.trim() ?? '';
      if (/^[A-Z]/.test(n)) names.add(n);
    }
  }
  return names;
}

describe('a Server Component hands a Client Component data, never a function', () => {
  test('the detector sees the bug that reached production - and ignores what is allowed (its positive and negative twin)', () => {
    const bad = `<ReplyInbox projectId={projectId} replies={rows} mayAct={ok} dateTime={(iso) => when(iso)} />`;
    assert.deepEqual(functionPropsPassedToClient(bad, new Set(['ReplyInbox'])), [['ReplyInbox', 'dateTime']]);
    const alsoBad = `<Panel\n  onPick={async (id) => { await go(id); }}\n  label="x"\n/>`;
    assert.deepEqual(functionPropsPassedToClient(alsoBad, new Set(['Panel'])), [['Panel', 'onPick']]);
    const fine = `<ReplyInbox projectId={projectId} replies={rows.map((r) => ({ ...r, label: when(r.at) }))} mayAct={ok} />`;
    assert.deepEqual(functionPropsPassedToClient(fine, new Set(['ReplyInbox'])), [], 'a function used to BUILD data is not a function passed');
    assert.deepEqual(functionPropsPassedToClient(`<Other cb={() => 1} />`, new Set(['ReplyInbox'])), [], 'only the client components are checked');
  });

  test('no server file in app/ does it', () => {
    const offences: string[] = [];
    for (const file of walk('app')) {
      const source = readFileSync(file, 'utf8');
      if (isClient(source)) continue;
      for (const [component, prop] of functionPropsPassedToClient(source, clientImports(file, source))) offences.push(`${file}: <${component} ${prop}={function}>`);
    }
    assert.deepEqual(offences, []);
  });
});
