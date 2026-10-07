import 'server-only';

import { createAdminClient } from '@/lib/db/admin';
import { createClient } from '@/lib/db/server';

/**
 * The p1o_ doors and reads are new database functions, so the generated `types.ts` does not know them yet (`npm run db:types` needs Docker). These two helpers
 * call them untyped, in one place, so no caller scatters the cast. Every caller still treats an `error` as unreadable, never as empty.
 */
export type RpcResult = { data: unknown; error: { message: string } | null };
export type Rpc = (fn: string, args?: Record<string, unknown>) => PromiseLike<RpcResult>;

/** As the signed-in person: row-level security and the door's own identity checks both apply. */
export async function userRpc(schema: 'ai' | 'crm' | 'sales' | 'finance'): Promise<Rpc> {
  const supabase = await createClient();
  return (fn, args = {}) => (supabase.schema(schema as never) as unknown as { rpc: Rpc }).rpc(fn, args);
}

/** As the service role, for the runner doors only. The caller scopes by organisation by hand. */
export function adminRpc(schema: 'ai' | 'crm' | 'sales' | 'finance'): Rpc {
  const admin = createAdminClient();
  return (fn, args = {}) => (admin.schema(schema as never) as unknown as { rpc: Rpc }).rpc(fn, args);
}

export const asRows = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
export const firstRow = (v: unknown): Record<string, unknown> | null => (Array.isArray(v) ? ((v[0] as Record<string, unknown> | undefined) ?? null) : v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
export const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const whole = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : 0);
