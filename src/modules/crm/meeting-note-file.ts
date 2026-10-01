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
 * Only text can be kept this way, because the evidence door stores text and a
 * reference, and no signed store exists for a recording or an image (G-229).
 * Those are refused with the reason rather than accepted and dropped.
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
    return { ok: false, message: `Only a text file can be kept as meeting evidence (${MEETING_NOTE_EXTENSIONS.map((e) => `.${e}`).join(', ')}). A recording or an image cannot be stored yet; type or paste what it says instead.` };
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
