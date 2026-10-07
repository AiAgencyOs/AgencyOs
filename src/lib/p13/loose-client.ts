/**
 * `src/lib/db/types.ts` is generated from a running database (`npm run db:types`, needs Docker) and is stale for the objects the p13_ migrations add.
 * Until it is regenerated, the new doors and tables are reached through this narrow, explicitly loose view of a Supabase client. It widens ONLY the
 * call surface (`rpc`, `from().select()` with a few filters); results are `unknown` and every caller validates what comes back.
 */
export type LooseError = { message: string };
export type LooseResult = { data: unknown; error: LooseError | null };

export interface LooseBuilder extends PromiseLike<LooseResult> {
  select(columns: string): LooseBuilder;
  eq(column: string, value: unknown): LooseBuilder;
  neq(column: string, value: unknown): LooseBuilder;
  in(column: string, values: readonly unknown[]): LooseBuilder;
  is(column: string, value: null): LooseBuilder;
  gte(column: string, value: unknown): LooseBuilder;
  lte(column: string, value: unknown): LooseBuilder;
  not(column: string, op: string, value: unknown): LooseBuilder;
  order(column: string, options?: { ascending?: boolean }): LooseBuilder;
  limit(count: number): LooseBuilder;
  maybeSingle(): LooseBuilder;
}

export interface LooseSchema {
  from(table: string): LooseBuilder;
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<LooseResult>;
}

export function looseSchema(client: { schema(name: never): unknown }, name: string): LooseSchema {
  return (client as unknown as { schema(n: string): LooseSchema }).schema(name);
}

export function asRows(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

export function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return (data[0] as Record<string, unknown> | undefined) ?? null;
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
}
