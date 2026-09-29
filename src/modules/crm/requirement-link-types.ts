/**
 * SCR-029 (bucket G-3) — client-safe shapes for the requirement "Link…"
 * form. No `server-only` import here: the form is a client component and
 * the reader (`src/lib/admin/requirement-links.ts`) is not.
 */
export type RequirementLinkTargetOptions = {
  quotations: { id: string; title: string; version: number; status: string }[];
  designs: { id: string; title: string; version: number; status: string; projectId: string; projectName: string }[];
  tasks: { id: string; title: string; status: string; projectId: string; projectName: string }[];
};
