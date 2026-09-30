import { z } from 'zod';

/**
 * Live Git — Decision: reversed by the owner on 2026-09-29. The one GitHub
 * repository a project is READ from. The shapes match the database checks in
 * 20260930130000_a_repository_is_read_from_github.sql, so a bad value is
 * refused here with a sentence rather than there with a constraint name.
 */

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export const linkRepositorySchema = z.object({
  projectId: z.uuid(),
  owner: z
    .string()
    .trim()
    .regex(OWNER, 'The owner is a GitHub user or organization name — letters, digits and hyphens.'),
  repo: z
    .string()
    .trim()
    .regex(REPO, 'The repository name is letters, digits, dots, hyphens and underscores.'),
  defaultBranch: z.string().trim().min(1, 'A branch is needed').max(200).default('main'),
});
export type LinkRepositoryInput = z.input<typeof linkRepositorySchema>;

export const unlinkRepositorySchema = z.object({ projectId: z.uuid() });
export type UnlinkRepositoryInput = z.infer<typeof unlinkRepositorySchema>;

/**
 * `owner/repo` or a full https://github.com/owner/repo[.git] link — the two
 * things a person pastes. Anything else is null, and the form says so.
 */
export function parseGithubReference(text: string): { owner: string; repo: string } | null {
  const trimmed = text.trim();
  const url = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?(?:[#?].*)?$/i);
  const short = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  const m = url ?? short;
  if (!m) return null;
  const owner = m[1]!;
  const repo = m[2]!.replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !REPO.test(repo)) return null;
  return { owner, repo };
}
