/**
 * A loose, typed view of "call one database door". db:types is generated from a running database, so the new p4q doors are reached through this narrow view until
 * it is regenerated. Every door answers with a row whose `outcome` names what happened; nothing here interprets an outcome, the caller does.
 */
export type DoorClient = {
  schema(name: string): {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };
};

export type DoorRow = Record<string, unknown> & { outcome?: string };

export type DoorResult = { ok: true; row: DoorRow; rows: DoorRow[] } | { ok: false; message: string };

export async function callDoor(client: unknown, schema: 'projects' | 'finance' | 'core', fn: string, args: Record<string, unknown>): Promise<DoorResult> {
  const { data, error } = await (client as DoorClient).schema(schema).rpc(fn, args);
  if (error) return { ok: false, message: error.message };
  const rows = (Array.isArray(data) ? data : data === null || data === undefined ? [] : [data]) as DoorRow[];
  return { ok: true, row: rows[0] ?? {}, rows };
}
