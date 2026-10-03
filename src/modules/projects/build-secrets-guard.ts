import { fileCredentialProblem, SECRETS_WARNING } from './file-secrets-guard';

/**
 * SCR-043 guardrail — "Secrets are referenced by secure vault, never displayed
 * in normal project UI". The Builds screen takes free text and links (a build's
 * changelog and rollback note, an environment's address and notes, a dependency's
 * reference, a readiness check's evidence link and note) that every project
 * member reads. This refuses what is recognisably a credential in any of them,
 * with the field named, and says where credentials go: Settings › Keys & secrets,
 * where they are stored encrypted and are referenced by name.
 *
 * The same recogniser the project files use (`fileCredentialProblem`: the shapes
 * in `src/lib/security/secret-patterns.ts`, a password inside a link, a
 * "password: value" line). It does not claim to find every secret.
 *
 * Pure: no server-only imports.
 */

export type BuildField = { label: string; value: string | null | undefined; isLink?: boolean };

/** Why this must not be saved, naming the field, or null when nothing recognisable is in any of them. */
export function buildCredentialProblem(fields: readonly BuildField[]): string | null {
  for (const f of fields) {
    const value = f.value?.trim();
    if (!value) continue;
    const problem = f.isLink ? fileCredentialProblem({ url: value }) : fileCredentialProblem({ description: value, ...(/^https?:\/\//i.test(value) ? { url: value } : {}) });
    if (problem) {
      // The shared sentence ends with the generic project-files warning; the build screens say it their own way.
      const lead = problem.replace(SECRETS_WARNING, '').trim();
      return `${f.label}: ${lead} Nothing was saved. Credentials are referenced by name from Settings › Keys & secrets, which stores them encrypted; they are never typed into a project screen.`;
    }
  }
  return null;
}
