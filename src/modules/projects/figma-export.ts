import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * What the Figma plugin is given: the project's FINALIZED screens (the screen list a person locked) and the selected design
 * direction (the one the client locked, else the one they selected). Nothing is invented; with no finalized screen the plugin is
 * told so rather than handed a guess. No client contact details, prices or messages are in it - it is design structure only.
 */

export type FigmaExportScreen = {
  id: string;
  key: string;
  name: string;
  role: string;
  purpose: string | null;
  entryPoint: string | null;
  exitAction: string | null;
  requiredData: string | null;
  actions: string | null;
  components: string[];
  devices: string[];
  states: { has_empty_state: boolean; has_loading_state: boolean; has_error_state: boolean; has_success_state: boolean };
  figmaUrl: string | null;
};

export type FigmaExport = {
  version: 1;
  project: { id: string; name: string };
  baselineVersion: number | null;
  direction: {
    themeOptionId: string;
    name: string;
    summary: string;
    chosenBy: 'locked' | 'selected';
    palette: { name: string; primary: string; secondary: string | null; accent: string | null; background: string | null; surface: string | null; textPrimary: string | null; textSecondary: string | null; success: string | null; warning: string | null; error: string | null } | null;
    tokens: { fontHeading: string | null; fontBody: string | null; radiusStyle: string | null; navigationStyle: string | null; buttonTreatment: string | null; cardTreatment: string | null } | null;
  } | null;
  screens: FigmaExportScreen[];
};

export async function buildFigmaExport(admin: Admin, args: { organizationId: string; projectId: string }): Promise<FigmaExport | null> {
  const { organizationId, projectId } = args;
  const project = await admin.schema('projects').from('projects').select('id, name').eq('id', projectId).eq('organization_id', organizationId).maybeSingle();
  if (!project.data) return null;

  const [screens, themes] = await Promise.all([
    admin
      .schema('projects')
      .from('screens')
      .select('id, screen_key, name, user_role, purpose, entry_point, exit_action, required_data, actions, components, device_targets, has_empty_state, has_loading_state, has_error_state, has_success_state, figma_url, baseline_version, status')
      .eq('organization_id', organizationId)
      .eq('project_id', projectId)
      .neq('status', 'superseded')
      .not('baseline_version', 'is', null)
      .order('screen_key'),
    admin.schema('projects').from('theme_options').select('id, name, direction_summary, client_status, option_index').eq('organization_id', organizationId).eq('project_id', projectId).in('client_status', ['locked', 'selected']).order('option_index'),
  ]);
  if (screens.error) throw new Error(`figma export: screens could not be read: ${screens.error.message}`);
  if (themes.error) throw new Error(`figma export: themes could not be read: ${themes.error.message}`);

  const theme = (themes.data ?? []).find((t) => t.client_status === 'locked') ?? (themes.data ?? [])[0] ?? null;
  let direction: FigmaExport['direction'] = null;
  if (theme) {
    const [color, tokens] = await Promise.all([
      admin.schema('projects').from('color_options').select('*').eq('organization_id', organizationId).eq('theme_option_id', theme.id).order('option_index').limit(1).maybeSingle(),
      admin.schema('projects').from('design_token_sets').select('*').eq('organization_id', organizationId).eq('theme_option_id', theme.id).order('version', { ascending: false }).limit(1).maybeSingle(),
    ]);
    direction = {
      themeOptionId: theme.id,
      name: theme.name,
      summary: theme.direction_summary,
      chosenBy: theme.client_status === 'locked' ? 'locked' : 'selected',
      palette: color.data
        ? {
            name: color.data.palette_name,
            primary: color.data.primary_hex,
            secondary: color.data.secondary_hex,
            accent: color.data.accent_hex,
            background: color.data.background_hex,
            surface: color.data.surface_hex,
            textPrimary: color.data.text_primary_hex,
            textSecondary: color.data.text_secondary_hex,
            success: color.data.success_hex,
            warning: color.data.warning_hex,
            error: color.data.error_hex,
          }
        : null,
      tokens: tokens.data
        ? {
            fontHeading: tokens.data.font_family_heading,
            fontBody: tokens.data.font_family_body,
            radiusStyle: tokens.data.radius_style,
            navigationStyle: tokens.data.navigation_style,
            buttonTreatment: tokens.data.button_treatment,
            cardTreatment: tokens.data.card_treatment,
          }
        : null,
    };
  }

  const rows = screens.data ?? [];
  return {
    version: 1,
    project: { id: project.data.id, name: project.data.name },
    baselineVersion: rows.reduce<number | null>((m, r) => (r.baseline_version !== null && (m === null || r.baseline_version > m) ? r.baseline_version : m), null),
    direction,
    screens: rows.map((r) => ({
      id: r.id,
      key: r.screen_key,
      name: r.name,
      role: r.user_role,
      purpose: r.purpose,
      entryPoint: r.entry_point,
      exitAction: r.exit_action,
      requiredData: r.required_data,
      actions: r.actions,
      components: r.components ?? [],
      devices: r.device_targets ?? [],
      states: { has_empty_state: r.has_empty_state, has_loading_state: r.has_loading_state, has_error_state: r.has_error_state, has_success_state: r.has_success_state },
      figmaUrl: r.figma_url,
    })),
  };
}
