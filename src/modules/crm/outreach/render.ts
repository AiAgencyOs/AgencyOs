/**
 * What an outreach email looks like when it leaves - pure, so every rule is a test.
 *
 * The TEMPLATE is a person's words (approved by a second person; the database refuses prices,
 * AI tooling and fake unsubscribe lines in it). Everything that makes the email lawful is added
 * HERE, by the system, so no template can forget it or fake it: who is writing, where they are,
 * why the reader is getting it, and a working way to stop.
 */

export type OutreachBasis = 'consent' | 'existing_relationship' | 'b2b_legitimate_interest';
export type OutreachLanguage = 'en' | 'hinglish' | 'hindi';

export type RenderInput = {
  subject: string;
  body: string;
  firstName: string | null;
  company: string | null;
  senderName: string;
  postalAddress: string;
  unsubscribeUrl: string;
  basis: OutreachBasis;
  language: OutreachLanguage;
};

export type RenderedOutreach = { subject: string; text: string };

const FALLBACK_NAME: Record<OutreachLanguage, string> = { en: 'there', hinglish: 'ji', hindi: 'जी' };
const FALLBACK_COMPANY: Record<OutreachLanguage, string> = { en: 'your business', hinglish: 'aapka business', hindi: 'आपका व्यवसाय' };

const WHY: Record<OutreachBasis, Record<OutreachLanguage, string>> = {
  consent: {
    en: 'You are receiving this because you agreed to hear from us.',
    hinglish: 'Aapko yeh isliye mil raha hai kyunki aapne humse sampark rakhne ki sahmati di thi.',
    hindi: 'आपको यह इसलिए मिल रहा है क्योंकि आपने हमसे संपर्क में रहने की सहमति दी थी।',
  },
  existing_relationship: {
    en: 'You are receiving this because you have worked with us or asked us about a project.',
    hinglish: 'Aapko yeh isliye mil raha hai kyunki aapne humare saath kaam kiya hai ya kisi project ke bare me pucha tha.',
    hindi: 'आपको यह इसलिए मिल रहा है क्योंकि आपने हमारे साथ काम किया है या किसी प्रोजेक्ट के बारे में पूछा था।',
  },
  b2b_legitimate_interest: {
    en: 'You are receiving this because your business contact details are publicly listed and we think our work may be relevant to you.',
    hinglish: 'Aapko yeh isliye mil raha hai kyunki aapke business ki contact details public hain aur humein lagta hai humara kaam aapke liye upyogi ho sakta hai.',
    hindi: 'आपको यह इसलिए मिल रहा है क्योंकि आपके व्यवसाय की संपर्क जानकारी सार्वजनिक है और हमें लगता है कि हमारा काम आपके लिए उपयोगी हो सकता है।',
  },
};

const STOP: Record<OutreachLanguage, string> = {
  en: 'If you would rather not hear from us again, unsubscribe here:',
  hinglish: 'Agar aap humse dobara sampark nahi chahte, to yahan unsubscribe karein:',
  hindi: 'यदि आप हमसे दोबारा संपर्क नहीं चाहते, तो यहाँ अनसब्सक्राइब करें:',
};

function fill(text: string, v: { first_name: string; company: string; sender_name: string }): string {
  return text.replaceAll('{{first_name}}', v.first_name).replaceAll('{{company}}', v.company).replaceAll('{{sender_name}}', v.sender_name);
}

export function renderOutreach(input: RenderInput): RenderedOutreach {
  const vars = {
    first_name: input.firstName?.trim() || FALLBACK_NAME[input.language],
    company: input.company?.trim() || FALLBACK_COMPANY[input.language],
    sender_name: input.senderName,
  };
  const subject = fill(input.subject, vars).replace(/[\r\n]+/g, ' ').trim();
  const footer = ['--', input.senderName, input.postalAddress, '', WHY[input.basis][input.language], `${STOP[input.language]} ${input.unsubscribeUrl}`].join('\n');
  return { subject, text: `${fill(input.body, vars).trim()}\n\n${footer}\n` };
}

/** RFC 8058 one-click: the two headers mailbox providers look for. Values are single-line by construction. */
export function unsubscribeHeaders(unsubscribeUrl: string, mailto: string | null): Record<string, string> {
  const targets = [`<${unsubscribeUrl}>`, ...(mailto ? [`<mailto:${mailto}?subject=unsubscribe>`] : [])];
  return { 'List-Unsubscribe': targets.join(', '), 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

/**
 * Decide whether an SMTP refusal means the ADDRESS is dead (suppress it for good) or the attempt
 * failed for a reason that may pass (retry). Only a refusal of the recipient itself is a bounce;
 * a timeout, a greylist, a full queue or an authentication problem is not the recipient's fault.
 */
export function classifySmtpFailure(reason: string): 'bounced' | 'failed' {
  const r = reason.toLowerCase();
  const rcpt = /rcpt to/.test(r);
  const permanentRecipient = /(→|->|:)\s*5(50|51|53|54)\b/.test(r) || /user unknown|no such user|mailbox (not found|unavailable|does not exist)|address rejected|recipient (rejected|address rejected)|does not exist/.test(r);
  const temporary = /(→|->|:)\s*4\d\d\b|timeout|timed out|greylist|try again|rate limit|too many/.test(r);
  if (temporary) return 'failed';
  return rcpt && permanentRecipient ? 'bounced' : 'failed';
}
