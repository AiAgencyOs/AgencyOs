import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import ts from 'typescript';

/**
 * Every control has a name a screen reader can read (2026-09-30).
 *
 * The screen-reader pass (axe-core plus the accessibility tree, over every
 * bucket F and G route) found 103 `<label>`s that sat BESIDE their control
 * rather than tied to it — nothing said which field they named, so a reader
 * announced an unnamed "combo box" and a click on the words focused nothing —
 * plus an invalid ARIA attribute on links, a sideways scroller a keyboard could
 * not reach, ids that collided when a form rendered twice, and initials whose
 * colours were decided by stylesheet order.
 *
 * The rules below are parsed, not pattern-matched: each walks the TypeScript
 * syntax tree of every screen and primitive, so a control moved into a
 * conditional or a `.map()` is still found.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const files: string[] = [];
const walk = (dir: string) => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith('.tsx')) files.push(full);
  }
};
walk(join(root, 'app'));
walk(join(root, 'src'));

const CONTROLS = new Set(['input', 'select', 'textarea']);
const tagOf = (n: ts.Node): string | null =>
  ts.isJsxElement(n) ? n.openingElement.tagName.getText() : ts.isJsxSelfClosingElement(n) ? n.tagName.getText() : null;
const attrsOf = (n: ts.Node): readonly ts.JsxAttributeLike[] =>
  ts.isJsxElement(n) ? n.openingElement.attributes.properties : ts.isJsxSelfClosingElement(n) ? n.attributes.properties : [];
const hasAttr = (n: ts.Node, name: string) => attrsOf(n).some((a) => ts.isJsxAttribute(a) && a.name.getText() === name);
const attrText = (n: ts.Node, name: string) => {
  const a = attrsOf(n).find((x): x is ts.JsxAttribute => ts.isJsxAttribute(x) && x.name.getText() === name);
  return a?.initializer?.getText() ?? null;
};
const containsControl = (n: ts.Node): boolean => {
  let found = false;
  const w = (c: ts.Node) => {
    const t = tagOf(c);
    if (t && CONTROLS.has(t)) found = true;
    // A label that takes `{children}` is a slot: the control arrives from the caller, inside it.
    if (ts.isJsxExpression(c) && c.expression?.getText() === 'children') found = true;
    ts.forEachChild(c, w);
  };
  ts.forEachChild(n, w);
  return found;
};

type Site = { file: string; line: number; text: string };
const parsed = files.map((file) => {
  const text = readFileSync(file, 'utf8');
  return { file: file.slice(root.length), sf: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) };
});
const where = (sf: ts.SourceFile, n: ts.Node, file: string): Site => ({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: n.getText().slice(0, 80).replace(/\s+/g, ' ') });
const collect = (pick: (n: ts.Node, sf: ts.SourceFile) => boolean): Site[] => {
  const out: Site[] = [];
  for (const { file, sf } of parsed) {
    const v = (n: ts.Node) => {
      if (pick(n, sf)) out.push(where(sf, n, file));
      ts.forEachChild(n, v);
    };
    v(sf);
  }
  return out;
};
const show = (sites: Site[]) => sites.map((s) => `${s.file}:${s.line}  ${s.text}`);

describe('A. a label is tied to what it names', () => {
  test('there are labels to check at all', () => {
    // Without this every assertion below passes on an empty list — the exact
    // defect `a-pin-that-cannot-fail` exists to catch.
    const labels = collect((n) => tagOf(n) === 'label');
    assert.ok(labels.length > 150, `only ${labels.length} <label> elements found — the scan broke`);
  });

  test('every <label> either has htmlFor or wraps the control it names', () => {
    const loose = collect((n) => {
      if (!ts.isJsxElement(n) || tagOf(n) !== 'label') return false;
      return !hasAttr(n, 'htmlFor') && !containsControl(n);
    });
    assert.deepEqual(show(loose), []);
  });

  test('a wrapping label names exactly one control', () => {
    const many = collect((n) => {
      if (!ts.isJsxElement(n) || tagOf(n) !== 'label' || hasAttr(n, 'htmlFor')) return false;
      let count = 0;
      const w = (c: ts.Node) => {
        const t = tagOf(c);
        if (t && CONTROLS.has(t) && !(t === 'input' && /type=["']hidden["']/.test(c.getText()))) count += 1;
        ts.forEachChild(c, w);
      };
      ts.forEachChild(n, w);
      return count > 1;
    });
    // A label can name only its first control; a second would read unnamed.
    assert.deepEqual(show(many), []);
  });

  test('a form that renders more than once on a page takes its ids from useId()', () => {
    // A fixed id is fine for a page rendered once; in a form that appears per
    // row or per drawer it ties every label to the first field (axe:
    // duplicate-id-aria). The two the pass caught:
    const tags = readFileSync(join(root, 'app/(internal)/leads/[leadId]/sales-panel.tsx'), 'utf8');
    assert.match(tags, /const tagsId = useId\(\);/);
    assert.match(tags, /htmlFor=\{tagsId\}/);
    assert.doesNotMatch(tags, /id="lead-tags"/);
    const service = readFileSync(join(root, 'app/(internal)/leads/[leadId]/service-form.tsx'), 'utf8');
    assert.match(service, /const listId = useId\(\);/);
    assert.match(service, /list=\{listId\}/);
    assert.doesNotMatch(service, /lead-service-suggestions/);
  });
});

describe('B. a control with no visible label carries its own name', () => {
  test('a select without a wrapping label or htmlFor has aria-label', () => {
    const bare = collect((n) => {
      if (tagOf(n) !== 'select') return false;
      if (hasAttr(n, 'aria-label') || hasAttr(n, 'aria-labelledby') || hasAttr(n, 'id')) return false;
      // wrapped by a label?
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        if (ts.isJsxElement(p) && tagOf(p) === 'label') return false;
        if (ts.isFunctionLike(p)) break;
      }
      return true;
    });
    assert.deepEqual(show(bare), []);
  });
});

describe('C. ARIA is used the way the specification allows', () => {
  test('aria-pressed is on a button, never a link', () => {
    const bad = collect((n) => (tagOf(n) === 'Link' || tagOf(n) === 'a') && hasAttr(n, 'aria-pressed'));
    // A link is a destination, not a toggle: `aria-current` says which one is on.
    assert.deepEqual(show(bad), []);
  });

  test('a region that scrolls sideways can take focus', () => {
    const src = readFileSync(join(root, 'src/ui/primitives/timeline.tsx'), 'utf8');
    assert.match(src, /<ol tabIndex=\{0\} aria-label=\{label\}/);
  });

  test('a page has one h1: a second PageHeader on a page says it is a section', () => {
    const builds = readFileSync(join(root, 'app/(internal)/projects/[projectId]/builds/page.tsx'), 'utf8');
    assert.equal((builds.match(/<PageHeader\s+as="h2"/g) ?? []).length, 2);
    const header = readFileSync(join(root, 'src/ui/primitives/page-header.tsx'), 'utf8');
    assert.match(header, /as: Heading = 'h1'/);
  });
});

describe('D. initials are legible, by construction', () => {
  const avatar = readFileSync(join(root, 'src/ui/primitives/avatar.tsx'), 'utf8');

  test('the sidebar and solid looks are variants, not class overrides', () => {
    assert.match(avatar, /sidebar: 'bg-sidebar-bg text-sidebar-fg'/);
    assert.match(avatar, /solid: 'bg-brand text-brand-fg'/);
    // the variant REPLACES the tint rather than sitting beside it
    assert.match(avatar, /tone === 'sidebar' \|\| tone === 'solid' \? AVATAR_FIXED\[tone\] : AVATAR_TINT\[tone \?\? toneFor\(name\)\]/);
  });

  test('no screen overrides an avatar\'s colours with className', () => {
    // Both are utilities of equal weight; the stylesheet's order decided, and
    // it decided badly (light initials on a light tint, 1.2:1).
    const clash = collect((n) => tagOf(n) === 'Avatar' && /className=/.test(n.getText()) && /\b(bg|text)-[a-z]/.test(attrText(n, 'className') ?? ''));
    assert.deepEqual(show(clash), []);
  });

  test('the pipeline strip\'s stage labels are not faded below 4.5:1', () => {
    const src = readFileSync(join(root, 'src/ui/primitives/pipeline-strip.tsx'), 'utf8');
    assert.doesNotMatch(src, /text-\[11px\] font-medium opacity-80/);
  });
});
