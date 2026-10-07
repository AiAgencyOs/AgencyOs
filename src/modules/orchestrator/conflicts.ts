/**
 * Concurrency and conflict analysis - Phase 5 Orchestrator spec section 7: "Detect overlapping file ownership before parallel dispatch" and
 * "treat shared schema, central configuration, auth middleware and high-conflict files as serialized unless proven safe".
 *
 * Pure, and the planning half of a rule whose enforcing half is in the database: `projects.claim_concurrency_lease` refuses an overlapping lease, and
 * `projects.lease_scope_key` / `projects.lease_scopes_overlap` there are what `leaseScopeKey` / `scopesOverlap` here mirror. The HIGH_CONFLICT_PATHS
 * list is the same list as `projects.high_conflict_paths()`; a test holds the two equal, so a path added to one and not the other fails the build.
 *
 * Analysing is advice about what MAY run together. It claims nothing: a lease is what holds files, and only the database door grants one.
 */

/** Files two agents must never edit at once, even when their names differ: shared schema, central config, auth, the event catalog, the registry. */
export const HIGH_CONFLICT_PATHS: readonly string[] = [
  'supabase/migrations',
  'supabase/seed.sql',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'next.config.ts',
  'proxy.ts',
  'src/lib/db/types.ts',
  'src/lib/events/catalog.ts',
  'src/modules/agents/registry.ts',
  'src/lib/auth',
  '.github/workflows',
];

/** A path as a directory-or-file key: a glob is cut at its first wildcard segment (broader is the safe error), the whole repository is the empty key. */
export function scopeBase(path: string): string {
  const cleaned = path.trim().replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
  const kept: string[] = [];
  for (const segment of cleaned.split('/')) {
    if (/[*?[{]/.test(segment)) break;
    if (segment === '' || segment === '.') continue;
    kept.push(segment);
  }
  return kept.join('/');
}

/** The key two scopes are compared on: `scopeBase`, except that anything under a high-conflict path IS that path. */
export function leaseScopeKey(path: string): string {
  const key = scopeBase(path);
  for (const hc of HIGH_CONFLICT_PATHS) {
    if (key === hc || key.startsWith(`${hc}/`)) return hc;
  }
  return key;
}

function keysOverlap(a: string, b: string): boolean {
  return a === '' || b === '' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Do two sets of paths touch the same files? A directory overlaps what is in it; `src/ui` does not overlap `src/uikit`. */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => keysOverlap(leaseScopeKey(x), leaseScopeKey(y))));
}

/** The paths of `a` that overlap something in `b`, as written (for a reason a person can read). */
export function overlappingPaths(a: readonly string[], b: readonly string[]): string[] {
  return a.filter((x) => b.some((y) => keysOverlap(leaseScopeKey(x), leaseScopeKey(y))));
}

export function isHighConflictPath(path: string): boolean {
  return HIGH_CONFLICT_PATHS.includes(leaseScopeKey(path));
}

export type ConflictTask = {
  id: string;
  /** The files or directories the task expects to change (`projects.tasks.affected_paths`). Empty = not declared. */
  filePaths: readonly string[];
  /** Task ids this task waits for (`projects.task_dependencies`). */
  dependsOn?: readonly string[];
};

export type TaskConflict = {
  a: string;
  b: string;
  /** Why these two may not run together. */
  reason: 'overlapping_files' | 'high_conflict_path' | 'undeclared_scope';
  paths: string[];
};

export type ConflictAnalysis = {
  /** Every pair that may not run at once, with the reason. Sequenced pairs (one waits for the other) are not here. */
  conflicts: TaskConflict[];
  /** Tasks that conflict with nothing: safe to dispatch in parallel with anything else in the set. */
  parallel: string[];
  /** Groups of tasks that touch each other's files, in the order they should run (dependencies first, then input order). */
  serialized: string[][];
};

/** Every task `id` waits for, directly or through a chain. */
function ancestors(id: string, byId: ReadonlyMap<string, ConflictTask>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(byId.get(id)?.dependsOn ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(byId.get(next)?.dependsOn ?? []));
  }
  return seen;
}

/**
 * Which of these ready tasks may run at the same time.
 *
 * Two tasks conflict when their files overlap and neither waits for the other. A task that declares no files cannot be proven safe, so it conflicts
 * with every other task: "serialized unless proven safe", not "parallel unless proven unsafe".
 */
export function analyzeConflicts(tasks: readonly ConflictTask[]): ConflictAnalysis {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const up = new Map(tasks.map((t) => [t.id, ancestors(t.id, byId)]));
  const conflicts: TaskConflict[] = [];

  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const a = tasks[i] as ConflictTask;
      const b = tasks[j] as ConflictTask;
      if (up.get(a.id)?.has(b.id) || up.get(b.id)?.has(a.id)) continue; // sequenced: one waits for the other, so they never run at once
      if (a.filePaths.length === 0 || b.filePaths.length === 0) {
        conflicts.push({ a: a.id, b: b.id, reason: 'undeclared_scope', paths: [] });
        continue;
      }
      const shared = overlappingPaths(a.filePaths, b.filePaths);
      if (shared.length === 0) continue;
      const high = shared.some(isHighConflictPath) || overlappingPaths(b.filePaths, a.filePaths).some(isHighConflictPath);
      conflicts.push({ a: a.id, b: b.id, reason: high ? 'high_conflict_path' : 'overlapping_files', paths: shared });
    }
  }

  const involved = new Set(conflicts.flatMap((c) => [c.a, c.b]));
  const parallel = tasks.filter((t) => !involved.has(t.id)).map((t) => t.id);

  // connected components of the conflict graph, each ordered: a task after the ones it waits for, otherwise as given
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) as string;
    parent.set(x, root);
    return root;
  };
  for (const id of involved) parent.set(id, id);
  for (const c of conflicts) parent.set(find(c.a), find(c.b));
  const groups = new Map<string, string[]>();
  for (const t of tasks) {
    if (!involved.has(t.id)) continue;
    const root = find(t.id);
    groups.set(root, [...(groups.get(root) ?? []), t.id]);
  }
  const serialized = [...groups.values()].map((ids) => {
    // dependencies first (a partial order, so picked one at a time rather than by a comparator), otherwise as given
    const remaining = [...ids];
    const ordered: string[] = [];
    while (remaining.length > 0) {
      const index = remaining.findIndex((id) => !remaining.some((other) => other !== id && up.get(id)?.has(other)));
      ordered.push(...remaining.splice(index === -1 ? 0 : index, 1));
    }
    return ordered;
  });

  return { conflicts, parallel, serialized };
}
