import type { QuotationLanguage } from '@/lib/pdf/quotation-labels';

/**
 * What a client is told when they write while their thread waits for a person.
 *
 * Fixed text, written by people, in the language and script the client writes.
 * Not the agent's words and not a model's: it says one thing — a colleague has
 * it — and promises nothing else. No time ("in 10 minutes"), no answer, no
 * apology for a delay that has not been measured.
 */
const ACKNOWLEDGEMENT: Readonly<Record<QuotationLanguage, string>> = {
  en: 'Thanks for your message — it has reached us. A colleague is looking into this and will reply to you personally.',
  hinglish: 'Aapka message mil gaya. Hamare ek colleague isko dekh rahe hain aur jaldi hi aapse khud baat karenge.',
  hindi: 'आपका संदेश हमें मिल गया है। हमारे एक सहयोगी इसे देख रहे हैं और जल्द ही आपसे स्वयं बात करेंगे।',
};

export function handoverAcknowledgementFor(language: QuotationLanguage): string {
  return ACKNOWLEDGEMENT[language];
}

/** The idempotency key: one acknowledgement per pause, however many messages arrive during it. */
export function handoverAcknowledgementRef(conversationId: string, pausedAt: string): string {
  return `handover-ack:${conversationId}:${new Date(pausedAt).getTime()}`;
}
