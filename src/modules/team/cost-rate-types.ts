/**
 * Plain types for a person's cost rate, shared by the server reader in
 * cost-rate-queries.ts and the client cell that renders them on the Team
 * roster. No server-only import lives here so a client component may
 * import it.
 */
export type CostRate = {
  id: string;
  userId: string;
  /** Paise per hour. */
  hourlyCostMinor: number;
  currency: string;
  /** ISO day the rate applies from, inclusive. */
  effectiveFrom: string;
  setBy: string;
  setByName: string;
  note: string | null;
  createdAt: string;
};

export type MemberCostRates = {
  /** The rate in force today, or null when no rate covers today. */
  current: CostRate | null;
  /** Every row for the person, newest effective date first. Includes future-dated rows. */
  history: CostRate[];
};

/** Who may see what on the roster: the owner sets, ops_admin reads, nobody else sees the column. */
export type CostRateAccess = 'set' | 'view' | 'none';
