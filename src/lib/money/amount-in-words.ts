/**
 * A rupee amount in words, the way an Indian quotation or invoice writes it:
 * Indian digit grouping (crore, lakh, thousand), "and" before paise, and the
 * closing "Only". Pure and exact on integer minor units, so the words can
 * never disagree with the figure they sit under. Only INR is worded: another
 * currency has other conventions and this returns null rather than guess.
 */

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]} Hundred` : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ');
}

/** A whole number of rupees, in Indian grouping. 0 is "Zero". */
export function rupeesInWords(whole: number): string {
  if (!Number.isSafeInteger(whole) || whole < 0) throw new RangeError('rupeesInWords takes a non-negative safe integer');
  if (whole === 0) return 'Zero';
  const parts: string[] = [];
  let rest = whole;
  const kharab = Math.floor(rest / 1_000_000_000);
  rest %= 1_000_000_000;
  const crore = Math.floor(rest / 10_000_000);
  rest %= 10_000_000;
  const lakh = Math.floor(rest / 100_000);
  rest %= 100_000;
  const thousand = Math.floor(rest / 1000);
  rest %= 1000;
  if (kharab) parts.push(`${belowThousand(kharab)} Arab`);
  if (crore) parts.push(`${belowHundred(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rest) parts.push(belowThousand(rest));
  return parts.join(' ');
}

/** "One Lakh Twelve Thousand One Hundred Indian Rupees Only", or null for a currency other than INR / an invalid amount. */
export function amountInWords(minor: number, currency = 'INR'): string | null {
  if (currency !== 'INR' || !Number.isSafeInteger(minor) || minor < 0) return null;
  const rupees = Math.floor(minor / 100);
  const paise = minor % 100;
  const rupeeWords = `${rupeesInWords(rupees)} Indian ${rupees === 1 ? 'Rupee' : 'Rupees'}`;
  return paise > 0 ? `${rupeeWords} and ${belowHundred(paise)} Paise Only` : `${rupeeWords} Only`;
}
