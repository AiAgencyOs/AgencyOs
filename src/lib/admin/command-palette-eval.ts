/**
 * The command palette's matching — pure, so the search behaviour is tested
 * without a browser. It matches on the label and the section, case-insensitively,
 * requiring every whitespace-separated term to appear somewhere (so "prod ready"
 * finds "Production readiness"). Order is preserved from the input, which is
 * already grouped by section, so results stay predictable.
 *
 * The list handed to it is ALREADY capability-filtered on the server — the
 * palette can only ever navigate to a page the role may open — so there is no
 * authority decision here, only text matching.
 */

export type Command = { href: string; label: string; group: string };

export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...commands];
  return commands.filter((c) => {
    const hay = `${c.label} ${c.group}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
