/**
 * The one credential-shape pattern list, shared by `scripts/scan-secrets.mjs`
 * (git-history scanning) and `src/modules/qa/secret-scan.ts` (Prototype QA's
 * PA4-T030 check, scanning generated prototype content instead of source).
 *
 * Each shape is only ever produced by a real credential — no generic
 * "password" matching, which produces noise a scan gets ignored for. Kept in
 * one place so a pattern added for one scanner is not silently missing from
 * the other.
 */
export type SecretPattern = { readonly name: string; readonly re: RegExp };

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { name: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{12,}/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
];
