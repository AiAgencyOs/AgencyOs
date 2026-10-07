'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';
import { advanceTask, pauseTask, reassignTask, reconcileTask, resolveEscalation, resumeTask, retryTask } from '@/modules/orchestrator/p1o-coordination';

/** Workflow task board controls (Admin Panel A16). Each one is a database door; the refusal is shown as written. */

const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

function done(result: { ok: true; data: string } | { ok: false; error: { message: string } }): FormState {
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/operations/task-board');
  return { status: 'success', message: result.data };
}

export async function pauseTaskAction(_prev: FormState, f: FormData): Promise<FormState> {
  return done(await pauseTask(text(f, 'handoffId'), text(f, 'reason')));
}
export async function resumeTaskAction(_prev: FormState, f: FormData): Promise<FormState> {
  return done(await resumeTask(text(f, 'handoffId')));
}
export async function reassignTaskAction(_prev: FormState, f: FormData): Promise<FormState> {
  return done(await reassignTask(text(f, 'handoffId'), text(f, 'toAgent'), text(f, 'reason')));
}
export async function retryTaskAction(_prev: FormState, f: FormData): Promise<FormState> {
  return done(await retryTask(text(f, 'handoffId'), text(f, 'reason')));
}
export async function reconcileTaskAction(_prev: FormState, f: FormData): Promise<FormState> {
  const effect = text(f, 'effect') === 'happened' ? 'happened' : 'did_not_happen';
  return done(await reconcileTask(text(f, 'handoffId'), effect, text(f, 'note')));
}
export async function resolveEscalationAction(_prev: FormState, f: FormData): Promise<FormState> {
  return done(await resolveEscalation(text(f, 'escalationId'), text(f, 'note')));
}
export async function advanceTaskAction(_prev: FormState, f: FormData): Promise<FormState> {
  return done(await advanceTask(text(f, 'handoffId'), text(f, 'toState'), text(f, 'note')));
}
