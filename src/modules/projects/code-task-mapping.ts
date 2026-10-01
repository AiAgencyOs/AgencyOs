/**
 * SCR-042 guardrail — "Every code artifact should map to project/task and review
 * evidence". The project half is the repository link itself. The task half is
 * read here from the two facts the panel already holds, and nothing is guessed:
 *
 *   * a commit maps to a task when a person (or the commit door) linked its sha
 *     to a task (`projects.commit_links`);
 *   * a pull request maps to a task when its head branch is one the panel made
 *     for that task, `task/<first 8 characters of the task id>-<slug>`
 *     (`taskBranchName` in src/lib/git/github-write.ts).
 *
 * Anything else is reported as not mapped, in words, rather than left silent.
 * Pure: no server-only imports.
 */

export type TaskRef = { id: string; title: string };
export type CommitLinkRef = { sha: string; taskId: string };

/** The task a pull request's head branch was made for, or null when it is not a panel task branch or matches no task (or more than one). */
export function taskForBranch(headBranch: string, tasks: readonly TaskRef[]): TaskRef | null {
  const m = /^task\/([0-9a-f]{8})(?:-|$)/.exec(headBranch.trim().toLowerCase());
  if (!m) return null;
  const matches = tasks.filter((t) => t.id.toLowerCase().startsWith(m[1]!));
  return matches.length === 1 ? matches[0]! : null;
}

/** The task a commit sha was linked to, or null. A short sha matches a stored full sha by prefix (7 or more characters). */
export function taskForCommit(sha: string, links: readonly CommitLinkRef[], tasks: readonly TaskRef[]): TaskRef | null {
  const s = sha.trim().toLowerCase();
  if (s.length < 7) return null;
  const link = links.find((l) => {
    const stored = l.sha.toLowerCase();
    return stored === s || stored.startsWith(s) || s.startsWith(stored);
  });
  return link ? (tasks.find((t) => t.id === link.taskId) ?? null) : null;
}

export type MappingSummary = { commits: { mapped: number; total: number }; pullRequests: { mapped: number; total: number } };

export function summariseMapping(input: {
  commits: readonly { sha: string }[];
  pullRequests: readonly { headBranch: string }[];
  links: readonly CommitLinkRef[];
  tasks: readonly TaskRef[];
}): MappingSummary {
  return {
    commits: { mapped: input.commits.filter((c) => taskForCommit(c.sha, input.links, input.tasks)).length, total: input.commits.length },
    pullRequests: { mapped: input.pullRequests.filter((p) => taskForBranch(p.headBranch, input.tasks)).length, total: input.pullRequests.length },
  };
}
