import { z } from 'zod';

import { WATCH_PHASES } from './project-defaults-schema';
import { cleanFolderPath, folderPathProblem } from './project-folder-schema';
import { PROJECT_FILE_CATEGORIES } from './schema';

/**
 * The organisation's project defaults (PDF §7, migration 20261006200000):
 * which phase changes a NEW watcher follows by default, and the standard
 * folders every NEW project starts with. Existing projects are never touched.
 *
 * Folder lines are written `category/path` — "documents/Contracts",
 * "qa/Test reports/Round 1" — and parsed here into `{ category, path }`.
 * The group-name pattern is deliberately not editable here: it is the PDF's
 * fixed `project // price // start date // client` (see the page).
 */
export type StandardFolder = { category: (typeof PROJECT_FILE_CATEGORIES)[number]; path: string };

export function parseFolderLines(text: string): { folders: StandardFolder[]; problem: string | null } {
  const folders: StandardFolder[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const slash = line.indexOf('/');
    const head = (slash < 0 ? line : line.slice(0, slash)).trim().toLowerCase();
    const category = PROJECT_FILE_CATEGORIES.find((c) => c === head);
    if (!category) return { folders: [], problem: `“${line}” must start with a category: ${PROJECT_FILE_CATEGORIES.join(', ')}.` };
    const path = cleanFolderPath(slash < 0 ? '' : line.slice(slash + 1));
    const problem = folderPathProblem(path);
    if (problem) return { folders: [], problem: `“${line}”: ${problem}` };
    const key = `${category}/${path.toLowerCase()}`;
    if (seen.has(key)) return { folders: [], problem: `“${line}” is listed twice.` };
    seen.add(key);
    folders.push({ category, path });
  }
  if (folders.length > 40) return { folders: [], problem: 'At most 40 standard folders.' };
  return { folders, problem: null };
}

export function folderLines(folders: readonly StandardFolder[]): string {
  return folders.map((f) => `${f.category}/${f.path}`).join('\n');
}

export const setOrgProjectDefaultsSchema = z.object({
  watchPhases: z.array(z.enum(WATCH_PHASES)),
  folderText: z.string().max(8000),
});
export type SetOrgProjectDefaultsInput = z.input<typeof setOrgProjectDefaultsSchema>;
