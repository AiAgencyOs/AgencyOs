/**
 * The GSTN state codes, as reference data — bucket E5.
 *
 * `finance.billing_profiles.billing_state` is free text a person typed. The
 * GSTR-1 place-of-supply field wants the GSTN's two digits. This is the map
 * between the two, and it is the SAME map the migration
 * `20260930160000_the_agency_states_its_own_gst_identity.sql` holds in
 * `finance.indian_state_code` — a test parses that SQL and asserts the two
 * are equal, so neither can drift from the other.
 *
 * Matching is deliberately forgiving about spelling and punctuation ("Jammu &
 * Kashmir", "jammu and kashmir", "Jammu-Kashmir") and deliberately strict
 * about meaning: a name that is not a state's, or that could be two states'
 * (a bare "Andaman"), resolves to nothing. The export then lists that invoice
 * as unresolved rather than guessing.
 *
 * Pure; no `server-only`, so client components and tests may read it.
 */

/** Normalised name → GSTN code. Former names still in use map to the current code. */
export const STATE_NAME_TO_CODE: Readonly<Record<string, string>> = {
  jammuandkashmir: '01',
  himachalpradesh: '02',
  punjab: '03',
  chandigarh: '04',
  uttarakhand: '05',
  uttaranchal: '05',
  haryana: '06',
  delhi: '07',
  newdelhi: '07',
  nctofdelhi: '07',
  rajasthan: '08',
  uttarpradesh: '09',
  bihar: '10',
  sikkim: '11',
  arunachalpradesh: '12',
  nagaland: '13',
  manipur: '14',
  mizoram: '15',
  tripura: '16',
  meghalaya: '17',
  assam: '18',
  westbengal: '19',
  jharkhand: '20',
  odisha: '21',
  orissa: '21',
  chhattisgarh: '22',
  chattisgarh: '22',
  madhyapradesh: '23',
  gujarat: '24',
  dadraandnagarhavelianddamananddiu: '26',
  damananddiu: '26',
  dadraandnagarhaveli: '26',
  maharashtra: '27',
  karnataka: '29',
  goa: '30',
  lakshadweep: '31',
  kerala: '32',
  tamilnadu: '33',
  puducherry: '34',
  pondicherry: '34',
  andamanandnicobarislands: '35',
  andamanandnicobar: '35',
  telangana: '36',
  andhrapradesh: '37',
  ladakh: '38',
  otherterritory: '97',
};

/** The GSTN's own label per code, for the "Unresolved" callout and the Settings hint. */
export const STATE_CODE_TO_NAME: Readonly<Record<string, string>> = {
  '01': 'Jammu & Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

/** Lower-case, "&" → "and", letters only — the same normalisation the SQL applies. */
export function normalizeStateName(raw: string | null | undefined): string {
  return (raw ?? '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
}

/** The GSTN code for a state name as a person might type it, or null. Never guesses. */
export function stateCodeForName(raw: string | null | undefined): string | null {
  const key = normalizeStateName(raw);
  if (!key) return null;
  return STATE_NAME_TO_CODE[key] ?? null;
}

/** Whether a two-character string is a code the GSTN has assigned (01–38, 97, 99). */
export function isGstStateCode(code: string | null | undefined): code is string {
  if (!code || !/^[0-9]{2}$/.test(code)) return false;
  const n = Number(code);
  return (n >= 1 && n <= 38) || n === 97 || n === 99;
}
