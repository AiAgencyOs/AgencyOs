/**
 * The fixed words on a quotation page, in the language the client reads.
 *
 * Three document languages, and the choice is the client's, not the agency's:
 *   en       English
 *   hinglish Hindi in Roman letters, the way these clients write to us
 *   hindi    Devanagari script (set in Noto Sans Devanagari, shaped — see
 *            shaped-font.ts)
 *
 * These are headings and furniture only. They carry no commercial term, no
 * promise and no number, so they are the part that can follow the client's
 * language without anyone's legal sign-off. The standard TERMS (support,
 * commercial, regulatory, next steps) are a different matter and live in
 * `quotation-standards-i18n.ts` behind an owner switch.
 *
 * The approver block ("FOR THE APPROVER — NOT PART OF THE QUOTATION") is
 * deliberately absent: it is an internal note, never drawn on a client's copy,
 * and stays English.
 */
export type QuotationLanguage = 'en' | 'hinglish' | 'hindi';

export type QuotationLabels = {
  kind: string;
  preparedFor: string;
  preparedBy: string;
  projectUnderstood: string;
  whatItCovers: string;
  qty: string;
  amount: string;
  servesPrefix: string;
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
  timeline: string;
  paymentSchedule: string;
  whoUsesIt: string;
  services: string;
  notIncluded: string;
  notThisPhase: string;
  optional: string;
  clientResponsibilities: string;
  assumptions: string;
  dependencies: string;
  acceptedWhen: string;
  scopeChanges: string;
  support: string;
  commercialTerms: string;
  regulatory: string;
  nextSteps: string;
  version: string;
  prepared: string;
  validUntil: string;
  quotation: string;
  continued: string;
  page: (n: number, total: number) => string;
  bands: { draft: string; pending: string; superseded: string; lapsed: string; rejected: string; unknown: (status: string) => string };
};

const EN: QuotationLabels = {
  kind: 'QUOTATION',
  preparedFor: 'PREPARED FOR',
  preparedBy: 'PREPARED BY',
  projectUnderstood: 'THE PROJECT, AS UNDERSTOOD',
  whatItCovers: 'WHAT IT COVERS',
  qty: 'QTY',
  amount: 'AMOUNT',
  servesPrefix: 'For: ',
  subtotal: 'Subtotal',
  discount: 'Discount',
  tax: 'Tax',
  total: 'Total',
  timeline: 'TIMELINE',
  paymentSchedule: 'PAYMENT SCHEDULE',
  whoUsesIt: 'WHO USES IT',
  services: 'SERVICES IT USES, AND WHO PAYS FOR THEM',
  notIncluded: 'EXPLICITLY NOT INCLUDED',
  notThisPhase: 'NOT IN THIS PHASE — AND WHICH PHASE OWNS IT',
  optional: 'OPTIONAL — NOT IN THE TOTAL ABOVE',
  clientResponsibilities: 'CLIENT RESPONSIBILITIES',
  assumptions: 'ASSUMPTIONS',
  dependencies: 'DEPENDENCIES',
  acceptedWhen: 'ACCEPTED WHEN',
  scopeChanges: 'SCOPE & CHANGES',
  support: 'SUPPORT',
  commercialTerms: 'COMMERCIAL TERMS',
  regulatory: 'REGULATORY',
  nextSteps: 'NEXT STEPS',
  version: 'Version',
  prepared: 'Prepared',
  validUntil: 'Valid until',
  quotation: 'Quotation',
  continued: 'continued',
  page: (n, total) => `Page ${n} of ${total}`,
  bands: {
    draft: 'DRAFT — NOT YET APPROVED',
    pending: 'FOR INTERNAL REVIEW — NOT YET APPROVED',
    superseded: 'SUPERSEDED — A LATER VERSION REPLACES THIS DOCUMENT',
    lapsed: 'VALIDITY EXPIRED',
    rejected: 'DECLINED BY THE CLIENT',
    unknown: (status) => `NOT APPROVED — STATUS: ${status.toUpperCase().replace(/_/g, ' ')}`,
  },
};

const HINGLISH: QuotationLabels = {
  kind: 'QUOTATION',
  preparedFor: 'KISKE LIYE',
  preparedBy: 'KISNE TAIYAR KIYA',
  projectUnderstood: 'PROJECT, JAISA HUMNE SAMJHA',
  whatItCovers: 'ISME KYA SHAAMIL HAI',
  qty: 'QTY',
  amount: 'RAKAM',
  servesPrefix: 'Kiske liye: ',
  subtotal: 'Subtotal',
  discount: 'Discount',
  tax: 'Tax',
  total: 'Kul',
  timeline: 'TIMELINE',
  paymentSchedule: 'PAYMENT SCHEDULE',
  whoUsesIt: 'ISE KAUN USE KAREGA',
  services: 'JIN SERVICES KA USE HOTA HAI, AUR UNKA PAISA KAUN DETA HAI',
  notIncluded: 'ISME SHAAMIL NAHI HAI',
  notThisPhase: 'IS PHASE MEIN NAHI — AUR KIS PHASE MEIN HAI',
  optional: 'OPTIONAL — UPAR KE TOTAL MEIN SHAAMIL NAHI',
  clientResponsibilities: 'CLIENT KI ZIMMEDARIYAN',
  assumptions: 'MAANYATAYEIN',
  dependencies: 'NIRBHARTAYEIN',
  acceptedWhen: 'KAAM KAB POORA MAANA JAYEGA',
  scopeChanges: 'SCOPE AUR BADLAV',
  support: 'SUPPORT',
  commercialTerms: 'COMMERCIAL SHARTEIN',
  regulatory: 'NIYAMAK (REGULATORY)',
  nextSteps: 'AGLE KADAM',
  version: 'Version',
  prepared: 'Taiyar kiya',
  validUntil: 'Valid till',
  quotation: 'Quotation',
  continued: 'jaari',
  page: (n, total) => `Page ${n} / ${total}`,
  bands: {
    draft: 'DRAFT — ABHI MANZOOR NAHI',
    pending: 'INTERNAL REVIEW KE LIYE — ABHI MANZOOR NAHI',
    superseded: 'BADAL DIYA GAYA — IS DOCUMENT KI JAGAH NAYI VERSION HAI',
    lapsed: 'VALIDITY KHATAM',
    rejected: 'CLIENT NE MANA KIYA',
    unknown: (status) => `MANZOOR NAHI — STATUS: ${status.toUpperCase().replace(/_/g, ' ')}`,
  },
};

const HINDI: QuotationLabels = {
  kind: 'कोटेशन',
  preparedFor: 'किसके लिए',
  preparedBy: 'किसने तैयार किया',
  projectUnderstood: 'प्रोजेक्ट, जैसा हमने समझा',
  whatItCovers: 'इसमें क्या शामिल है',
  qty: 'मात्रा',
  amount: 'राशि',
  servesPrefix: 'किनके लिए: ',
  subtotal: 'उप-योग',
  discount: 'छूट',
  tax: 'कर',
  total: 'कुल',
  timeline: 'समय-सीमा',
  paymentSchedule: 'भुगतान की समय-सारणी',
  whoUsesIt: 'इसे कौन उपयोग करेगा',
  services: 'जिन सेवाओं का उपयोग होगा, और उनका भुगतान कौन करेगा',
  notIncluded: 'इसमें शामिल नहीं है',
  notThisPhase: 'इस चरण में नहीं — और किस चरण में है',
  optional: 'वैकल्पिक — ऊपर के कुल में शामिल नहीं',
  clientResponsibilities: 'क्लाइंट की ज़िम्मेदारियाँ',
  assumptions: 'मान्यताएँ',
  dependencies: 'निर्भरताएँ',
  acceptedWhen: 'काम कब पूरा माना जाएगा',
  scopeChanges: 'स्कोप और बदलाव',
  support: 'सपोर्ट',
  commercialTerms: 'व्यावसायिक शर्तें',
  regulatory: 'नियामकीय',
  nextSteps: 'अगले कदम',
  version: 'संस्करण',
  prepared: 'तैयार किया',
  validUntil: 'वैध तिथि तक',
  quotation: 'कोटेशन',
  continued: 'जारी',
  page: (n, total) => `पृष्ठ ${n} / ${total}`,
  bands: {
    draft: 'ड्राफ़्ट — अभी स्वीकृत नहीं',
    pending: 'आंतरिक समीक्षा के लिए — अभी स्वीकृत नहीं',
    superseded: 'बदल दिया गया — इस दस्तावेज़ की जगह नया संस्करण है',
    lapsed: 'वैधता समाप्त',
    rejected: 'क्लाइंट ने अस्वीकार किया',
    unknown: (status) => `स्वीकृत नहीं — स्थिति: ${status.toUpperCase().replace(/_/g, ' ')}`,
  },
};

export const QUOTATION_LABELS: Readonly<Record<QuotationLanguage, QuotationLabels>> = {
  en: EN,
  hinglish: HINGLISH,
  hindi: HINDI,
};
