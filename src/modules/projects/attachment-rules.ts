/**
 * The rules an uploaded file meets before it is stored — one place for the
 * four kinds of file round 3 added (owner decisions Q-C1, Q-C6, Q-D3 of
 * 2026-10-01), all "under the project-file rules":
 *
 *   build     an app package a build or prototype carries     apk, ipa, zip
 *   evidence  a screenshot, log or report on a test run/bug   images, text, pdf, zip, recordings
 *   meeting   a recording, image, PDF or Word file on a meeting
 *
 * The project-file rules are the 50 MB ceiling (the same one the Files tab's
 * upload door applies) and the credentials guard over the file's name and, for
 * a small text file, its first kilobytes. The database holds the same size,
 * extension and credentials-name rules in its doors (`projects.attach_file`,
 * `crm.add_meeting_evidence_file`), so a caller that skips this module cannot
 * file what it would refuse.
 *
 * Pure and client-safe: no storage, no environment, no session. The part that
 * touches storage is `attachment-store.ts`, which services import lazily so
 * a test that only needs these rules never loads the environment.
 */

/** The project-file ceiling, in bytes (src/lib/files/storage.ts MAX_UPLOAD_BYTES holds the same number). */
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

export type AttachmentArea = 'build' | 'evidence' | 'meeting';

export const BUILD_FILE_EXTENSIONS = ['apk', 'ipa', 'zip'] as const;

export const EVIDENCE_FILE_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', // screenshots
  'txt', 'log', 'md', 'json', 'csv', 'xml', 'html', 'har', // logs and reports
  'pdf', 'zip', 'mp4', 'mov', 'webm', // documents, bundles, recordings
] as const;

export const MEETING_FILE_KINDS = {
  recording: ['mp3', 'm4a', 'wav', 'ogg', 'aac', 'mp4', 'm4v', 'mov', 'webm'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'],
  document: ['pdf', 'doc', 'docx'],
} as const;
export type MeetingStoredKind = keyof typeof MEETING_FILE_KINDS;

export const AREA_EXTENSIONS: Record<'build' | 'evidence', readonly string[]> = {
  build: BUILD_FILE_EXTENSIONS,
  evidence: EVIDENCE_FILE_EXTENSIONS,
};

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** The kind of stored meeting evidence a file name is, or null when it is not a recording, an image, a PDF or a Word file. */
export function meetingStoredKind(name: string): MeetingStoredKind | null {
  const ext = extensionOf(name);
  for (const kind of Object.keys(MEETING_FILE_KINDS) as MeetingStoredKind[]) {
    if ((MEETING_FILE_KINDS[kind] as readonly string[]).includes(ext)) return kind;
  }
  return null;
}

export type AttachmentCandidate = { name: string; size: number };

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

const AREA_NOUN: Record<AttachmentArea, string> = {
  build: 'build file',
  evidence: 'evidence file',
  meeting: 'meeting file',
};

function allowedList(area: AttachmentArea): string {
  const list = area === 'meeting' ? Object.values(MEETING_FILE_KINDS).flat() : AREA_EXTENSIONS[area];
  return list.map((e) => `.${e}`).join(', ');
}

/** The checks that need no storage and no file contents: size, then the kind of file. Null when the file may go on. */
export function attachmentShapeProblem(file: AttachmentCandidate, area: AttachmentArea): string | null {
  if (file.size <= 0) return 'Choose a file to upload.';
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return `That file is ${mb(file.size)} MB; the limit is ${mb(ATTACHMENT_MAX_BYTES)} MB.`;
  }
  const ok = area === 'meeting' ? meetingStoredKind(file.name) !== null : (AREA_EXTENSIONS[area] as readonly string[]).includes(extensionOf(file.name));
  if (!ok) {
    return `A ${AREA_NOUN[area]} is one of ${allowedList(area)}; “${file.name}” is not.`;
  }
  return null;
}

/** A name safe to put in an object key: no slashes, no control characters, bounded (the same cleaning as `safeObjectName`). */
export function safeAttachmentName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'file';
}

const FOLDER: Record<AttachmentArea, string> = { build: 'builds', evidence: 'evidence', meeting: 'meetings' };

/**
 * The object key: `<organization>/<builds|evidence|meetings>/<record id>/<safe name>`.
 * The first folder is the tenant, which the bucket's policy checks; the record
 * id is the build, run, defect or meeting the file belongs to, which the
 * database door checks against the row.
 */
export function attachmentObjectPath(parts: { organizationId: string; area: AttachmentArea; recordId: string; name: string }): string {
  return `${parts.organizationId}/${FOLDER[parts.area]}/${parts.recordId}/${safeAttachmentName(parts.name)}`;
}

/** Whether a form's file input actually carried a file: an empty input posts a zero-byte File. */
export function hasChosenFile(file: unknown): file is File {
  return typeof File !== 'undefined' && file instanceof File && file.size > 0;
}
