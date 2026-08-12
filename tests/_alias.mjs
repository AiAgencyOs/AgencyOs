/**
 * Module resolution for the test runner.
 *
 * Application code is written for the Next/tsc resolver: imports use the `@/`
 * alias from tsconfig.json, and relative imports omit their extension. Node
 * reads neither tsconfig nor those conventions, so until now a test could not
 * import a module that used them — which is why modules behind the alias were
 * asserted as source text rather than called.
 *
 * Two rules, both purely about *finding* a file:
 *
 *   @/lib/result   →  src/lib/result.ts
 *   ./errors       →  <dir>/errors.ts
 *   next/cache     →  tests/_stubs/next-cache.mjs
 *
 * Loaded with `--import` so it is in place before any test module is
 * evaluated. It changes nothing about what the resolved modules do.
 */

import { existsSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');

/**
 * Next's server entry points, which do not resolve outside a Next build.
 *
 * `next/cache` is the reason a `'use server'` module could only be asserted as
 * source text rather than executed: importing it from plain Node fails with
 * ERR_MODULE_NOT_FOUND before the test ever runs. Mapping it to an inert stub
 * makes an action module an ordinary module of async functions again, which is
 * what it is at run time anyway.
 *
 * Resolution only. A test that cares what the action revalidated still says so
 * with `mock.module('next/cache', …)`, which now has something to resolve.
 */
const NEXT_STUBS = {
  'next/cache': join(here, '_stubs', 'next-cache.mjs'),
};

/** The extensions tsc would try, in the order it would try them. */
const CANDIDATES = ['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx'];

/** First existing candidate for a path written without an extension. */
function probe(basePath) {
  if (existsSync(basePath) && !basePath.endsWith('/')) {
    // Only accept a bare hit when it is a file, not the directory an
    // `/index.ts` lookup is really after.
    try {
      if (!statSync(basePath).isDirectory()) return basePath;
    } catch {
      /* fall through to the candidates */
    }
  }
  return CANDIDATES.map((ext) => `${basePath}${ext}`).find((path) => existsSync(path));
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Next server entry points, which plain Node cannot resolve.
    if (Object.hasOwn(NEXT_STUBS, specifier)) {
      return nextResolve(pathToFileURL(NEXT_STUBS[specifier]).href, context);
    }

    // `@/x` — the tsconfig alias.
    if (specifier.startsWith('@/')) {
      const found = probe(join(src, specifier.slice(2)));
      if (found) return nextResolve(pathToFileURL(found).href, context);
    }

    // `./x` or `../x` with no extension, but only from our own source. Package
    // code in node_modules has its own working resolution and must be left
    // entirely alone — rewriting a dependency's internal require breaks it.
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !/\.[cm]?[jt]sx?$/.test(specifier) &&
      context.parentURL?.startsWith('file:')
    ) {
      const parent = dirname(fileURLToPath(context.parentURL));
      if (parent.startsWith(src)) {
        const found = probe(join(parent, specifier));
        if (found) return nextResolve(pathToFileURL(found).href, context);
      }
    }

    return nextResolve(specifier, context);
  },
});
