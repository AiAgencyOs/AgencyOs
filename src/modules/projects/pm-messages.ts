/**
 * What the project manager says to a client during Phase 2 — written in code,
 * in the client's language, never composed by a model.
 *
 * Phase 2 PM §14 and Master §16 ask for exactly this: configurable templates
 * that "must not contain unsupported promises". So every line is a fact the
 * system already holds or a question, never a date, a price, an approval it has
 * not got, or a word about which model or provider is behind it. Amounts are
 * deliberately absent: the invoice carries them, and an automated message that
 * states a price is a human's to author (ADM-22).
 *
 * Three languages, the same three the quotation and the hand-over use: English,
 * Hinglish in Roman letters, and Hindi in Devanagari — the script the client
 * wrote in is the script they are answered in.
 */
export type PmLanguage = 'en' | 'hinglish' | 'hindi';

type Table = Record<PmLanguage, string>;

const pick = (t: Table, language: PmLanguage): string => t[language] ?? t.en;

export function pmWelcome(input: { language: PmLanguage; agencyName: string; projectName: string }): string {
  const { agencyName: a, projectName: p } = input;
  return pick(
    {
      en: `Welcome aboard! I'm the project manager at ${a} for "${p}". I'll guide you through the setup and be your point of contact. I'll only ask for what we don't already have. Please never send passwords or keys in this chat — if we need access to anything, a colleague will arrange a secure way.`,
      hinglish: `Welcome! Main ${a} me "${p}" ka project manager hoon. Setup me main aapko guide karunga aur aapka point of contact rahunga. Jo humare paas pehle se hai wo dobara nahi poochunga. Kripya password ya keys is chat me kabhi na bhejein — agar kisi cheez ka access chahiye hoga to hamare colleague surakshit tareeka bata denge.`,
      hindi: `स्वागत है! मैं ${a} में "${p}" का प्रोजेक्ट मैनेजर हूँ। सेटअप में मैं आपका मार्गदर्शन करूँगा और आपका संपर्क-बिंदु रहूँगा। जो जानकारी हमारे पास पहले से है, वह दोबारा नहीं पूछूँगा। कृपया पासवर्ड या कुंजियाँ (keys) इस चैट में कभी न भेजें — किसी चीज़ का एक्सेस चाहिए होगा तो हमारे सहयोगी सुरक्षित तरीका बता देंगे।`,
    },
    input.language,
  );
}

export function pmBillingQuestion(language: PmLanguage): string {
  return pick(
    {
      en: 'For billing, please confirm whether you need a GST invoice or a Non-GST invoice.',
      hinglish: 'Billing ke liye please confirm karein ki aapko GST invoice chahiye ya Non-GST invoice.',
      hindi: 'बिलिंग के लिए कृपया बताएँ कि आपको GST इनवॉइस चाहिए या Non-GST इनवॉइस।',
    },
    language,
  );
}

export function pmGstDetailsRequest(language: PmLanguage): string {
  return pick(
    {
      en: 'For the GST invoice we need: your registered business name, GSTIN, billing address and state. Please send them in one message.',
      hinglish: 'GST invoice ke liye humein chahiye: registered business name, GSTIN, billing address aur state. Please ye sab ek hi message me bhej dein.',
      hindi: 'GST इनवॉइस के लिए हमें चाहिए: पंजीकृत व्यवसाय का नाम, GSTIN, बिलिंग पता और राज्य। कृपया ये सब एक ही संदेश में भेजें।',
    },
    language,
  );
}

export function pmPaymentReceived(language: PmLanguage): string {
  return pick(
    {
      en: 'We have received your payment details. We are verifying them and will update you shortly.',
      hinglish: 'Humein aapke payment ki details mil gayi hain. Hum unhe verify kar rahe hain aur jaldi aapko update denge.',
      hindi: 'हमें आपके भुगतान का विवरण मिल गया है। हम उसे सत्यापित कर रहे हैं और जल्द ही आपको सूचित करेंगे।',
    },
    language,
  );
}

/** The advance (M1): the gate Phase 2 was waiting on has opened. */
export function pmAdvanceVerified(language: PmLanguage): string {
  return pick(
    {
      en: 'Your advance payment has been verified, thank you. We are now preparing your project plan and will be in touch if we need anything from you.',
      hinglish: 'Aapka advance payment verify ho gaya hai, thank you. Ab hum aapka project plan taiyaar kar rahe hain; kuch chahiye hoga to aapse sampark karenge.',
      hindi: 'आपका एडवांस भुगतान सत्यापित हो गया है, धन्यवाद। अब हम आपकी प्रोजेक्ट योजना तैयार कर रहे हैं; कुछ चाहिए होगा तो आपसे संपर्क करेंगे।',
    },
    language,
  );
}

/** A later milestone: said without implying the project is starting again. */
export function pmPaymentVerified(language: PmLanguage, invoiceNumber: string): string {
  return pick(
    {
      en: `Your payment for invoice ${invoiceNumber} has been verified. Thank you.`,
      hinglish: `Invoice ${invoiceNumber} ka aapka payment verify ho gaya hai. Thank you.`,
      hindi: `इनवॉइस ${invoiceNumber} का आपका भुगतान सत्यापित हो गया है। धन्यवाद।`,
    },
    language,
  );
}

/**
 * Rejected or mismatched. Says only that it could not be matched yet and that a
 * person will follow up with what is needed — the staff's own note (a reason,
 * a figure) stays internal.
 */
export function pmPaymentNeedsAttention(language: PmLanguage, invoiceNumber: string): string {
  return pick(
    {
      en: `We could not match the payment details for invoice ${invoiceNumber} yet. A colleague will get in touch shortly with what is needed.`,
      hinglish: `Invoice ${invoiceNumber} ke payment ki details abhi match nahi ho payi. Hamare ek colleague jaldi aapse sampark karke bata denge ki kya chahiye.`,
      hindi: `इनवॉइस ${invoiceNumber} के भुगतान का विवरण अभी मेल नहीं खा सका। हमारे एक सहयोगी जल्द ही आपसे संपर्क करके बताएँगे कि क्या चाहिए।`,
    },
    language,
  );
}

/** Master §16: the official kickoff, short, in the project group. */
export function pmKickoff(language: PmLanguage): string {
  return pick(
    {
      en: 'Your advance payment has been verified and the project setup is complete. We are officially starting your project now.',
      hinglish: 'Aapka advance payment verify ho gaya hai aur project setup complete hai. Hum ab officially aapka project start kar rahe hain.',
      hindi: 'आपका एडवांस भुगतान सत्यापित हो गया है और प्रोजेक्ट सेटअप पूरा हो गया है। हम अब आधिकारिक रूप से आपका प्रोजेक्ट शुरू कर रहे हैं।',
    },
    language,
  );
}

/**
 * A planning question the planner raised, put to the client by the PM.
 *
 * The QUESTION is a model's words, so it is the one client-facing sentence in
 * this file that is not code-written. `isSafeClientQuestion` is what stands
 * between it and the client: it must read as a single plain question, with no
 * amount, no discount, no date and no promise in it. Anything else is held for
 * a person.
 */
export function pmClarificationAsk(language: PmLanguage, question: string): string {
  const q = question.trim();
  return pick(
    {
      en: `One quick question so we plan your project properly: ${q}`,
      hinglish: `Aapka project theek se plan karne ke liye ek chhota sa sawaal: ${q}`,
      hindi: `आपके प्रोजेक्ट की सही योजना बनाने के लिए एक छोटा सा सवाल: ${q}`,
    },
    language,
  );
}

export function isSafeClientQuestion(question: string): boolean {
  const q = question.trim();
  if (q.length < 8 || q.length > 400) return false;
  if ((q.match(/[?？]/g) ?? []).length > 2) return false;
  if (/[₹$]|\brs\.?\s*\d|\binr\b|\busd\b|\d[\d,]*\s*(k\b|lakh|lac|crore|rupees?|dollars?)|%/i.test(q)) return false;
  if (/\b(discount|free of charge|guarantee[ds]?|we promise|deadline|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week))\b/i.test(q)) return false;
  if (/https?:\/\/|```/.test(q)) return false;
  return true;
}

/**
 * A gentle reminder of an onboarding ask the client has not answered - Phase 2
 * PM §4.2. Says what is still needed and why, never who is late, never a date or
 * a consequence.
 */
export function pmFollowUp(language: PmLanguage, what: 'billing' | 'gst_details'): string {
  return pick(
    what === 'billing'
      ? {
          en: 'A gentle reminder: we are still waiting to know whether you need a GST invoice or a Non-GST invoice, so we can send your first invoice.',
          hinglish: 'Ek chhota sa reminder: humein abhi bhi jaanna hai ki aapko GST invoice chahiye ya Non-GST, taaki hum aapka pehla invoice bhej sakein.',
          hindi: 'एक छोटा सा अनुरोध: हमें अभी भी जानना है कि आपको GST इनवॉइस चाहिए या Non-GST, ताकि हम आपका पहला इनवॉइस भेज सकें।',
        }
      : {
          en: 'A gentle reminder: for your GST invoice we still need your registered business name, GSTIN, billing address and state.',
          hinglish: 'Ek chhota sa reminder: aapke GST invoice ke liye humein abhi bhi registered business name, GSTIN, billing address aur state chahiye.',
          hindi: 'एक छोटा सा अनुरोध: आपके GST इनवॉइस के लिए हमें अभी भी पंजीकृत व्यवसाय का नाम, GSTIN, बिलिंग पता और राज्य चाहिए।',
        },
    language,
  );
}
