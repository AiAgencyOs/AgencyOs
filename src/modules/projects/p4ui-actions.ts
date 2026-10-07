'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import {
  confirmPrototypeDesignIssue,
  decidePostLockRevision,
  recordFigmaRefs,
  requestPostLockRevision,
  resolveDesignBlocker,
  resolvePrototypeBlocker,
  routePrototypeFeedback,
  routeUiFeedback,
} from './p4ui-service';

/** The Phase 4 UI Designer / Prototype record's forms. Every action is one door; nothing here decides what a door will accept. */

const text = (formData: FormData, name: string): string => String(formData.get(name) ?? '').trim();

function finish(projectId: string, result: { ok: true } | { ok: false; error: { message: string } }, done: string): FormState {
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/p4ui`);
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: done };
}

export async function resolveDesignBlockerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return finish(text(formData, 'projectId'), await resolveDesignBlocker(text(formData, 'blockerId'), text(formData, 'note')), 'Blocker resolved.');
}

export async function resolvePrototypeBlockerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return finish(text(formData, 'projectId'), await resolvePrototypeBlocker(text(formData, 'blockerId'), text(formData, 'note')), 'Blocker resolved.');
}

export async function routeUiFeedbackAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return finish(text(formData, 'projectId'), await routeUiFeedback(text(formData, 'uiVersionId'), text(formData, 'classification'), text(formData, 'reasoning')), 'Feedback classified.');
}

export async function routePrototypeFeedbackAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return finish(text(formData, 'projectId'), await routePrototypeFeedback(text(formData, 'deliverableId'), text(formData, 'classification'), text(formData, 'reasoning')), 'Feedback classified.');
}

export async function requestPostLockRevisionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return finish(text(formData, 'projectId'), await requestPostLockRevision(text(formData, 'uiVersionId'), text(formData, 'kind'), text(formData, 'reason')), 'Request recorded for an Admin.');
}

export async function decidePostLockRevisionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const approve = text(formData, 'decision') === 'approve';
  return finish(text(formData, 'projectId'), await decidePostLockRevision(text(formData, 'requestId'), approve, text(formData, 'note')), approve ? 'Approved.' : 'Rejected.');
}

export async function confirmPrototypeDesignIssueAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const source = text(formData, 'classification') === 'source_ui_defect';
  return finish(text(formData, 'projectId'), await confirmPrototypeDesignIssue(text(formData, 'issueId'), source, text(formData, 'note')), source ? 'Confirmed as a design defect.' : 'Recorded as a code bug.');
}

export async function recordFigmaRefsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return finish(
    text(formData, 'projectId'),
    await recordFigmaRefs(text(formData, 'uiVersionId'), text(formData, 'fileRef'), text(formData, 'pageRef') || null, text(formData, 'replaceReason') || null),
    'Figma references recorded. Nothing was written to Figma.',
  );
}
