import type { P4uiAdmin } from './p4ui';

/**
 * P4-UID-015/016 (docs/phase-4-ui-prototype-round4-log.md): the planning and brand inputs a person recorded for a Phase 4 workspace
 * (`projects.p4r_design_inputs`, written only through `p4r_record_design_inputs`), rendered as the paragraph the UI Designer is given beside the locked
 * screens and the locked direction. Read for the job's organization. A failed read is returned as an error, never as "no inputs": the draft would otherwise be
 * made without the brief and nobody would know.
 */
export type DesignInputsLine = { ok: true; line: string } | { ok: false; detail: string };

export async function designInputsLine(admin: P4uiAdmin, input: { organizationId: string; phaseFourId: string }): Promise<DesignInputsLine> {
  const { data, error } = await admin
    .schema('projects')
    .from('p4r_design_inputs')
    .select('brand_assets, accessibility_targets, device_targets, planning_note')
    .eq('phase_four_id', input.phaseFourId)
    .eq('organization_id', input.organizationId)
    .maybeSingle();
  if (error) return { ok: false, detail: `could not read the design inputs: ${error.message}` };
  if (!data) return { ok: true, line: '' };

  const assets = (Array.isArray(data.brand_assets) ? data.brand_assets : []) as Array<{ name?: unknown; placeholderApproved?: unknown }>;
  const lines: string[] = [];
  if (assets.length > 0) {
    lines.push(
      'Brand assets the team named (use only these; where an asset is marked as a placeholder, draw a clearly-labelled placeholder, and never invent the asset itself):',
      ...assets.map((a) => `- ${String(a.name ?? '').slice(0, 120)}${a.placeholderApproved === true ? ' (approved placeholder)' : ''}`),
    );
  }
  const access = Array.isArray(data.accessibility_targets) ? (data.accessibility_targets as string[]) : [];
  if (access.length > 0) lines.push(`Accessibility targets: ${access.join(', ')}.`);
  const devices = Array.isArray(data.device_targets) ? (data.device_targets as string[]) : [];
  if (devices.length > 0) lines.push(`Devices the scope requires (design only these): ${devices.join(', ')}.`);
  if (typeof data.planning_note === 'string' && data.planning_note.length > 0) lines.push(`Planning note: ${data.planning_note}`);
  return { ok: true, line: lines.length > 0 ? `\n\nThe team's design inputs:\n${lines.join('\n')}` : '' };
}
