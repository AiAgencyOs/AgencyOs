import type { SettingImpact } from './settings-impact';

/**
 * The sentences a "preview impact" step shows for the commercial and outreach
 * settings — pure, so they are proven to state exactly the counts they were
 * handed and to say what does NOT change as plainly as what does. Nothing here
 * estimates: each number is a count the server read.
 */

type Kind = 'pricing' | 'terms' | 'validity' | 'limits' | 'offer' | 'outreach-limits' | 'outreach-window' | 'reactivation-cap';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function impactEffects(kind: Kind, impact: SettingImpact): string[] {
  const { drafts, withClients } = impact.quotations;
  const active = plural(impact.outreach.activeFollowUps, 'active follow-up sequence', 'active follow-up sequences');

  switch (kind) {
    case 'pricing':
      return [
        `${plural(drafts, 'quotation draft', 'quotation drafts')} not yet with a client — a draft priced below the new minimum band is flagged to whoever approves it.`,
        `${plural(withClients, 'quotation', 'quotations')} already approved or sent keep the price they carry; nothing a client has is rewritten.`,
        'The cost bands are references for the approver only; a client never sees them.',
      ];
    case 'terms':
      return [
        `New quotations carry the new payment schedule. ${plural(drafts, 'draft', 'drafts')} already written keep the terms they were drafted with.`,
        `${plural(withClients, 'quotation', 'quotations')} already with a client keep theirs.`,
        'Milestones must still add up to 100%; the database refuses anything else.',
      ];
    case 'validity':
      return [
        `Every quotation drafted from now on prints the new “valid for N days” clause. ${plural(drafts, 'draft', 'drafts')} already written keep their own.`,
        `${plural(withClients, 'quotation', 'quotations')} already sent keep the validity they were sent with.`,
      ];
    case 'limits':
      return [
        `${plural(withClients, 'quotation', 'quotations')} with a client can still be negotiated; the agent is bound by the new limits from the next counter-offer.`,
        'A limit bounds what happens with nobody looking. It never refuses a decision a person makes.',
      ];
    case 'offer':
      return [
        `${plural(withClients, 'quotation', 'quotations')} with a client can be given this concession if the client pushes back on price, once per deal and never below your minimum band.`,
        'Clearing all the fields withdraws the standing offer; nothing already granted is undone.',
      ];
    case 'outreach-limits':
      return [`${active} — each is held to the new daily and weekly limits from its next send.`, 'Nothing already sent is recalled.'];
    case 'outreach-window':
      return [`${active} — a follow-up that falls due outside the new hours waits for the next opening.`, 'Times are read in the agency timezone, on business days.'];
    case 'reactivation-cap':
      return [`${active} — the next worker run sends at most the new number of reactivation follow-ups.`, 'The daily outreach limits still apply on top of it.'];
  }
}
