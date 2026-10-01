import 'server-only';

import { fileCredentialProblem } from './file-secrets-guard';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { checklistItemRoleRefusal, dbRoleRefusal, taskRoleRefusal } from './project-role-service';

import {
  addChecklistItemSchema,
  addTaskAttachmentSchema,
  addTaskCommentSchema,
  removeChecklistItemSchema,
  removeTaskAttachmentSchema,
  setChecklistItemDoneSchema,
  type AddChecklistItemInput,
  type AddTaskAttachmentInput,
  type AddTaskCommentInput,
  type RemoveChecklistItemInput,
  type RemoveTaskAttachmentInput,
  type SetChecklistItemDoneInput,
} from './task-collab-schema';

/**
 * Task collaboration doors — SCR-020 / SCR-021 / SCR-041.
 *
 * `task.write` throughout: the capability every other writer of
 * `projects.tasks` takes, and the three child tables' RLS
 * (`core.can_write()`, the same predicate as `tasks_write`) decides again at
 * the row. No RPC: none of these is a decision with a transition graph —
 * a comment is appended, a checklist item ticked, a link added or removed —
 * so a plain insert/update/delete under RLS is the honest shape, matching
 * `addProjectFile` / `removeProjectFile`.
 *
 * The blocked reason is deliberately NOT here: it is part of the status
 * move and lives on `setTaskStatus` in service.ts.
 */

function refused(what: string): Result<never> {
  return err('FORBIDDEN', `You do not have permission to ${what}.`);
}

export async function addTaskComment(input: AddTaskCommentInput): Promise<Result<{ commentId: string }>> {
  const parsed = addTaskCommentSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid comment.');

  const context = await requireInternal();
  if (!can(context, 'task.write')) return refused('comment on a task');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');
  const roleRefusal = await taskRoleRefusal(context, parsed.data.taskId);
  if (roleRefusal) return roleRefusal;

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('task_comments')
    .insert({
      organization_id: context.organizationId,
      task_id: parsed.data.taskId,
      author_id: context.userId,
      body: parsed.data.body,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error(JSON.stringify({ level: 'error', scope: 'addTaskComment', detail: error?.message }));
    const dbRefusal = dbRoleRefusal(error?.message);
    if (dbRefusal) return dbRefusal;
    return err('INTERNAL', 'Could not add the comment.');
  }
  return ok({ commentId: data.id });
}

export async function addChecklistItem(input: AddChecklistItemInput): Promise<Result<{ itemId: string }>> {
  const parsed = addChecklistItemSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid checklist item.');

  const context = await requireInternal();
  if (!can(context, 'task.write')) return refused('edit a task’s checklist');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');
  const roleRefusal = await taskRoleRefusal(context, parsed.data.taskId);
  if (roleRefusal) return roleRefusal;

  const supabase = await createClient();

  // Appended at the end: the next position after the highest one the task
  // already has. Two people adding at once may tie on position — the
  // reader orders by (position, created_at), so a tie is still stable.
  const { data: last, error: lastError } = await supabase
    .schema('projects')
    .from('task_checklist_items')
    .select('position')
    .eq('task_id', parsed.data.taskId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) {
    console.error(JSON.stringify({ level: 'error', scope: 'addChecklistItem.read', detail: lastError.message }));
    return err('INTERNAL', 'Could not read the checklist.');
  }

  const { data, error } = await supabase
    .schema('projects')
    .from('task_checklist_items')
    .insert({
      organization_id: context.organizationId,
      task_id: parsed.data.taskId,
      label: parsed.data.label,
      position: (last?.position ?? -1) + 1,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error(JSON.stringify({ level: 'error', scope: 'addChecklistItem', detail: error?.message }));
    const dbRefusal = dbRoleRefusal(error?.message);
    if (dbRefusal) return dbRefusal;
    return err('INTERNAL', 'Could not add the checklist item.');
  }
  return ok({ itemId: data.id });
}

export async function setChecklistItemDone(input: SetChecklistItemDoneInput): Promise<Result<{ done: boolean }>> {
  const parsed = setChecklistItemDoneSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid checklist item.');

  const context = await requireInternal();
  if (!can(context, 'task.write')) return refused('tick a checklist item');
  const roleRefusal = await checklistItemRoleRefusal(context, parsed.data.itemId);
  if (roleRefusal) return roleRefusal;

  const supabase = await createClient();
  const { error, count } = await supabase
    .schema('projects')
    .from('task_checklist_items')
    .update(
      parsed.data.done
        ? { done_at: new Date().toISOString(), done_by: context.userId }
        : { done_at: null, done_by: null },
      { count: 'exact' },
    )
    .eq('id', parsed.data.itemId);

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setChecklistItemDone', detail: error.message }));
    const dbRefusal = dbRoleRefusal(error.message);
    if (dbRefusal) return dbRefusal;
    return err('INTERNAL', 'Could not update the checklist item.');
  }
  if ((count ?? 0) === 0) return err('NOT_FOUND', 'Checklist item not found.');
  return ok({ done: parsed.data.done });
}

export async function removeChecklistItem(input: RemoveChecklistItemInput): Promise<Result<{ removed: true }>> {
  const parsed = removeChecklistItemSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid checklist item.');

  const context = await requireInternal();
  if (!can(context, 'task.write')) return refused('edit a task’s checklist');
  const roleRefusal = await checklistItemRoleRefusal(context, parsed.data.itemId);
  if (roleRefusal) return roleRefusal;

  const supabase = await createClient();
  const { error } = await supabase.schema('projects').from('task_checklist_items').delete().eq('id', parsed.data.itemId);
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'removeChecklistItem', detail: error.message }));
    const dbRefusal = dbRoleRefusal(error.message);
    if (dbRefusal) return dbRefusal;
    return err('INTERNAL', 'Could not remove the checklist item.');
  }
  return ok({ removed: true });
}

export async function addTaskAttachment(input: AddTaskAttachmentInput): Promise<Result<{ attachmentId: string }>> {
  const parsed = addTaskAttachmentSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid attachment.');

  const context = await requireInternal();
  if (!can(context, 'task.write')) return refused('attach a link to a task');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');
  const credential = fileCredentialProblem({ title: parsed.data.title, url: parsed.data.url });
  if (credential) return err('VALIDATION', credential);

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('task_attachments')
    .insert({
      organization_id: context.organizationId,
      task_id: parsed.data.taskId,
      title: parsed.data.title,
      url: parsed.data.url,
      kind: parsed.data.kind,
      added_by: context.userId,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error(JSON.stringify({ level: 'error', scope: 'addTaskAttachment', detail: error?.message }));
    return err('INTERNAL', 'Could not add the attachment.');
  }
  return ok({ attachmentId: data.id });
}

export async function removeTaskAttachment(input: RemoveTaskAttachmentInput): Promise<Result<{ removed: true }>> {
  const parsed = removeTaskAttachmentSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid attachment.');

  const context = await requireInternal();
  if (!can(context, 'task.write')) return refused('remove a task attachment');

  const supabase = await createClient();
  const { error } = await supabase.schema('projects').from('task_attachments').delete().eq('id', parsed.data.attachmentId);
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'removeTaskAttachment', detail: error.message }));
    return err('INTERNAL', 'Could not remove the attachment.');
  }
  return ok({ removed: true });
}
