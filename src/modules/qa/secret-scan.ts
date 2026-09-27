import { SECRET_PATTERNS } from '@/lib/security/secret-patterns';

/**
 * Prototype QA's PA4-T030: "Build contains provider/API secret → Security
 * FAIL." Deterministic by design — this scans already-validated structured
 * JSON (`prototypeBuildSchema`'s `screens`), not raw text, so it costs
 * nothing and never depends on a model to notice what it was told to avoid
 * in the prompt.
 *
 * Shares its pattern list with `scripts/scan-secrets.mjs` (source/history
 * scanning) via `src/lib/security/secret-patterns.ts`, so a shape added for
 * one scanner is not silently missing from the other.
 */

type ScannableScreen = {
  readonly screenKey?: string;
  readonly elements?: ReadonlyArray<{ readonly label?: string; readonly navigatesTo?: string }>;
};

export type SecretFinding = {
  readonly screenKey: string;
  readonly elementIndex: number;
  readonly pattern: string;
};

export function scanPrototypeBuildForSecrets(screens: readonly ScannableScreen[]): SecretFinding[] {
  const findings: SecretFinding[] = [];

  for (const screen of screens) {
    const screenKey = screen.screenKey ?? '(unknown screen)';
    (screen.elements ?? []).forEach((element, elementIndex) => {
      const text = element.label ?? '';
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(text)) {
          findings.push({ screenKey, elementIndex, pattern: name });
        }
      }
    });
  }

  return findings;
}
