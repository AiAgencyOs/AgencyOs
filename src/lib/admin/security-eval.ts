/**
 * The Security Center's checks — pure, over the structural posture the database
 * reports. No score, no weighting, no invented confidence: each check is simply
 * "the catalogue scan found zero violations" (ok) or "it found N, and here they
 * are". The spec's rule — show actual evidence, never a fake security score — is
 * kept by having nothing here except the count and the offending identifiers.
 */

export type SecurityPosture = {
  unguarded_fks: { child: string; fk_column: string; parent: string }[];
  unfrozen_tables: { org_table: string }[];
  invoker_writes: { target: string; op: string; writer: string }[];
};

export type SecurityCheck = {
  id: 'tenant-fk-guards' | 'org-freeze' | 'invoker-writes';
  title: string;
  ok: boolean;
  count: number;
  /** The offending identifiers when not ok — real evidence, not a claim. */
  offenders: string[];
  meaning: string;
};

export function securityChecks(p: SecurityPosture): SecurityCheck[] {
  return [
    {
      id: 'tenant-fk-guards',
      title: 'Every cross-tenant foreign key is guarded',
      ok: p.unguarded_fks.length === 0,
      count: p.unguarded_fks.length,
      offenders: p.unguarded_fks.map((u) => `${u.child}.${u.fk_column} → ${u.parent}`),
      meaning: 'A child row cannot be grafted onto a parent in another organization.',
    },
    {
      id: 'org-freeze',
      title: "Every org-scoped table freezes its tenant",
      ok: p.unfrozen_tables.length === 0,
      count: p.unfrozen_tables.length,
      offenders: p.unfrozen_tables.map((t) => t.org_table),
      meaning: 'A row cannot be moved to another organization by editing organization_id.',
    },
    {
      id: 'invoker-writes',
      title: 'No write path is silently broken by RLS',
      ok: p.invoker_writes.length === 0,
      count: p.invoker_writes.length,
      offenders: p.invoker_writes.map((w) => `${w.writer} → ${w.target} (${w.op})`),
      meaning: 'No SECURITY INVOKER function writes to an RLS table with no policy (which would silently no-op).',
    },
  ];
}

export function isClean(p: SecurityPosture): boolean {
  return securityChecks(p).every((c) => c.ok);
}
