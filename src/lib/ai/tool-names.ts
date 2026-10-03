/**
 * Anthropic accepts tool names matching ^[a-zA-Z0-9_-]{1,128}$. Every AgencyOS
 * tool id is dotted (`crm.readLead`, `memory.recall`), and those dots are the
 * authorization vocabulary — `resolveTool` and the registry key on them — so
 * the id is not renamed; it is translated at THIS boundary and nowhere else.
 * A stub model never validates the pattern, which is how every tool-using
 * call shipped refused by the real API (400 `tools.0.custom.name`) while every
 * verifier was green. No tool id contains `__`, so the mapping is reversible.
 */
export function toWireToolName(name: string): string {
  return name.replace(/\./g, '__');
}
export function fromWireToolName(name: string): string {
  return name.replace(/__/g, '.');
}
