import type { QuotationLanguage } from '@/lib/pdf/quotation-labels';

import { DEFAULT_CLAUSES, CLAUSE_KEYS } from './quotation-clauses';
import {
  GST_LINE,
  GST_NEUTRAL_LINE,
  GST_NONE_LINE,
  NEXT_STEPS_LINES,
  REGULATED_CLAUSES,
  SCOPE_PROTECTION_LINES,
  SUPPORT_STANDARD,
  TIMELINE_TERMS,
  type quotationSectionsFor,
} from './quotation-standards';

/**
 * The agency's standard quotation wording in Hinglish and Hindi.
 *
 * ── Review status: DRAFT, OWNER TO APPROVE ────────────────────────────────
 * This is the agency's own legal-adjacent text (support, commercial,
 * regulatory, next steps) rendered into two more languages. It was written to
 * mean exactly what the English means — no sentence is softer, firmer or
 * broader — but it has not been reviewed by the owner or by counsel. For that
 * reason it is applied only when the owner turns on
 * `quotation_translate_standards` (Settings › Commercial); until then every
 * quotation prints the English standards, whatever language the rest is in.
 *
 * ── What translates and what does not ─────────────────────────────────────
 * Only wording that is IDENTICAL to a known English default is replaced. A
 * clause the owner published themselves (audit B-6), a commercial term edited
 * in the composer, a payment milestone the owner named, a model-authored line
 * — all print exactly as written. Translating someone's own words would be
 * putting new words in their mouth; leaving a default untranslated is only
 * the status quo.
 *
 * Every default is covered, and a test enforces it: add an English default
 * without its two translations and the suite fails.
 */
type Sections = NonNullable<ReturnType<typeof quotationSectionsFor>>;
export type TranslatedLanguage = Exclude<QuotationLanguage, 'en'>;

type Pack = {
  timelineTerms: readonly string[];
  supportLines: readonly string[];
  gstLine: string;
  gstNeutral: string;
  gstNone: string;
  scopeProtection: readonly string[];
  nextSteps: readonly string[];
  validity: (days: number) => string;
  clauses: Readonly<Record<(typeof CLAUSE_KEYS)[number], string>>;
  regulated: Readonly<Record<string, readonly string[]>>;
  payment: Readonly<Record<string, string>>;
  billedToYou: string;
  included: string;
  thirdParty: string;
  estimated: (min: number, max: number) => string;
  phase: (n: number, of: number) => string;
  phaseWord: string;
};

const HINGLISH: Pack = {
  timelineTerms: [
    'Clock advance payment aur zaroori inputs (content, credentials, access) milne ke baad shuru hota hai.',
    'Har review par client ka feedback 3 working days ke andar chahiye; client ki taraf se deri hone par timeline usi anupaat mein badhti hai.',
    'App-store review, payment-gateway activation aur DNS is clock ke bahar hain.',
  ],
  supportLines: [
    'Bugs — included list mein jo cheez likhe anusaar kaam na kare: handover ke baad 30 din tak business hours mein free theek ki jayegi.',
    'Included scope mein badlav ek change request hai; jo list mein nahi hai wo naya feature hai — dono alag se quote kiye jaate hain.',
    'Is window ke baad ka maintenance (updates, monitoring, backups) optional AMC hai, maangne par quote milega.',
    'Third-party issues (gateway, stores, hosting, SMS) vendor ko theek karne hain aur hum madad karenge.',
  ],
  gstLine: 'Sabhi rakam GST ke bina hain; 18% GST alag se lagega.',
  gstNeutral: 'Sabhi rakam GST ke bina hain; GST jo dar lagu ho us par alag se lagega.',
  gstNone: 'Is quotation par koi GST nahi lagta.',
  scopeProtection: [
    'Upar jo kuch likha hai wo shaamil hai. Jo nahi likha wo scope ke bahar hai.',
    'Is scope mein koi bhi badlav — jodna, hatana ya badalna — ek change request hai: usse apni price aur timeline ke saath nayi quotation version banti hai, aur us par kaam likhit manzoori ke baad shuru hota hai.',
  ],
  nextSteps: [
    'Confirm karne ya badlav maangne ke liye is conversation mein reply karein — quotation nayi version ke roop mein badal jati hai.',
    'Confirm hone par: advance payment, aur kaam 2–3 working days ke andar shuru hota hai.',
    'Source code aur IP transfer aakhri payment par hota hai.',
  ],
  validity: (days) => `Yeh quotation apni tareekh se ${days} din ke liye valid hai.`,
  clauses: {
    acceptance_window:
      'Milestone tab maana jata hai jab uska naam wala demo diya ja chuka ho aur 5 working days ke andar koi likhit aapatti na aaye.',
    cancellation:
      'Cancel hone par, aakhri maane gaye milestone tak ho chuka kaam payable hai aur shuru ho chuke kaam ke liye diya gaya advance wapas nahi hoga.',
    liability_cap: 'Hamari kul zimmedari is quotation ke tahat diye gaye paise tak seemit hai.',
    jurisdiction: 'Bhartiya kanoon lagu hoga, aur Mohali / Chandigarh ki adalaton ka adhikar-kshetra hoga.',
  },
  regulated: {
    gaming: [
      'Real-money gaming regulated hai aur har rajya mein alag hai. Licensing, age-gating aur rajya-wise legality client ki zimmedari hai.',
      'Hum software banate hain; ise kanoonan chalaya ja sakta hai ya nahi, is par salah nahi dete.',
    ],
    lending: [
      'Lending regulated hai. RBI Digital Lending compliance, NBFC ya LSP licensing aur borrower ko dikhaye jaane wale sabhi disclosures client ki zimmedari hain.',
      'Hum software banate hain; loan capital, co-lending vyavastha aur regulatory approval is scope ke bahar hain.',
    ],
    health: [
      'Health data sensitive personal data hai. Clinical validity, practitioner licensing aur patient-consent flows client ki zimmedari hain.',
      'Yahan jo kuch diya jata hai wo koi medical device ya diagnostic tool nahi hai.',
    ],
    payouts: [
      'Client ke funds rakhna ya payout karna regulated hai. Payment-aggregator status, escrow vyavastha aur KYC zimmedariyan client ki hain.',
      'Paisa client ke apne gateway aur merchant account se jata hai, hamare se kabhi nahi.',
    ],
  },
  payment: {
    'Advance — confirmation; work starts here': 'Advance — confirmation; yahin se kaam shuru',
    'Working-core demo': 'Working-core demo',
    'Delivery + source-code handover': 'Delivery + source-code handover',
    'Advance — confirmation + NDA; work starts here': 'Advance — confirmation + NDA; yahin se kaam shuru',
    'Design approval (max 2 revision rounds; further rounds are change requests)':
      'Design approval (adhiktam 2 revision rounds; usse zyada rounds change request honge)',
    'UAT-ready build': 'UAT-ready build',
    'Handover + deployment + training': 'Handover + deployment + training',
  },
  billedToYou: 'Provider aapko seedhe bill karta hai, aur ye is price mein shaamil nahi hai.',
  included: 'Is price mein shaamil hai.',
  thirdParty:
    'Ye third-party accounts aapke naam par khulte hain; unki fees aur unmein koi bhi badlav is quotation ke bahar hain.',
  estimated: (min, max) => `Anumaanit ${min}–${max} hafte`,
  phase: (n, of) => `Phase ${n} / ${of}`,
  phaseWord: 'phase',
};

const HINDI: Pack = {
  timelineTerms: [
    'समय-सीमा तब शुरू होती है जब अग्रिम भुगतान और आवश्यक सामग्री (कंटेंट, क्रेडेंशियल, एक्सेस) मिल जाती है।',
    'हर समीक्षा पर क्लाइंट की प्रतिक्रिया 3 कार्य-दिवसों के भीतर चाहिए; क्लाइंट की ओर से देरी होने पर समय-सीमा उसी अनुपात में बढ़ती है।',
    'ऐप-स्टोर समीक्षा, पेमेंट-गेटवे सक्रियण और DNS इस समय-सीमा से बाहर हैं।',
  ],
  supportLines: [
    'बग — शामिल सूची में जो चीज़ लिखे अनुसार काम न करे: हैंडओवर के बाद 30 दिन तक कार्य-समय में निःशुल्क ठीक की जाएगी।',
    'शामिल स्कोप में बदलाव एक चेंज रिक्वेस्ट है; जो सूची में नहीं है वह नया फीचर है — दोनों अलग से कोट किए जाते हैं।',
    'इस अवधि के बाद का रखरखाव (अपडेट, मॉनिटरिंग, बैकअप) वैकल्पिक AMC है, माँगने पर कोट किया जाता है।',
    'थर्ड-पार्टी समस्याएँ (गेटवे, स्टोर, होस्टिंग, SMS) ठीक करना संबंधित विक्रेता का काम है; हम सहायता करेंगे।',
  ],
  gstLine: 'सभी राशियाँ GST के बिना हैं; 18% GST अतिरिक्त लगेगा।',
  gstNeutral: 'सभी राशियाँ GST के बिना हैं; GST लागू दर पर अतिरिक्त लगेगा।',
  gstNone: 'इस कोटेशन पर कोई GST नहीं लगता।',
  scopeProtection: [
    'ऊपर जो कुछ लिखा है वह शामिल है। जो नहीं लिखा, वह स्कोप से बाहर है।',
    'इस स्कोप में कोई भी बदलाव — जोड़ना, हटाना या बदलना — एक चेंज रिक्वेस्ट है: उससे अपनी कीमत और समय-सीमा के साथ नया कोटेशन संस्करण बनता है, और उस पर काम लिखित स्वीकृति के बाद शुरू होता है।',
  ],
  nextSteps: [
    'पुष्टि करने या बदलाव माँगने के लिए इसी बातचीत में उत्तर दें — कोटेशन नए संस्करण के रूप में बदल जाता है।',
    'पुष्टि पर: अग्रिम भुगतान, और काम 2–3 कार्य-दिवसों के भीतर शुरू होता है।',
    'सोर्स कोड और IP का हस्तांतरण अंतिम भुगतान पर होता है।',
  ],
  validity: (days) => `यह कोटेशन अपनी तिथि से ${days} दिनों तक वैध है।`,
  clauses: {
    acceptance_window:
      'कोई चरण तब स्वीकृत माना जाता है जब उसमें नामित डेमो दे दिया गया हो और 5 कार्य-दिवसों के भीतर कोई लिखित आपत्ति न आए।',
    cancellation:
      'रद्द करने की स्थिति में, अंतिम स्वीकृत चरण तक किया गया काम देय है और शुरू हो चुके काम के लिए दिया गया अग्रिम वापस नहीं होगा।',
    liability_cap: 'हमारी कुल देनदारी इस कोटेशन के अंतर्गत चुकाई गई राशि तक सीमित है।',
    jurisdiction: 'भारतीय कानून लागू होगा, और मोहाली / चंडीगढ़ की अदालतों का क्षेत्राधिकार होगा।',
  },
  regulated: {
    gaming: [
      'रियल-मनी गेमिंग विनियमित है और राज्य के अनुसार अलग है। लाइसेंस, आयु-सीमा और राज्यवार वैधता क्लाइंट की ज़िम्मेदारी है।',
      'हम सॉफ़्टवेयर बनाते हैं; इसे कानूनन चलाया जा सकता है या नहीं, इस पर हम सलाह नहीं देते।',
    ],
    lending: [
      'ऋण देना विनियमित है। RBI डिजिटल लेंडिंग अनुपालन, NBFC या LSP लाइसेंस और उधार लेने वाले को दिखाए जाने वाले सभी प्रकटीकरण क्लाइंट की ज़िम्मेदारी हैं।',
      'हम सॉफ़्टवेयर बनाते हैं; ऋण-पूँजी, सह-ऋण व्यवस्था और नियामकीय स्वीकृति इस स्कोप से बाहर हैं।',
    ],
    health: [
      'स्वास्थ्य डेटा संवेदनशील व्यक्तिगत डेटा है। नैदानिक वैधता, चिकित्सक लाइसेंस और रोगी-सहमति की प्रक्रियाएँ क्लाइंट की ज़िम्मेदारी हैं।',
      'यहाँ जो कुछ दिया जा रहा है वह कोई चिकित्सा उपकरण या निदान उपकरण नहीं है।',
    ],
    payouts: [
      'क्लाइंट के फंड रखना या भुगतान करना विनियमित है। पेमेंट-एग्रीगेटर स्थिति, एस्क्रो व्यवस्था और KYC दायित्व क्लाइंट की ज़िम्मेदारी हैं।',
      'पैसा क्लाइंट के अपने गेटवे और मर्चेंट खाते से जाता है, हमारे से कभी नहीं।',
    ],
  },
  payment: {
    'Advance — confirmation; work starts here': 'अग्रिम — पुष्टि; यहीं से काम शुरू',
    'Working-core demo': 'कार्यशील-कोर डेमो',
    'Delivery + source-code handover': 'डिलीवरी + सोर्स-कोड हैंडओवर',
    'Advance — confirmation + NDA; work starts here': 'अग्रिम — पुष्टि + NDA; यहीं से काम शुरू',
    'Design approval (max 2 revision rounds; further rounds are change requests)':
      'डिज़ाइन स्वीकृति (अधिकतम 2 संशोधन चरण; इससे अधिक चरण चेंज रिक्वेस्ट होंगे)',
    'UAT-ready build': 'UAT-तैयार बिल्ड',
    'Handover + deployment + training': 'हैंडओवर + डिप्लॉयमेंट + प्रशिक्षण',
  },
  billedToYou: 'प्रदाता आपको सीधे बिल करता है, और यह इस कीमत का हिस्सा नहीं है।',
  included: 'इस कीमत में शामिल है।',
  thirdParty: 'ये थर्ड-पार्टी खाते आपके नाम पर खुलते हैं; इनकी फीस और इनमें कोई भी बदलाव इस कोटेशन से बाहर हैं।',
  estimated: (min, max) => `अनुमानित ${min}–${max} सप्ताह`,
  phase: (n, of) => `चरण ${n} / ${of}`,
  phaseWord: 'चरण',
};

export const STANDARD_TRANSLATIONS: Readonly<Record<TranslatedLanguage, Pack>> = { hinglish: HINGLISH, hindi: HINDI };

const EN_BILLED = 'Billed to you directly by the provider, and not part of this price.';
const EN_INCLUDED = 'Included in this price.';
const EN_THIRD_PARTY =
  'These third-party accounts are opened in your name; their fees and any changes to them are outside this quotation.';
const EN_VALIDITY = /^This quotation is valid for (\d+) days from its date\.$/;

/**
 * The same sections with the agency's DEFAULT wording replaced by the chosen
 * language's. Anything that is not byte-identical to a known default passes
 * through untouched (see the header). English returns the input unchanged.
 */
export function localiseSections(sections: Sections, language: QuotationLanguage): Sections {
  if (language === 'en') return sections;
  const pack = STANDARD_TRANSLATIONS[language];

  const sameLines = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((l, i) => l === b[i]);
  const byEquality = (lines: readonly string[], en: readonly string[], tr: readonly string[]) =>
    sameLines(lines, en) ? tr : lines;

  const regulatedEn = new Map<string, string>();
  for (const [category, lines] of Object.entries(REGULATED_CLAUSES)) {
    lines.forEach((line, i) => {
      const t = pack.regulated[category]?.[i];
      if (t) regulatedEn.set(line, t);
    });
  }
  const clauseEn = new Map<string, string>();
  for (const key of CLAUSE_KEYS) clauseEn.set(DEFAULT_CLAUSES[key], pack.clauses[key]);

  const translateIntegration = (line: string): string => {
    if (line === EN_THIRD_PARTY) return pack.thirdParty;
    return line.replace(EN_BILLED, pack.billedToYou).replace(EN_INCLUDED, pack.included);
  };

  return {
    ...sections,
    timelineLabel: sections.timelineLabel.replace(/^Estimated (\d+)–(\d+) weeks$/, (_m, a, b) =>
      pack.estimated(Number(a), Number(b)),
    ),
    timelineTerms: byEquality(sections.timelineTerms, TIMELINE_TERMS, pack.timelineTerms),
    supportLines: byEquality(sections.supportLines, SUPPORT_STANDARD.lines, pack.supportLines),
    gstLine: localiseGstLine(sections.gstLine, pack),
    scopeProtection: byEquality(sections.scopeProtection, SCOPE_PROTECTION_LINES, pack.scopeProtection),
    nextSteps: byEquality(sections.nextSteps, NEXT_STEPS_LINES, pack.nextSteps),
    regulatedClauses: sections.regulatedClauses
      ? sections.regulatedClauses.map((l) => regulatedEn.get(l) ?? l)
      : sections.regulatedClauses,
    commercialTerms: sections.commercialTerms.map((l) => {
      const m = EN_VALIDITY.exec(l);
      if (m) return pack.validity(Number(m[1]));
      return clauseEn.get(l) ?? l;
    }),
    paymentRows: sections.paymentRows.map((r) => ({ ...r, label: pack.payment[r.label] ?? r.label })),
    integrationLines: sections.integrationLines ? sections.integrationLines.map(translateIntegration) : sections.integrationLines,
    phaseLabel: sections.phaseLabel
      ? sections.phaseLabel.replace(/^Phase (\d+) of (\d+)$/, (_m, n, of) => pack.phase(Number(n), Number(of)))
      : sections.phaseLabel,
    deferredLines: sections.deferredLines
      ? sections.deferredLines.map((l) => l.replace(/ — phase (\d+)$/, ` — ${pack.phaseWord} $1`))
      : sections.deferredLines,
  };
}

/**
 * The GST sentence in the client's language. The legacy sentence, the neutral one and the no-GST one map to their translations; a sentence naming the agency's
 * configured rate keeps that rate: the pack's 18% is replaced by the number the sentence carries. Anything else is somebody's own wording and prints as written.
 */
const ENGLISH_RATED = /^All amounts are exclusive of GST; (\d+(?:\.\d+)?)% GST extra\.$/;
function localiseGstLine(line: string | null, pack: Pack): string | null {
  if (line === null) return null;
  if (line === GST_LINE) return pack.gstLine;
  if (line === GST_NEUTRAL_LINE) return pack.gstNeutral;
  if (line === GST_NONE_LINE) return pack.gstNone;
  const rated = ENGLISH_RATED.exec(line);
  return rated ? pack.gstLine.replace('18%', `${rated[1]}%`) : line;
}
