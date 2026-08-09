import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * Guards two constraints that are easy to state and easy to violate by
 * accident later: **the billing flow contacts no payment provider, and needs
 * no AI key.**
 *
 * A source scan rather than a mock, because the thing being asserted is the
 * absence of a dependency. A mocked gateway would prove the opposite — that
 * there is one to mock.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Files that make up the milestone → invoice → payment → unlock path.
 *
 * `app/api/jobs/run/route.ts` is deliberately absent: it also hosts the AI
 * extraction job, so it legitimately imports a model client. The claim about
 * the unlock path being model-free is asserted separately, further down, by
 * checking that it returns before any provider is resolved.
 */
const SURFACES = [
  'src/modules/finance',
  'src/modules/projects/handlers.ts',
  'src/lib/events',
  'app/(internal)/invoices',
  'app/(internal)/projects',
];

/** Package names that would mean a real payment integration had appeared. */
const GATEWAYS = [
  'razorpay',
  'stripe',
  'paypal',
  'braintree',
  'square',
  'cashfree',
  'payu',
  'phonepe',
  'paytm',
  'adyen',
];

/** Package names that would mean the flow had grown a model dependency. */
const AI_PACKAGES = ['@anthropic-ai/sdk', 'openai', '@google/generative-ai', 'langchain'];

function sourceFiles(relative: string): string[] {
  const absolute = join(root, relative);
  if (!statSync(absolute).isDirectory()) return [absolute];

  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(relative, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(absolute, entry.name)]
        : [],
  );
}

/** Every module specifier a file imports, ignoring comments and prose. */
function importedModules(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /^\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

const files = SURFACES.flatMap(sourceFiles);

describe('the billing flow has no external dependencies', () => {
  test('there are files to scan, so a passing result means something', () => {
    assert.ok(files.length >= 8, `expected the billing surfaces to exist, found ${files.length}`);
  });

  for (const file of files) {
    const relative = file.slice(root.length);
    const imports = importedModules(readFileSync(file, 'utf8'));

    test(`${relative} imports no payment gateway`, () => {
      for (const specifier of imports) {
        for (const gateway of GATEWAYS) {
          assert.ok(
            !specifier.toLowerCase().includes(gateway),
            `${relative} imports ${specifier}; payment gateway integration is not part of this milestone`,
          );
        }
      }
    });

    test(`${relative} needs no AI client`, () => {
      for (const specifier of imports) {
        assert.ok(
          !AI_PACKAGES.includes(specifier) && !specifier.startsWith('@/lib/ai'),
          `${relative} imports ${specifier}; generating an invoice must not require a model`,
        );
      }
    });
  }

  test('no payment provider package is declared as a dependency', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });

    for (const name of declared) {
      for (const gateway of GATEWAYS) {
        assert.ok(!name.toLowerCase().includes(gateway), `${name} is a payment gateway package`);
      }
    }
  });

  /**
   * The unlock path must not depend on AI configuration.
   *
   * The runner hosts both the extraction job (which needs a model) and the
   * milestone unlock (which does not). The guarantee that an unconfigured
   * provider cannot block a paid client's project is structural: unlocks are
   * drained and returned *before* `resolveProvider` is ever called. Asserting
   * the order is asserting the guarantee — reordering these would silently
   * couple the revenue path to an API key.
   */
  test('the job runner completes milestone unlocks before touching any model', () => {
    const route = readFileSync(join(root, 'app/api/jobs/run/route.ts'), 'utf8');

    const unlockReturn = route.indexOf('unlocks.claimed > 0');
    const providerCall = route.indexOf('resolveProvider(');

    assert.ok(unlockReturn > 0, 'the runner no longer drains unlock jobs');
    assert.ok(providerCall > 0, 'the runner no longer resolves a model provider');
    assert.ok(
      unlockReturn < providerCall,
      'unlock jobs must return before a model provider is resolved',
    );
  });

  test('the AI API key is optional, so billing runs without one', () => {
    const env = readFileSync(join(root, 'src/lib/env.ts'), 'utf8');
    assert.match(
      env,
      /ANTHROPIC_API_KEY:[^\n]*\.optional\(\)/,
      'ANTHROPIC_API_KEY must stay optional or invoice generation would require a model key',
    );
  });
});
