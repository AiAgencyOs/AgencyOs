import { z } from 'zod';

/**
 * A template send from the Lead 360 composer — owner decision 2026-09-29
 * (AGENT_BRIEF_D, "Template sends from the Lead 360 composer"; reverses the
 * earlier decline). The person picks an approved `crm.whatsapp_templates`
 * row; the parameters are filled server-side from the facts the registry
 * names (never typed by hand, so a template cannot carry a sentence the
 * agency did not approve); the send goes through `crm.send_outbound_message`
 * and the provider's template endpoint.
 */
export const sendTemplateMessageSchema = z.object({
  conversationId: z.uuid(),
  templateId: z.uuid('Choose a template.'),
  /** The quotation this send is about, when a template variable needs one. */
  proposalId: z.uuid().optional(),
});
export type SendTemplateMessageInput = z.infer<typeof sendTemplateMessageSchema>;

/**
 * What the transcript records for a template send. Meta holds the words;
 * this holds which template, in which language, with which values — enough
 * for a person reading the thread later to know what the client received.
 */
export function describeTemplateSend(input: {
  templateName: string;
  languageCode: string;
  parameters: readonly string[];
  values: readonly string[];
}): string {
  const filled = input.parameters.map((name, i) => `${name}: ${input.values[i] ?? ''}`);
  return `[Template ${input.templateName} · ${input.languageCode}]${filled.length > 0 ? ` ${filled.join(' · ')}` : ''}`;
}
