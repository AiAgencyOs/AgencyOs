import regeneratorRuntime from 'regenerator-runtime';
import fontkit from '@pdf-lib/fontkit';
import type { Color, PDFPage } from 'pdf-lib';

/**
 * A font whose text is SHAPED, then drawn glyph by glyph as vector outlines.
 *
 * Why this exists. `pdf-lib` writes embedded text as a run of glyph ids laid
 * out left to right by each glyph's own advance. Latin is fine with that.
 * Devanagari is not: a vowel sign (ि) is written after its consonant but drawn
 * before it, consonants join into conjuncts (क्ष), and marks (ं, ़, the signs
 * under a letter) sit at offsets the font's positioning tables give — pdf-lib
 * applies none of it, and a Hindi quotation came out with every sign detached
 * and the spacing wrong (checked on a rendered page, 2026-10-03). `fontkit`
 * does shape it correctly, so the shaping is taken from there and each glyph's
 * outline is drawn at the position the shaper gave.
 *
 * Cost, stated: the text in such a PDF is drawn outlines, not selectable or
 * searchable text. It looks the same in every viewer — including the iPhone
 * viewer a WhatsApp-delivered PDF is opened in, where pre-subset embedded
 * fonts already needed care.
 *
 * `fontkit`'s Indic shaper is compiled to need a global `regeneratorRuntime`;
 * it is provided here, before any layout call, from the dependency of the same
 * name.
 */
(globalThis as { regeneratorRuntime?: unknown }).regeneratorRuntime ??= regeneratorRuntime;

type FkGlyph = { path: { transform(a: number, b: number, c: number, d: number, e: number, f: number): { toSVG(): string; commands: unknown[] } } };
type FkPosition = { xAdvance: number; yAdvance: number; xOffset: number; yOffset: number };
type FkGlyph2 = FkGlyph & { name?: string };
type FkFont = {
  unitsPerEm: number;
  characterSet: number[];
  /** fontkit's cache of Glyph objects by id; the shaper leaves per-run state on them. */
  _glyphs?: Record<number, unknown>;
  layout(text: string): { glyphs: FkGlyph2[]; positions: FkPosition[] };
};

export class ShapedFont {
  private readonly font: FkFont;
  private readonly cache = new Map<string, { svg: string; empty: boolean }>();

  constructor(bytes: Uint8Array) {
    this.font = (fontkit as unknown as { create(b: Uint8Array): FkFont }).create(bytes);
  }

  /**
   * Shape `text` from a clean slate.
   *
   * fontkit caches Glyph objects by id and its Indic shaper leaves per-run
   * state on them, so the result of one layout can depend on what was laid out
   * BEFORE it: after "ऐप" the next "इसमें" came back as े + a dotted circle ◌
   * + ं instead of the single ें glyph — in the quotation, in a section label,
   * and not when the same string was shaped alone (found by rendering a Hindi
   * quotation and looking at it; bisected to the glyph cache). Emptying the
   * cache before each layout removes the dependence. The cache is private to
   * fontkit, so it is cleared only where it exists.
   */
  private shape(text: string): { glyphs: FkGlyph2[]; positions: FkPosition[] } {
    if (this.font._glyphs) this.font._glyphs = {};
    return this.font.layout(text);
  }

  /** The glyph names a string shapes to — for tests, which cannot read outlines. */
  glyphNames(text: string): string[] {
    return this.shape(text).glyphs.map((g) => g.name ?? '');
  }

  /** The code points the font can draw, plus the two joiners the shaper consumes. */
  getCharacterSet(): number[] {
    return [...this.font.characterSet, 0x200c, 0x200d];
  }

  widthOfTextAtSize(text: string, size: number): number {
    if (text === '') return 0;
    const run = this.shape(text);
    let units = 0;
    for (const p of run.positions) units += p.xAdvance;
    return (units * size) / this.font.unitsPerEm;
  }

  drawText(page: PDFPage, text: string, o: { x: number; y: number; size: number; color?: Color }): void {
    if (text === '') return;
    const run = this.shape(text);
    const scale = o.size / this.font.unitsPerEm;
    let penUnits = 0;
    run.glyphs.forEach((glyph, i) => {
      const pos = run.positions[i]!;
      // Outlines are y-up font units; `drawSvgPath` takes y-down, so flip once.
      const flipped = glyph.path.transform(1, 0, 0, -1, 0, 0);
      if (flipped.commands.length > 0) {
        page.drawSvgPath(flipped.toSVG(), {
          x: o.x + (penUnits + pos.xOffset) * scale,
          y: o.y + pos.yOffset * scale,
          scale,
          ...(o.color ? { color: o.color } : {}),
          borderWidth: 0,
        });
      }
      penUnits += pos.xAdvance;
    });
  }
}
