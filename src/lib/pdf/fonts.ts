import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The two faces the quotation PDF is set in.
 *
 * Noto Sans, vendored into the repository under the SIL Open Font License
 * (see ./fonts/LICENSE), because the choice of face is not cosmetic here:
 * PDF's fourteen built-in fonts stop at WinAnsi, and WinAnsi has no ₹.
 * Every money string in this application is written by `Intl.NumberFormat`
 * with `en-IN`/`INR`, so a font without U+20B9 would mean the one document a
 * client keeps renders its prices differently from every message they were
 * sent — or crashes trying. Noto Sans carries ₹, the en-dashes and quotes the
 * copy uses, and the minus sign the discount line is rendered with.
 *
 * These are `.subset.ttf` — pre-subset with fontTools at vendor time to
 * Latin, Latin-1, Latin Extended-A, general punctuation, currency symbols
 * and U+2212 (see ./fonts/README.md for the exact command), then embedded
 * WHOLE with pdf-lib's `subset: false`. Not an optimisation quirk — a
 * correctness requirement: pdf-lib's own at-embed-time subsetting produces
 * fonts Apple's CoreGraphics renders with most glyphs missing, and the two
 * places this document will actually be opened are an iPhone and a Mac,
 * both CoreGraphics. Watched happen before this was written down: the
 * subset:true render lost 'r', 'a', 't' and most digits under macOS
 * `sips`/Preview while Chrome showed it perfectly.
 *
 * Read from disk once and cached, because the bytes never change within a
 * deploy.
 *
 * `process.cwd()`-anchored rather than `import.meta.url`-anchored: the test
 * runner, the verification scripts and the Next server all run with the
 * repository root as their working directory, and the compiled server bundle
 * keeps this path because `next.config.ts` traces `src/lib/pdf/fonts/**`
 * into the function output.
 */
const FONT_DIR = path.join(process.cwd(), 'src', 'lib', 'pdf', 'fonts');

let cached: { regular: Uint8Array; bold: Uint8Array } | null = null;

export function quotationFontBytes(): { regular: Uint8Array; bold: Uint8Array } {
  if (!cached) {
    cached = {
      regular: readFileSync(path.join(FONT_DIR, 'NotoSans_400Regular.subset.ttf')),
      bold: readFileSync(path.join(FONT_DIR, 'NotoSans_700Bold.subset.ttf')),
    };
  }
  return cached;
}
