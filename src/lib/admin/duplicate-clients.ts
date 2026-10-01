/**
 * SCR-014 "Client identity must deduplicate": for each client, how many OTHER
 * clients share its name (ignoring case and spacing) or its billing email. A
 * flag for a person to look at — nothing is merged here.
 */
export function duplicateCounts(clients: readonly { id: string; name: string; billingEmail: string | null }[]): Map<string, number> {
  const norm = (n: string) => n.toLowerCase().replace(/\s+/g, ' ').trim();
  const keysOf = (c: { name: string; billingEmail: string | null }) => [`n:${norm(c.name)}`, ...(c.billingEmail ? [`e:${c.billingEmail.toLowerCase().trim()}`] : [])];
  const byKey = new Map<string, string[]>();
  for (const c of clients) for (const key of keysOf(c)) byKey.set(key, [...(byKey.get(key) ?? []), c.id]);
  const out = new Map<string, number>();
  for (const c of clients) {
    const others = new Set<string>();
    for (const key of keysOf(c)) for (const id of byKey.get(key) ?? []) if (id !== c.id) others.add(id);
    out.set(c.id, others.size);
  }
  return out;
}
