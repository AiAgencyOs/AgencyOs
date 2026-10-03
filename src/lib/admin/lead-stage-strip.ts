/**
 * The seven-segment strip on Lead 360 (New, Qualifying, Qualified, Quoted,
 * Negotiation, Converted, Lost), built from what the lead REALLY has: its
 * status (`new`, `qualifying`, `qualified`, `nurture`, `disqualified`,
 * `converted`) and, once there is one, its deal's stage (`discovery`,
 * `proposal`, `negotiation`, `won`, `lost`). The mapping is:
 *
 *   New          lead status new
 *   Qualifying   lead status qualifying
 *   Qualified    lead status qualified (a deal still in discovery included)
 *   Quoted       deal stage proposal
 *   Negotiation  deal stage negotiation
 *   Converted    lead status converted, or deal stage won
 *   Lost         lead status disqualified, or deal stage lost
 *
 * `nurture` is a real status that is not a point on this path (a parked lead
 * did not skip the rest), so it is returned as `parked` and no segment is
 * current. Nothing here is stored; it is a reading of two existing columns.
 */

export const LEAD_STRIP_SEGMENTS = ['New', 'Qualifying', 'Qualified', 'Quoted', 'Negotiation', 'Converted', 'Lost'] as const;
export type LeadStripSegment = (typeof LEAD_STRIP_SEGMENTS)[number];
export type LeadStripState = 'done' | 'current' | 'upcoming' | 'lost';

export function leadStageStrip(input: { leadStatus: string; dealStage: string | null }): { segments: { label: LeadStripSegment; state: LeadStripState }[]; parked: boolean } {
  const { leadStatus, dealStage } = input;
  let current = -1;
  let parked = false;

  if (leadStatus === 'disqualified' || dealStage === 'lost') current = 6;
  else if (leadStatus === 'converted' || dealStage === 'won') current = 5;
  else if (dealStage === 'negotiation') current = 4;
  else if (dealStage === 'proposal') current = 3;
  else if (leadStatus === 'qualified') current = 2;
  else if (leadStatus === 'qualifying') current = 1;
  else if (leadStatus === 'new') current = 0;
  else if (leadStatus === 'nurture') parked = true;

  return {
    parked,
    segments: LEAD_STRIP_SEGMENTS.map((label, i) => ({
      label,
      state: current === -1 ? 'upcoming' : i === current ? (label === 'Lost' ? 'lost' : 'current') : current === 6 ? 'upcoming' : i < current ? 'done' : 'upcoming',
    })),
  };
}
