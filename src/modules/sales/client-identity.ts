/**
 * SCR-014 — "client identity must deduplicate against lead/contact records".
 *
 * Before a client is created by hand, the people and companies the agency
 * already holds are asked who this might be: another client with the same
 * name or billing email, or a contact (usually on a lead) with the same email
 * or the same company or person name. A match does not forbid anything — two
 * real businesses can share a name — it stops the form once, names the record,
 * and asks the person to confirm. Pure, so the rule is tested with real rows;
 * the service only supplies the candidates.
 */

export type ClientCandidate = { id: string; name: string; billingEmail: string | null };
export type ContactCandidate = {
  id: string;
  fullName: string;
  email: string | null;
  company: string | null;
  clientAccountId: string | null;
  /** The lead this contact came in on, when there is one. */
  leadId: string | null;
  leadTitle: string | null;
};

export type IdentityMatch = {
  kind: 'client' | 'contact';
  id: string;
  label: string;
  reason: string;
  /** Where to look at the existing record instead of creating a new one. */
  href: string;
};

/** Case, runs of spaces and edge punctuation do not make two names different. */
export function normaliseIdentity(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[.,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function clientIdentityMatches(
  input: { name: string; billingEmail?: string | null },
  candidates: { clients: readonly ClientCandidate[]; contacts: readonly ContactCandidate[] },
): IdentityMatch[] {
  const name = normaliseIdentity(input.name);
  const email = normaliseIdentity(input.billingEmail);
  const out: IdentityMatch[] = [];

  for (const c of candidates.clients) {
    const sameName = name !== '' && normaliseIdentity(c.name) === name;
    const sameEmail = email !== '' && normaliseIdentity(c.billingEmail) === email;
    if (!sameName && !sameEmail) continue;
    out.push({
      kind: 'client',
      id: c.id,
      label: c.name,
      reason: sameName && sameEmail ? 'same name and billing email' : sameName ? 'same name' : 'same billing email',
      href: `/clients/${c.id}`,
    });
  }

  for (const k of candidates.contacts) {
    const sameEmail = email !== '' && normaliseIdentity(k.email) === email;
    const sameCompany = name !== '' && normaliseIdentity(k.company) === name;
    const samePerson = name !== '' && normaliseIdentity(k.fullName) === name;
    if (!sameEmail && !sameCompany && !samePerson) continue;
    // A contact that already belongs to a client is the client itself, listed above when it matches.
    const reason = sameEmail ? 'same email as this contact' : sameCompany ? 'same company as this contact' : 'same name as this contact';
    out.push({
      kind: 'contact',
      id: k.id,
      label: k.leadTitle ? `${k.fullName} — lead “${k.leadTitle}”` : k.fullName,
      reason,
      href: k.clientAccountId ? `/clients/${k.clientAccountId}` : k.leadId ? `/leads/${k.leadId}` : '/leads',
    });
  }
  return out;
}

/** One sentence naming what was found, for the form that stopped. */
export function describeIdentityMatches(matches: readonly IdentityMatch[]): string {
  const named = matches.slice(0, 3).map((m) => `${m.label} (${m.reason})`).join('; ');
  const more = matches.length > 3 ? `, and ${matches.length - 3} more` : '';
  return `This may already be known to the agency: ${named}${more}. Open that record instead, or confirm to create a separate client.`;
}
