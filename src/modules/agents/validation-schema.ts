import { z } from 'zod';

/** SCR-062 — a person validates one agent's configuration. The key is all the door needs. */
export const validateAgentConfigurationSchema = z.object({
  agentKey: z.string().regex(/^[a-z][a-z0-9_]{2,48}$/, 'Not an agent key.'),
});
export type ValidateAgentConfigurationInput = z.infer<typeof validateAgentConfigurationSchema>;
