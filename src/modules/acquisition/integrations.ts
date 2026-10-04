import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { createAdminClient } from '@/lib/db/admin';
import { createClient } from '@/lib/db/server';
import { serverEnv } from '@/lib/env';
import { err, ok, type Result } from '@/lib/result';
import { hintOfSecret, openForTenant, sealForTenant } from '@/lib/secrets/tenant-vault';

import { hasAdapter, ADAPTERS } from './adapters';
import { PROVIDER_CATALOG, PROVIDER_ENVIRONMENTS, PROVIDERS, type Provider } from './providers';

/**
 * Connections: register, store a credential, switch off, test. Credentials are encrypted HERE, in the application, with the
 * organisation, integration and name bound in, before they reach the database; a session can never read them back, and the
 * plaintext is only ever held in memory for the length of one adapter call. Nothing here logs a value.
 */

const first = <T>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;

async function manager() {
  const context = await requireInternal();
  if (!can(context, 'acquisition.manage')) return { ok: false as const, error: err('FORBIDDEN', 'You do not have permission to manage lead generation.') };
  if (!context.organizationId) return { ok: false as const, error: err('FORBIDDEN', 'Your account is not attached to an organisation.') };
  return { ok: true as const, context, organizationId: context.organizationId };
}

export async function registerIntegration(input: { provider: string; environment: string; label: string }): Promise<Result<{ id: string }>> {
  const gate = await manager();
  if (!gate.ok) return gate.error;
  if (!(PROVIDERS as readonly string[]).includes(input.provider)) return err('VALIDATION', 'That is not a provider this system knows.');
  if (!(PROVIDER_ENVIRONMENTS as readonly string[]).includes(input.environment)) return err('VALIDATION', 'Choose development, staging or production.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('register_integration', {
    p_provider: input.provider, p_environment: input.environment, p_label: input.label as never, p_adapter_implemented: false,
  });
  if (error) return err('INTERNAL', 'Could not register the connection.');
  const row = first<{ outcome?: string; integration_id?: string }>(data);
  switch (row?.outcome) {
    case 'registered': {
      // Whether an adapter exists is a fact about this CODE, so the engine records it (the door ignores what a caller claims).
      if (row.integration_id && hasAdapter(input.provider)) {
        await createAdminClient().schema('crm').rpc('sync_integration_adapter', { p_organization_id: gate.organizationId, p_integration: row.integration_id, p_implemented: true });
      }
      return ok({ id: row.integration_id ?? '' });
    }
    case 'duplicate':
      return err('CONFLICT', 'That connection already exists - use a different label for a second account.');
    case 'invalid':
      return err('VALIDATION', 'Check the provider, environment and label.');
    default:
      return err('FORBIDDEN', 'Only the owner or an ops admin may add a connection.');
  }
}

export async function storeConnectorSecret(input: { integrationId: string; name: string; value: string; expiresOn?: string }): Promise<Result<{ rotated: boolean }>> {
  const gate = await manager();
  if (!gate.ok) return gate.error;
  if (!hasRole(gate.context, 'owner')) return err('FORBIDDEN', 'Only the owner can store a provider credential.');
  const value = input.value.trim();
  if (value.length < 8 || value.length > 8000) return err('VALIDATION', 'That does not look like a credential (8 to 8,000 characters).');
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(input.name)) return err('VALIDATION', 'Unknown credential name.');
  const secret = serverEnv().VAULT_ENCRYPTION_KEY;
  if (!secret) return err('INTERNAL', 'The vault is not configured (VAULT_ENCRYPTION_KEY), so nothing can be stored securely.');

  const sealed = sealForTenant(value, { organizationId: gate.organizationId, integrationId: input.integrationId, name: input.name }, secret);
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('store_connector_secret', {
    p_integration: input.integrationId, p_name: input.name, p_ciphertext: sealed.ciphertext, p_iv: sealed.iv, p_auth_tag: sealed.authTag,
    p_hint: hintOfSecret(value) as never, p_expires_on: (input.expiresOn || null) as never,
  });
  if (error) return err('INTERNAL', 'Could not store the credential.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'stored':
      return ok({ rotated: false });
    case 'rotated':
      return ok({ rotated: true });
    case 'not_found':
      return err('NOT_FOUND', 'That connection does not exist.');
    case 'revoked':
      return err('CONFLICT', 'That connection was revoked and accepts no credential. Add a new connection.');
    case 'invalid':
      return err('VALIDATION', 'The credential could not be stored.');
    default:
      return err('FORBIDDEN', 'Only the owner can store a provider credential.');
  }
}

export async function setIntegrationState(input: { integrationId: string; to: 'DISABLED' | 'CONFIGURED' | 'REVOKED'; reason: string }): Promise<Result<true>> {
  const gate = await manager();
  if (!gate.ok) return gate.error;
  const reason = input.reason.trim();
  if (!reason) return err('VALIDATION', 'Say why - the reason is kept in the audit log.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('set_integration_state', { p_integration: input.integrationId, p_to: input.to, p_reason: reason });
  if (error) return err('INTERNAL', 'Could not change the connection.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'set':
      return ok(true);
    case 'unchanged':
      return err('CONFLICT', 'It is already in that state.');
    case 'revoked':
      return err('CONFLICT', 'A revoked connection cannot come back. Add a new one.');
    case 'not_owner':
      return err('FORBIDDEN', 'Only the owner can revoke a connection.');
    case 'not_found':
      return err('NOT_FOUND', 'That connection does not exist.');
    default:
      return err('FORBIDDEN', 'Only the owner or an ops admin may change a connection.');
  }
}

export type TestResult =
  | { kind: 'no_adapter'; message: string }
  | { kind: 'no_credential'; message: string }
  | { kind: 'passed'; accountRef: string }
  | { kind: 'failed'; errorClass: string; message: string };

/**
 * Test a connection against the real provider. With NO adapter it says so and records NOTHING: it cannot fake a pass, and
 * the registry's own door refuses a verified state for an unimplemented provider as a second line.
 */
export async function testConnection(integrationId: string): Promise<Result<TestResult>> {
  const gate = await manager();
  if (!gate.ok) return gate.error;
  const supabase = await createClient();
  const { data: integration, error } = await supabase.schema('crm').from('acquisition_integrations').select('id, provider, environment, adapter_implemented').eq('id', integrationId).maybeSingle();
  if (error) return err('INTERNAL', 'Could not read the connection.');
  if (!integration) return err('NOT_FOUND', 'That connection does not exist.');

  const adapter = ADAPTERS[integration.provider as Provider];
  const admin = createAdminClient();
  // Keep the registry's view of "an adapter exists" in step with the code, so a shipped adapter is picked up on its own.
  if (Boolean(adapter) !== integration.adapter_implemented) {
    await admin.schema('crm').rpc('sync_integration_adapter', { p_organization_id: gate.organizationId, p_integration: integration.id, p_implemented: Boolean(adapter) });
  }
  if (!adapter) {
    return ok({ kind: 'no_adapter', message: `AgencyOS has no adapter for ${PROVIDER_CATALOG[integration.provider as Provider]?.label ?? integration.provider} yet, so it cannot be tested or used. Nothing was recorded.` });
  }

  const secret = serverEnv().VAULT_ENCRYPTION_KEY;
  if (!secret) return err('INTERNAL', 'The vault is not configured, so credentials cannot be opened.');
  const { data: rows, error: credError } = await admin.schema('crm').from('connector_credentials')
    .select('name, ciphertext, iv, auth_tag').eq('integration_id', integration.id).eq('organization_id', gate.organizationId).eq('status', 'active');
  if (credError) return err('INTERNAL', 'Could not read the credentials.');
  if (!rows || rows.length === 0) return ok({ kind: 'no_credential', message: 'No credential is stored for this connection.' });

  const opened = new Map<string, string>();
  try {
    for (const r of rows) opened.set(r.name, openForTenant({ ciphertext: r.ciphertext, iv: r.iv, authTag: r.auth_tag }, { organizationId: gate.organizationId, integrationId: integration.id, name: r.name }, secret));
  } catch {
    // A credential that will not open (key rotated, or moved between rows) is a credential problem, never a crash with a value in it.
    await admin.schema('crm').rpc('record_integration_check', { p_organization_id: gate.organizationId, p_integration: integration.id, p_ok: false, p_account_ref: null as never, p_capabilities: null as never, p_error_class: 'conditional', p_error: 'A stored credential could not be opened - store it again.' });
    return ok({ kind: 'failed', errorClass: 'conditional', message: 'A stored credential could not be opened. Store it again.' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const result = await adapter.testConnection({ environment: integration.environment as 'production', credential: (n) => opened.get(n) ?? null, signal: controller.signal });
    await admin.schema('crm').rpc('record_integration_check', {
      p_organization_id: gate.organizationId, p_integration: integration.id, p_ok: result.ok,
      p_account_ref: (result.ok ? result.accountRef : null) as never, p_capabilities: (result.ok ? result.capabilities : null) as never,
      p_error_class: (result.ok ? null : result.errorClass) as never, p_error: (result.ok ? null : result.message) as never,
      ...(result.ok && result.apiVersion ? { p_api_version: result.apiVersion } : {}),
    });
    return ok(result.ok ? { kind: 'passed', accountRef: result.accountRef } : { kind: 'failed', errorClass: result.errorClass, message: result.message });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    await admin.schema('crm').rpc('record_integration_check', { p_organization_id: gate.organizationId, p_integration: integration.id, p_ok: false, p_account_ref: null as never, p_capabilities: null as never, p_error_class: 'transient', p_error: timedOut ? 'The provider did not answer in time.' : 'The check could not complete.' });
    return ok({ kind: 'failed', errorClass: 'transient', message: timedOut ? 'The provider did not answer in time.' : 'The check could not complete.' });
  } finally {
    clearTimeout(timer);
    opened.clear();
  }
}

export async function saveAcquisitionPolicy(input: { action: string; mode: string; approvalAboveMinor: number | null; escalateAboveMinor: number | null }): Promise<Result<true>> {
  const gate = await manager();
  if (!gate.ok) return gate.error;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('set_acquisition_policy', {
    p_action: input.action, p_mode: input.mode, p_approval_above_minor: input.approvalAboveMinor as never, p_escalate_above_minor: input.escalateAboveMinor as never,
  });
  if (error) return err('INTERNAL', 'Could not save the policy.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'saved':
      return ok(true);
    case 'never_auto':
      return err('VALIDATION', 'This action always needs a person to approve it. It cannot be made automatic.');
    case 'not_owner':
      return err('FORBIDDEN', 'Making an action more automatic is the owner\'s decision. An admin can only tighten it.');
    case 'invalid':
      return err('VALIDATION', 'Check the action, the mode and the thresholds.');
    default:
      return err('FORBIDDEN', 'Only the owner or an ops admin may change a policy.');
  }
}
