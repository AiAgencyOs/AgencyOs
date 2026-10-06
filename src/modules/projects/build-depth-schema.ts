import { z } from 'zod';

/**
 * Build pipeline depth (P509) - the pure side: what a build config may hold, how the database's outcome words read to a person, and the one
 * place a client-safe package row is shaped. No I/O here, so every decision in it is testable without a database.
 */

export const BUILD_CONFIG_KEYS = ['node_version', 'package_manager', 'install_command', 'lint_command', 'test_command', 'build_command', 'output_dir', 'target_platform'] as const;
export type BuildConfigKey = (typeof BUILD_CONFIG_KEYS)[number];

export const BUILD_CONFIG_LABEL: Record<BuildConfigKey | 'env_names', string> = {
  node_version: 'Node version',
  package_manager: 'Package manager',
  install_command: 'Install command',
  lint_command: 'Lint / type-check command',
  test_command: 'Test command',
  build_command: 'Build command',
  output_dir: 'Output directory',
  target_platform: 'Target platform',
  env_names: 'Environment variable names (never values)',
};

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

export const setBuildConfigSchema = z.object({
  projectId: z.string().uuid(),
  config: z.record(z.string(), z.string().trim().max(300)).default({}),
  envNames: z.string().max(2000).default(''),
  note: z.string().trim().max(1000).default(''),
});
export type SetBuildConfigInput = z.input<typeof setBuildConfigSchema>;

/** The jsonb the database door takes: blank fields are left out, env names are split and checked here as well as in SQL. */
export function buildConfigPayload(config: Record<string, string>, envNames: string): { ok: true; payload: Record<string, unknown> } | { ok: false; message: string } {
  const payload: Record<string, unknown> = {};
  for (const key of BUILD_CONFIG_KEYS) {
    const value = (config[key] ?? '').trim();
    if (value) payload[key] = value;
  }
  const names = envNames.split(/[\s,]+/).map((n) => n.trim()).filter(Boolean);
  const bad = names.find((n) => !ENV_NAME.test(n));
  if (bad) return { ok: false, message: `"${bad}" is not a variable name: use UPPER_CASE names, never a value.` };
  if (names.length > 0) payload.env_names = [...new Set(names)];
  if (Object.keys(payload).length === 0) return { ok: false, message: 'Fill in at least one setting.' };
  return { ok: true, payload };
}

export const createPackageSchema = z.object({
  projectId: z.string().uuid(),
  deliverableId: z.string().uuid(),
  limitations: z.string().trim().min(1, 'Say what this build cannot do yet.').max(2000),
  testingInstructions: z.string().trim().min(1, 'Say how the client should test it.').max(4000),
});
export type CreatePackageInput = z.input<typeof createPackageSchema>;

export const cancelRequestSchema = z.object({ projectId: z.string().uuid(), requestId: z.string().uuid(), reason: z.string().trim().max(500).default('') });
export type CancelRequestInput = z.input<typeof cancelRequestSchema>;

const CONFIG_OUTCOME: Record<string, string> = {
  not_authorized: 'Only an owner or ops admin writes the build configuration.',
  not_found: 'Project not found.',
  bad_config: 'That configuration is not valid.',
  unknown_key: 'That configuration has a setting this system does not know.',
  deploy_is_not_a_build: 'A build never deploys or publishes: that command is refused.',
  secret_in_config: 'That configuration carries what looks like a secret value. Name the variable, never its value.',
  unchanged: 'That is already the current configuration.',
};
export function configOutcomeMessage(outcome: string | undefined): string {
  return CONFIG_OUTCOME[outcome ?? ''] ?? 'The database refused the configuration.';
}

const PACKAGE_OUTCOME: Record<string, string> = {
  not_authorized: 'You do not have permission to package a build for the client.',
  not_found: 'Build not found.',
  limitations_required: 'Say what this build cannot do yet.',
  instructions_required: 'Say how the client should test it.',
  too_long: 'A field is too long.',
  secret_in_text: 'That text carries what looks like a secret. Remove it.',
  not_qa_passed: 'Not ready: QA has not passed this exact commit.',
  not_admin_approved: 'Not ready: the Admin has not approved this exact commit.',
  no_commit: 'Not ready: the build has no commit.',
  no_build_run: 'Not ready: there is no succeeded build run for this commit.',
  no_artifact: 'Not ready: the newest run has no artifact record.',
  artifact_not_newest: 'Not ready: the artifact is not the newest one for this build.',
  no_smoke: 'Not ready: the smoke verdict of this commit is not shareable (it must be passed, or honestly not tested).',
  stale_config: 'Not ready: the run used an older build configuration than the current one. Build again.',
  wrong_kind: 'Only a development build has a client package.',
};
export function packageOutcomeMessage(outcome: string | undefined): string {
  return PACKAGE_OUTCOME[outcome ?? ''] ?? 'The database refused the package.';
}

const CANCEL_OUTCOME: Record<string, string> = {
  not_authorized: 'Only an owner or ops admin cancels a build request.',
  not_found: 'Build request not found.',
  already_settled: 'That request was already settled.',
};
export function cancelOutcomeMessage(outcome: string | undefined): string {
  return CANCEL_OUTCOME[outcome ?? ''] ?? 'The database refused the cancellation.';
}

export const REPRODUCIBILITY_LABEL: Record<'reproduced' | 'differs' | 'single_run', string> = {
  reproduced: 'Reproduced: two or more runs of this commit and configuration gave the same artifact hash and fingerprint.',
  differs: 'Differs: runs of this commit and configuration did not agree. Do not call this build reproducible.',
  single_run: 'Single run: nothing to compare yet. One run proves nothing about reproducibility.',
};
export function readReproducibility(value: unknown): 'reproduced' | 'differs' | 'single_run' | null {
  return value === 'reproduced' || value === 'differs' || value === 'single_run' ? value : null;
}

/** What a client may be told of a build. A whitelist: a field the database adds later never reaches a client by accident. */
export type ClientBuildPackage = {
  title: string;
  version: number;
  label: string;
  platform: string | null;
  artifactType: string;
  distributable: boolean;
  artifactLimitation: string | null;
  limitations: string;
  testingInstructions: string;
  packagedAt: string;
};
export function toClientBuildPackage(row: Record<string, unknown> | null | undefined): ClientBuildPackage | null {
  if (!row || typeof row.title !== 'string' || typeof row.limitations !== 'string' || typeof row.testing_instructions !== 'string') return null;
  return {
    title: row.title,
    version: Number(row.version ?? 0),
    label: typeof row.label === 'string' && row.label ? row.label : 'Development build, not production',
    platform: typeof row.platform === 'string' ? row.platform : null,
    artifactType: String(row.artifact_type ?? 'other'),
    distributable: row.distributable === true,
    artifactLimitation: typeof row.artifact_limitation === 'string' ? row.artifact_limitation : null,
    limitations: row.limitations,
    testingInstructions: row.testing_instructions,
    packagedAt: String(row.packaged_at ?? ''),
  };
}
