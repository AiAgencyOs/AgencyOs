import { z } from 'zod';

import { PROJECT_FILE_CATEGORIES } from './schema';

/**
 * A project's folders — owner decision 7, migration 20261005100400. A folder is
 * a record (project, category, path), so an empty folder exists; a file is
 * filed into a folder by the `folder` column it already had. The path shape is
 * the one the file column has always enforced: no leading or trailing slash,
 * no "//", no "..", at most 200 characters; "a/b" is a folder "b" inside "a".
 */
export const FOLDER_PATH_MAX = 200;

/** "  Mockups / Mobile  " → "Mockups/Mobile": trims each segment and drops empty ones. */
export function cleanFolderPath(raw: string): string {
  return raw
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('/');
}

/** Why a path cannot be a folder, in words, or null when it can. */
export function folderPathProblem(path: string): string | null {
  if (path === '') return 'Give the folder a name.';
  if (path.length > FOLDER_PATH_MAX) return `A folder path is at most ${FOLDER_PATH_MAX} characters.`;
  if (path.split('/').some((segment) => segment === '.' || segment === '..' || segment.includes('..'))) return 'A folder name cannot contain "..".';
  return null;
}

/** The parent of a path ("a/b" → "a"), or '' for a top-level folder. */
export function parentFolder(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export type FolderNode = { category: string; path: string; depth: number; files: number };

/**
 * The folder tree from the folder RECORDS (so an empty folder is drawn) and the
 * files' own folder paths (a file counts toward its folder and every ancestor).
 */
export function folderNodes(folders: readonly { category: string; path: string }[], files: readonly { category: string; folder: string }[]): FolderNode[] {
  return [...folders]
    .sort((a, b) => (a.category === b.category ? a.path.localeCompare(b.path) : a.category.localeCompare(b.category)))
    .map((f) => ({
      category: f.category,
      path: f.path,
      depth: f.path.split('/').length - 1,
      files: files.filter((x) => x.category === f.category && (x.folder === f.path || x.folder.startsWith(`${f.path}/`))).length,
    }));
}

export const createProjectFolderSchema = z.object({
  projectId: z.uuid(),
  category: z.enum(PROJECT_FILE_CATEGORIES),
  path: z.string().transform(cleanFolderPath).refine((p) => folderPathProblem(p) === null, { message: 'That is not a usable folder name.' }),
});
export type CreateProjectFolderInput = z.input<typeof createProjectFolderSchema>;

export const fileIntoFolderSchema = z.object({
  projectId: z.uuid(),
  fileId: z.uuid(),
  /** '' = the category root. */
  path: z.string().transform(cleanFolderPath),
});
export type FileIntoFolderInput = z.input<typeof fileIntoFolderSchema>;
