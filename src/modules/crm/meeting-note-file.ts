import { attachmentShapeProblem, extensionOf as fileExtension, meetingStoredKind, type MeetingStoredKind } from '@/modules/projects/attachment-rules';
import { fileCredentialProblem } from '@/modules/projects/file-secrets-guard';

/**
 * SCR-060 — "Meeting note upload", and the guardrail "Meeting extraction must
 * preserve the uploaded human source".
 *
 * A person can upload the notes or the transcript they have as a text file.
 * The file's TEXT is kept verbatim as the evidence row's body (the analysis
 * reads that body, and nothing here rewrites it), and the row names the file
 * it came from (`artifact_ref`), its media type and its size, so the source
 * is the human's own and is never replaced by a summary. A summary is a
 * separate, later evidence row (kind `summary`); the extraction proposals sit
 * beside the source and never overwrite it.
 *
 * Only text can be kept verbatim this way: the evidence door stores text as the
 * row's body. A recording, an image, a PDF or a Word file (owner decision Q-D3
 * of 2026-10-01) is stored instead — in the project-files bucket under the
 * project-file rules (50 MB, the credentials guard, the tenant's own folder) —
 * and its evidence row carries the object's path and the file's name
 * (`decideMeetingStoredFile`; migration 20261009300300). Anything else is
 * refused with the reason rather than accepted and dropped.
 *
 * Pure, so a test can hand it real files without a form.
 */

/** The door's own ceiling (crm.add_meeting_evidence: `too_long` above 20,000 characters). */
export const MEETING_NOTE_MAX_CHARS = 20_000;

/** Plain-text shapes a meeting note or transcript arrives in. `.vtt` and `.srt` are caption transcripts. */
export const MEETING_NOTE_EXTENSIONS = ['txt', 'md', 'vtt', 'srt'] as const;

export type MeetingNoteFile = { name: string; type: string; size: number; text: string };

export type MeetingNoteDecision =
  | { ok: true; kind: 'notes' | 'transcript'; body: string; reference: string; mediaType: string; byteSize: number }
  | { ok: false; message: string };

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The reference a row carries for an uploaded file: the file's name, never a path or a link. */
export function meetingNoteReference(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return `uploaded file: ${base.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200)}`;
}

export function decideMeetingNoteFile(file: MeetingNoteFile): MeetingNoteDecision {
  const extension = extensionOf(file.name);
  if (!(MEETING_NOTE_EXTENSIONS as readonly string[]).includes(extension)) {
    return { ok: false, message: `Only a text file can be kept word for word (${MEETING_NOTE_EXTENSIONS.map((e) => `.${e}`).join(', ')}). A recording, an image, a PDF or a Word file is stored as it is instead; this file is none of those.` };
  }
  if (file.size <= 0 || file.text.trim().length === 0) {
    return { ok: false, message: 'That file is empty, so there is nothing to keep.' };
  }
  if (file.text.length > MEETING_NOTE_MAX_CHARS) {
    return { ok: false, message: `That file is ${file.text.length.toLocaleString('en-IN')} characters; a meeting note is kept up to ${MEETING_NOTE_MAX_CHARS.toLocaleString('en-IN')}. Split it and upload the parts.` };
  }
  if (file.text.includes('\u0000')) {
    return { ok: false, message: 'That does not read as a text file.' };
  }
  const credential = fileCredentialProblem({ fileName: file.name, text: file.text });
  if (credential) return { ok: false, message: `The file was not kept. ${credential}` };
  return {
    ok: true,
    kind: extension === 'vtt' || extension === 'srt' ? 'transcript' : 'notes',
    body: file.text,
    reference: meetingNoteReference(file.name),
    mediaType: file.type && file.type.length <= 100 ? file.type : extension === 'md' ? 'text/markdown' : 'text/plain',
    byteSize: file.size,
  };
}

/** Which path an uploaded file takes: its text kept verbatim, the file stored as it is, or refused. */
export function routeMeetingFile(name: string): 'text' | 'stored' | 'unsupported' {
  if ((MEETING_NOTE_EXTENSIONS as readonly string[]).includes(extensionOf(name))) return 'text';
  return meetingStoredKind(name) ? 'stored' : 'unsupported';
}

/** What a stored meeting file is called on screen, by kind. */
export const MEETING_STORED_KIND_LABEL: Record<MeetingStoredKind, string> = { recording: 'recording', image: 'image', document: 'document' };

const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac',
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export type MeetingStoredFile = { name: string; type: string; size: number };

export type MeetingStoredDecision =
  | { ok: true; kind: MeetingStoredKind; reference: string; mediaType: string; byteSize: number }
  | { ok: false; message: string };

/**
 * The checks that need no storage for a recording, image, PDF or Word file:
 * it is one of those, it is not empty, it is within the project-file ceiling,
 * and its name is not a credentials file. The bytes are then stored and the
 * door `crm.add_meeting_evidence_file` files the row.
 */
export function decideMeetingStoredFile(file: MeetingStoredFile): MeetingStoredDecision {
  const kind = meetingStoredKind(file.name);
  if (!kind) return { ok: false, message: 'Only a recording, an image, a PDF or a Word file is stored as it is; a text file is kept word for word.' };
  const shape = attachmentShapeProblem({ name: file.name, size: file.size }, 'meeting');
  if (shape) return { ok: false, message: shape };
  const credential = fileCredentialProblem({ fileName: file.name });
  if (credential) return { ok: false, message: `The file was not kept. ${credential}` };
  const fallback = MEDIA_TYPE_BY_EXTENSION[fileExtension(file.name)] ?? 'application/octet-stream';
  return {
    ok: true,
    kind,
    reference: meetingNoteReference(file.name),
    mediaType: file.type && file.type.length <= 100 ? file.type : fallback,
    byteSize: file.size,
  };
}
