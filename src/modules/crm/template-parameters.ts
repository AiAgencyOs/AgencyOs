import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Filling an approved template's variables — G-215.
 *
 * ── what was here before ──────────────────────────────────────────────────
 *
 * `crm.whatsapp_templates.parameters` documented itself as *"names of things
 * this system already holds"*, and nothing resolved them: the array went
 * straight to Meta and each entry was wrapped as `{type: 'text', text}`. An
 * Admin registering the documented thing — `first_name` — sent a client the
 * literal word **"first_name"**.
 *
 * ── why names rather than values ──────────────────────────────────────────
 *
 * A template is ONE approved body sent to many people. A literal value in the
 * registry would be the same name, the same reference, for every one of them
 * — which is not a variable, it is a typo everybody receives.
 *
 * ── and why an unfillable one stops the send ──────────────────────────────
 *
 * There is no fallback here, and that is a decision rather than an omission.
 * "Hi there" in place of a name is a sentence the agency did not write and
 * nobody at Meta approved; the name itself is worse. A template whose
 * variables cannot all be filled is not sent, and the reason says which one
 * was missing so somebody can fix it.
 */

export { TEMPLATE_PARAMETERS, TEMPLATE_PARAMETER_LABELS, type TemplateParameter } from '@/lib/whatsapp/template-vocabulary';

export type ParameterSubject = {
  /** The proposal this send is about, when it is about one. */
  proposalId?: string | null;
};

export type ResolvedParameters =
  | { ok: true; values: string[] }
  | { ok: false; missing: readonly string[] }
  | { ok: false; unreadable: true; detail: string };

/**
 * A first name, or nothing.
 *
 * A contact's `full_name` is whatever WhatsApp's profile said, and on this
 * deployment that is often a phone number, a business name in full, or an
 * emoji. Addressing somebody as "+91" is worse than not addressing them, so
 * anything that is not plainly a name is treated as absent.
 */
function firstNameOf(fullName: string | null): string | null {
  const trimmed = (fullName ?? '').trim();
  if (!trimmed) return null;
  const first = trimmed.split(/\s+/)[0] ?? '';
  // Digits, punctuation-only, or a single character: not a name anybody
  // wants to be greeted by.
  if (first.length < 2) return null;
  if (!/\p{L}/u.test(first)) return null;
  if (/\d/.test(first)) return null;
  return first;
}

export async function resolveTemplateParameters(
  admin: Admin,
  input: {
    organizationId: string;
    conversationId: string;
    names: readonly string[];
    subject?: ParameterSubject;
  },
): Promise<ResolvedParameters> {
  if (input.names.length === 0) return { ok: true, values: [] };

  const wanted = new Set(input.names);
  const values = new Map<string, string>();
  const missing: string[] = [];

  // ── the contact on the other end ────────────────────────────────────────
  if (wanted.has('contact_first_name') || wanted.has('contact_full_name')) {
    // Two plain reads rather than an embedded one: a PostgREST relationship
    // alias is a name that can change under a schema edit, and a send should
    // not stop because a join hint went stale.
    const { data: convo, error: convoError } = await admin
      .schema('crm')
      .from('conversations')
      .select('contact_id')
      .eq('id', input.conversationId)
      .eq('organization_id', input.organizationId)
      .maybeSingle();

    if (convoError) {
      return { ok: false, unreadable: true, detail: `could not read the conversation: ${convoError.message}` };
    }

    let fullName: string | null = null;
    if (convo?.contact_id) {
      const { data: contact, error: contactError } = await admin
        .schema('crm')
        .from('contacts')
        .select('full_name')
        .eq('id', convo.contact_id)
        .eq('organization_id', input.organizationId)
        .maybeSingle();
      if (contactError) {
        return { ok: false, unreadable: true, detail: `could not read the contact: ${contactError.message}` };
      }
      fullName = contact?.full_name ?? null;
    }

    if (wanted.has('contact_full_name')) {
      const full = (fullName ?? '').trim();
      if (full) values.set('contact_full_name', full);
      else missing.push('contact_full_name');
    }
    if (wanted.has('contact_first_name')) {
      const first = firstNameOf(fullName);
      if (first) values.set('contact_first_name', first);
      else missing.push('contact_first_name');
    }
  }

  // ── the agency sending it ───────────────────────────────────────────────
  if (wanted.has('agency_name')) {
    const { data, error } = await admin
      .schema('core')
      .from('organizations')
      .select('name')
      .eq('id', input.organizationId)
      .maybeSingle();
    if (error) {
      return { ok: false, unreadable: true, detail: `could not read the organization: ${error.message}` };
    }
    const name = (data?.name ?? '').trim();
    if (name) values.set('agency_name', name);
    else missing.push('agency_name');
  }

  // ── the quotation it is about, when it is about one ─────────────────────
  if (wanted.has('quotation_reference') || wanted.has('quotation_version')) {
    const proposalId = input.subject?.proposalId ?? null;
    if (!proposalId) {
      // The template asks about a quotation and this send is not about one.
      // Refused rather than filled: there is no correct value.
      if (wanted.has('quotation_reference')) missing.push('quotation_reference');
      if (wanted.has('quotation_version')) missing.push('quotation_version');
    } else {
      const { data, error } = await admin
        .schema('sales')
        .from('proposals')
        .select('version, approval_request_id')
        .eq('id', proposalId)
        .eq('organization_id', input.organizationId)
        .maybeSingle();
      if (error) {
        return { ok: false, unreadable: true, detail: `could not read the quotation: ${error.message}` };
      }

      if (wanted.has('quotation_version')) {
        if (typeof data?.version === 'number') values.set('quotation_version', `v${data.version}`);
        else missing.push('quotation_version');
      }

      if (wanted.has('quotation_reference')) {
        // The six-character reference a person reads back to the agency. It
        // lives on the approval request, which is where it is generated.
        let reference: string | null = null;
        if (data?.approval_request_id) {
          const { data: request, error: requestError } = await admin
            .schema('approvals')
            .from('approval_requests')
            .select('reference')
            .eq('id', data.approval_request_id)
            .eq('organization_id', input.organizationId)
            .maybeSingle();
          if (requestError) {
            return { ok: false, unreadable: true, detail: `could not read the approval: ${requestError.message}` };
          }
          reference = request?.reference ?? null;
        }
        if (reference) values.set('quotation_reference', reference);
        else missing.push('quotation_reference');
      }
    }
  }

  // Anything the vocabulary does not cover. The database refuses these at
  // registration, so reaching here means the constraint was bypassed — and
  // the send stops rather than sending the name.
  for (const name of input.names) {
    if (!values.has(name) && !missing.includes(name)) missing.push(name);
  }

  if (missing.length > 0) return { ok: false, missing };

  // In the order the template declares them, because Meta fills {{1}}, {{2}}
  // positionally and a set has no order.
  return { ok: true, values: input.names.map((name) => values.get(name)!) };
}
