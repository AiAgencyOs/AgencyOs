import type { createClient } from '@/lib/db/server';
import type { QuotationLanguage } from '@/lib/pdf/quotation-labels';

/**
 * Which language a client's quotation is written in, decided from how THEY
 * write — not from a setting, and not from the tag on a single message.
 *
 * The contact's `preferred_language` says Hindi but not which SCRIPT: a client
 * typing "mujhe app chahiye" and one typing "मुझे ऐप चाहिए" are both `hi`, and
 * they need different documents (Roman-script Hinglish vs Devanagari, which
 * has its own typeface and shaping). So the recent client messages decide the
 * script: more Devanagari letters than Latin ones → `hindi`; otherwise a Hindi
 * preference → `hinglish`; everything else → `en`.
 */
const DEVANAGARI = /[ऀ-ॿ]/g;
const LATIN = /[A-Za-z]/g;

export function writesInDevanagari(messages: readonly string[]): boolean {
  const text = messages.join(' ');
  const deva = text.match(DEVANAGARI)?.length ?? 0;
  const latin = text.match(LATIN)?.length ?? 0;
  return deva > 0 && deva > latin;
}

export function documentLanguageFrom(preferred: string | null | undefined, clientMessages: readonly string[]): QuotationLanguage {
  if (writesInDevanagari(clientMessages)) return 'hindi';
  if (preferred === 'hi' || preferred === 'hi-en') return 'hinglish';
  return 'en';
}

/** `quotation_translate_standards` — the owner's switch for the agency's standard terms in another language. */
export function translateStandardsOn(settings: unknown): boolean {
  return (settings as { quotation_translate_standards?: unknown } | null | undefined)?.quotation_translate_standards === 'on';
}

const RECENT_CLIENT_MESSAGES = 6;

type Db = Pick<Awaited<ReturnType<typeof createClient>>, 'schema'>;

/**
 * The language for a lead's quotation, read from its conversation. A read that
 * fails or finds nothing answers English — a document must never be refused
 * for want of a language — and the caller's own read of the quotation is what
 * decides whether anything can be rendered at all.
 */
export async function quotationLanguageForLead(
  db: Db,
  leadId: string | null | undefined,
  organizationId?: string,
): Promise<QuotationLanguage> {
  if (!leadId) return 'en';
  return languageFromConversation(db, { leadId }, organizationId);
}

/** The same decision for a thread known by its id — the requirement summary is sent from one. */
export async function quotationLanguageForConversation(
  db: Db,
  conversationId: string | null | undefined,
  organizationId?: string,
): Promise<QuotationLanguage> {
  if (!conversationId) return 'en';
  return languageFromConversation(db, { conversationId }, organizationId);
}

async function languageFromConversation(
  db: Db,
  by: { leadId: string } | { conversationId: string },
  organizationId?: string,
): Promise<QuotationLanguage> {
  const scoped = <T extends { eq(column: string, value: string): T }>(q: T): T =>
    organizationId ? q.eq('organization_id', organizationId) : q;

  const base = db.schema('crm').from('conversations').select('id, contact_id');
  const { data: conversation } = await scoped('leadId' in by ? base.eq('lead_id', by.leadId) : base.eq('id', by.conversationId))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conversation) return 'en';

  const [{ data: contact }, { data: messages }] = await Promise.all([
    conversation.contact_id
      ? scoped(db.schema('crm').from('contacts').select('preferred_language').eq('id', conversation.contact_id)).maybeSingle()
      : Promise.resolve({ data: null }),
    scoped(
      db.schema('crm').from('conversation_messages').select('body').eq('conversation_id', conversation.id).eq('author_type', 'client'),
    )
      .order('seq', { ascending: false })
      .limit(RECENT_CLIENT_MESSAGES),
  ]);

  return documentLanguageFrom(
    contact?.preferred_language ?? null,
    (messages ?? []).map((m) => m.body),
  );
}
