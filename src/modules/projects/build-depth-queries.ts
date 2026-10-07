import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { readReproducibility, toClientBuildPackage, type ClientBuildPackage } from './build-depth-schema';

// The generated database types predate these tables and functions (db:types needs Docker), so reads go through a narrow untyped face.
type Reply = PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Query = Reply & { select(columns: string): Query; eq(column: string, value: unknown): Query; order(column: string, o: { ascending: boolean }): Query; limit(n: number): Query };
type Untyped = { from(table: string): Query; rpc(fn: string, args: unknown): Reply };
async function projectsDb(): Promise<Untyped> {
  const supabase = await createClient();
  return supabase.schema('projects') as unknown as Untyped;
}

export type BuildConfigVersion = { version: number; config: Record<string, unknown>; note: string | null; current: boolean; createdAt: string };
export type BuildLogLine = { stage: string; attempt: number; text: string; createdAt: string };
export type BuildRequestRow = { id: string; deliverableId: string; commit: string; environment: string; status: string; detail: string | null; createdAt: string };

/** The versions of a project's build configuration, newest first. Staff only (the table's policy). */
export async function readBuildConfigs(projectId: string): Promise<BuildConfigVersion[]> {
  const db = await projectsDb();
  const { data, error } = await db.from('build_configs').select('version, config, note, current, created_at').eq('project_id', projectId).order('version', { ascending: false });
  if (error) unreadable('readBuildConfigs', error);
  return ((data ?? []) as { version: number; config: Record<string, unknown> | null; note: string | null; current: boolean; created_at: string }[]).map((r) => ({
    version: r.version, config: r.config ?? {}, note: r.note, current: r.current, createdAt: r.created_at,
  }));
}

/** The masked log of one run, in the order it was written. Staff only: the read function refuses anyone else. */
export async function readBuildLogs(runId: string): Promise<BuildLogLine[]> {
  const db = await projectsDb();
  const { data, error } = await db.rpc('build_logs_for_run', { p_build_run_id: runId });
  if (error) unreadable('readBuildLogs', error);
  return ((data ?? []) as { stage: string; attempt: number; masked_text: string; created_at: string }[]).map((r) => ({ stage: r.stage, attempt: r.attempt, text: r.masked_text, createdAt: r.created_at }));
}

/** 'reproduced' / 'differs' / 'single_run', from the database. null means the caller may not know. */
export async function readBuildReproducibility(deliverableId: string, commit: string): Promise<'reproduced' | 'differs' | 'single_run' | null> {
  const db = await projectsDb();
  const { data, error } = await db.rpc('build_reproducibility', { p_deliverable_id: deliverableId, p_commit: commit });
  if (error) unreadable('readBuildReproducibility', error);
  return readReproducibility(data);
}

/** The package exactly as the client would see it (null when the build is not ready, not shared, or not the caller's). */
export async function readClientBuildPackage(deliverableId: string): Promise<ClientBuildPackage | null> {
  const db = await projectsDb();
  const { data, error } = await db.rpc('client_build_package', { p_deliverable_id: deliverableId });
  if (error) unreadable('readClientBuildPackage', error);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  return toClientBuildPackage(row);
}

export type BuildRunBrief = { id: string; deliverableId: string; status: string; attempt: number; commit: string; createdAt: string };

/** The newest runs of a project's builds (verdict, attempt, commit: no stages or fingerprint here). Staff only. */
export async function readBuildRuns(projectId: string, limit = 50): Promise<BuildRunBrief[]> {
  const db = await projectsDb();
  const { data, error } = await db.from('build_runs').select('id, deliverable_id, status, attempt, commit_ref, created_at').eq('project_id', projectId).order('created_at', { ascending: false }).limit(limit);
  if (error) unreadable('readBuildRuns', error);
  return ((data ?? []) as { id: string; deliverable_id: string; status: string; attempt: number; commit_ref: string; created_at: string }[]).map((r) => ({
    id: r.id, deliverableId: r.deliverable_id, status: r.status, attempt: r.attempt, commit: r.commit_ref, createdAt: r.created_at,
  }));
}

/** The build requests of a project, newest first (an open one can be cancelled by an Admin). */
export async function readBuildRequests(projectId: string, limit = 20): Promise<BuildRequestRow[]> {
  const db = await projectsDb();
  const { data, error } = await db.from('build_requests').select('id, deliverable_id, commit_ref, environment, status, detail, created_at').eq('project_id', projectId).order('created_at', { ascending: false }).limit(limit);
  if (error) unreadable('readBuildRequests', error);
  return ((data ?? []) as { id: string; deliverable_id: string; commit_ref: string; environment: string; status: string; detail: string | null; created_at: string }[]).map((r) => ({
    id: r.id, deliverableId: r.deliverable_id, commit: r.commit_ref, environment: r.environment, status: r.status, detail: r.detail, createdAt: r.created_at,
  }));
}
