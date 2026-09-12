/**
 * Turning a meeting command's database verdict into an app-layer answer —
 * pure, so every sentence a form can show is tested without a database.
 *
 * The four doors G-237 adds (`crm.cancel_meeting`, `crm.complete_meeting`,
 * `crm.record_no_show`, `crm.add_meeting_evidence`) answer NAMES, and this is
 * the one place a name becomes a sentence. Two properties are held here and
 * tested: every name the migration can return has a sentence (a stranger is
 * still said, as itself, never as success), and nothing here turns a refusal
 * into a success — `not_yet_started` is a refusal even though the operator
 * meant well, because a meeting cannot have happened before it began.
 */

export type CommandErrorCode = 'VALIDATION' | 'FORBIDDEN' | 'NOT_FOUND' | 'INTERNAL';

export type CommandDecision =
  | { kind: 'done'; message: string }
  | { kind: 'error'; code: CommandErrorCode; message: string };

const FORBIDDEN = 'The database refused: this meeting is not yours, or your role cannot write to it.';
const NOT_FOUND = 'Meeting not found.';
const NO_ACTOR = 'A meeting is concluded by a person; no signed-in person was found on this request.';
const UNKNOWN_ACTOR = 'Your sign-in has no user record here, so the conclusion cannot be attributed to you.';
const NOT_YET_STARTED = 'This meeting has not reached its agreed start; nothing can have happened at it yet.';
const NOTE_TOO_LONG = 'The note is longer than 20,000 characters.';

const refuse = (code: CommandErrorCode, message: string): CommandDecision => ({ kind: 'error', code, message });
const unknown = (name: string | undefined, verb: string): CommandDecision =>
  refuse('INTERNAL', `Could not ${verb}: the database answered “${name ?? 'nothing'}”.`);

/** `crm.cancel_meeting` → outcome. `providerEventId` is what was NOT cancelled at the provider. */
export function interpretCancel(outcome: string | undefined, providerEventId: string | null | undefined): CommandDecision {
  switch (outcome) {
    case 'cancelled':
      return {
        kind: 'done',
        message: providerEventId
          ? `Cancelled. The provider event ${providerEventId} was NOT cancelled there — no calendar adapter exists (BLK-005); cancel it by hand.`
          : 'Cancelled. History is kept on the row; the queued reminder was dropped.',
      };
    case 'already_cancelled':
      return { kind: 'done', message: 'This meeting was already cancelled; nothing changed.' };
    case 'wrong_state':
      return refuse('VALIDATION', 'A meeting that happened, or was missed, cannot be cancelled after the fact.');
    case 'forbidden':
      return refuse('FORBIDDEN', FORBIDDEN);
    case 'not_found':
      return refuse('NOT_FOUND', NOT_FOUND);
    default:
      return unknown(outcome, 'cancel the meeting');
  }
}

/** `crm.complete_meeting` → outcome, with §9.3's analysis answer said beside it. */
export function interpretComplete(outcome: string | undefined, analysis: string | null | undefined): CommandDecision {
  switch (outcome) {
    case 'completed':
      return {
        kind: 'done',
        message:
          analysis === 'queued' || analysis === 'already_queued'
            ? 'Marked completed by you, now. An analysis job is queued for it — and stays queued: no worker runs one yet (BLK-001).'
            : 'Marked completed by you, now. No analysis was queued: the meeting has no evidence, and a model asked to summarise an empty room would still answer.',
      };
    case 'already_completed':
      return { kind: 'done', message: 'This meeting was already marked completed; nothing changed.' };
    case 'wrong_state':
      return refuse('VALIDATION', 'Only a booked meeting can have happened. This one was never booked, or has already been concluded.');
    case 'not_yet_started':
      return refuse('VALIDATION', NOT_YET_STARTED);
    case 'invalid_outcome':
      return refuse('VALIDATION', 'The outcome must be completed, failed or follow-up required. A no-show and a cancellation have their own controls.');
    case 'note_too_long':
      return refuse('VALIDATION', NOTE_TOO_LONG);
    case 'no_actor':
      return refuse('FORBIDDEN', NO_ACTOR);
    case 'unknown_actor':
      return refuse('FORBIDDEN', UNKNOWN_ACTOR);
    case 'forbidden':
      return refuse('FORBIDDEN', FORBIDDEN);
    case 'not_found':
      return refuse('NOT_FOUND', NOT_FOUND);
    default:
      return unknown(outcome, 'mark the meeting completed');
  }
}

/** `crm.record_no_show` → outcome. */
export function interpretNoShow(outcome: string | undefined): CommandDecision {
  switch (outcome) {
    case 'no_show':
      return {
        kind: 'done',
        message: 'Recorded as a no-show by you, now. No follow-up was queued: which follow-up a no-show gets is not decided (ADM-103).',
      };
    case 'already_recorded':
      return { kind: 'done', message: 'This meeting was already recorded as a no-show; nothing changed.' };
    case 'wrong_state':
      return refuse('VALIDATION', 'Only a booked meeting can be missed. This one was never booked, or has already been concluded.');
    case 'not_yet_started':
      return refuse('VALIDATION', NOT_YET_STARTED);
    case 'note_too_long':
      return refuse('VALIDATION', NOTE_TOO_LONG);
    case 'no_actor':
      return refuse('FORBIDDEN', NO_ACTOR);
    case 'unknown_actor':
      return refuse('FORBIDDEN', UNKNOWN_ACTOR);
    case 'forbidden':
      return refuse('FORBIDDEN', FORBIDDEN);
    case 'not_found':
      return refuse('NOT_FOUND', NOT_FOUND);
    default:
      return unknown(outcome, 'record the no-show');
  }
}

/** `crm.add_meeting_evidence` → outcome. */
export function interpretEvidence(outcome: string | undefined): CommandDecision {
  switch (outcome) {
    case 'attached':
      return { kind: 'done', message: 'Attached to this meeting, with you as the uploader.' };
    case 'invalid_kind':
      return refuse('VALIDATION', 'That is not a kind of evidence the record accepts.');
    case 'invalid_visibility':
      return refuse('VALIDATION', 'Visibility must be internal or client-visible.');
    case 'nothing_to_attach':
      return refuse('VALIDATION', 'Write something. Evidence with neither text nor a reference is a claim that evidence exists.');
    case 'too_long':
      return refuse('VALIDATION', 'The text is longer than 20,000 characters.');
    case 'invalid_size':
      return refuse('VALIDATION', 'A byte size must be positive.');
    case 'unknown_actor':
      return refuse('FORBIDDEN', UNKNOWN_ACTOR);
    case 'forbidden':
      return refuse('FORBIDDEN', FORBIDDEN);
    case 'not_found':
      return refuse('NOT_FOUND', NOT_FOUND);
    default:
      return unknown(outcome, 'attach the evidence');
  }
}

/** `crm.request_meeting_analysis` (G-229) → outcome, asked again from A09 once evidence exists. */
export function interpretAnalysis(outcome: string | undefined): CommandDecision {
  switch (outcome) {
    case 'queued':
      return { kind: 'done', message: 'Analysis queued — and it stays queued: no worker runs one yet (BLK-001).' };
    case 'already_queued':
      return { kind: 'done', message: 'An analysis job already exists for this meeting; nothing was queued twice.' };
    case 'not_completed':
      return refuse('VALIDATION', 'Only a meeting somebody marked completed can be analysed. A no-show has nothing to analyse.');
    case 'no_evidence':
      return refuse('VALIDATION', 'Attach evidence first. A model asked to summarise an empty room would still answer.');
    case 'forbidden':
      return refuse('FORBIDDEN', FORBIDDEN);
    case 'not_found':
      return refuse('NOT_FOUND', NOT_FOUND);
    default:
      return unknown(outcome, 'request the analysis');
  }
}

/** Every name the five interpreters recognise, for the test that holds them to the migrations. */
export const RECOGNISED_OUTCOMES = {
  cancel: ['cancelled', 'already_cancelled', 'wrong_state', 'forbidden', 'not_found'],
  complete: ['completed', 'already_completed', 'wrong_state', 'not_yet_started', 'invalid_outcome', 'note_too_long', 'no_actor', 'unknown_actor', 'forbidden', 'not_found'],
  noShow: ['no_show', 'already_recorded', 'wrong_state', 'not_yet_started', 'note_too_long', 'no_actor', 'unknown_actor', 'forbidden', 'not_found'],
  evidence: ['attached', 'invalid_kind', 'invalid_visibility', 'nothing_to_attach', 'too_long', 'invalid_size', 'unknown_actor', 'forbidden', 'not_found'],
  analysis: ['queued', 'already_queued', 'not_completed', 'no_evidence', 'forbidden', 'not_found'],
} as const;

/**
 * The doors, keyed by the name the database defines them under. ONE table:
 * the view offers a control from it, the page mounts the form from it, and
 * the test holds it to the migrations and to the rpc calls — review found
 * the first draft carrying the names in three places with nothing joining them.
 */
export const MEETING_DOORS = {
  'crm.cancel_meeting': { rpc: 'cancel_meeting', action: 'Cancel' },
  'crm.complete_meeting': { rpc: 'complete_meeting', action: 'Mark completed' },
  'crm.record_no_show': { rpc: 'record_no_show', action: 'Mark no-show' },
  'crm.add_meeting_evidence': { rpc: 'add_meeting_evidence', action: 'Attach evidence' },
  'crm.request_meeting_analysis': { rpc: 'request_meeting_analysis', action: 'Request analysis' },
} as const;
export type MeetingDoor = keyof typeof MEETING_DOORS;
