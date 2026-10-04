import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { decrypt, encrypt } from '@/lib/ai/vault';
import { vaultConfigured } from '@/lib/secrets/vault';
import { hintOf } from '@/lib/secrets/registry';
import { err, ok, type Result } from '@/lib/result';

/**
 * The per-project vault for what a client sends in confidence (ADM-106).
 *
 * Same encryption as the integration vault (AES-256-GCM in code, keyed by
 * VAULT_ENCRYPTION_KEY); the four `projects.*_client_secret` doors re-check
 * the role (owner or ops_admin) and the tenancy in the database. Revealing is
 * the only read of a value and the door records `client_secret.viewed`
 * before it returns anything.
 */

export const CLIENT_SECRET_KINDS = ['login', 'api_key', 'hosting', 'domain', 'social', 'other'] as const;
export type ClientSecretKind = (typeof CLIENT_SECRET_KINDS)[number];

export const CLIENT_SECRET_KIND_LABELS: Record<ClientSecretKind, string> = {
  login: 'Login',
  api_key: 'API key',
  hosting: 'Hosting access',
  domain: 'Domain / DNS',
  social: 'Social account',
  other: 'Other',
};

const NOT_ALLOWED = 'Only the owner or an ops admin may store or view client secrets.';

export type ClientSecretRow = {
  id: string;
  label: string;
  kind: string;
  hint: string | null;
  storedByName: string | null;
  createdAt: string;
  revokedAt: string | null;
  revokedByName: string | null;
};

type ListRow = {
  id: string;
  label: string;
  kind: string;
  hint: string | null;
  stored_by_name: string | null;
  created_at: string;
  revoked_at: string | null;
  revoked_by_name: string | null;
};

export async function listClientSecrets(projectId: string): Promise<Result<ClientSecretRow[]>> {
  const context = await requireInternal();
  if (!can(context, 'audit.read')) return ok([]);
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('client_secret_list', { p_project_id: projectId });
  if (error) return err('INTERNAL', `Could not read the project's secrets: ${error.message}`);
  const rows: ClientSecretRow[] = ((data ?? []) as ListRow[]).map((r) => ({
    id: r.id,
    label: r.label,
    kind: r.kind,
    hint: r.hint,
    storedByName: r.stored_by_name,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    revokedByName: r.revoked_by_name,
  }));
  return ok(rows);
}

export async function storeClientSecret(input: { projectId: string; label: string; kind: string; value: string }): Promise<Result<{ id: string }>> {
  const context = await requireInternal();
  if (!can(context, 'audit.read')) return err('FORBIDDEN', NOT_ALLOWED);
  if (!vaultConfigured()) return err('VALIDATION', 'VAULT_ENCRYPTION_KEY is not set on this deployment, so nothing can be encrypted.');
  const label = input.label.trim();
  const value = input.value.trim();
  if (!label) return err('VALIDATION', 'Say what this is — for example “Hosting login”.');
  if (!value) return err('VALIDATION', 'Paste the secret the client sent.');
  const kind = (CLIENT_SECRET_KINDS as readonly string[]).includes(input.kind) ? input.kind : 'other';

  const { ciphertext, iv, authTag } = encrypt(value);
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('store_client_secret', {
    p_project_id: input.projectId,
    p_label: label,
    p_kind: kind,
    p_ciphertext: ciphertext,
    p_iv: iv,
    p_auth_tag: authTag,
    p_hint: hintOf(value) ?? undefined,
  });
  if (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'storeClientSecret',
        detail: error.message,
      }),
    );
    return err('INTERNAL', 'Could not store the secret.');
  }
  const row = Array.isArray(data) ? data[0] : data;
  switch (row?.outcome) {
    case 'stored':
      return ok({ id: row.secret_id as string });
    case 'project_not_found':
      return err('NOT_FOUND', 'That project was not found.');
    case 'invalid_label':
      return err('VALIDATION', 'The label must be 1–120 characters.');
    case 'invalid_value':
      return err('VALIDATION', 'The secret was not accepted.');
    default:
      return err('FORBIDDEN', NOT_ALLOWED);
  }
}

/** Decrypts one secret for one on-screen view. The door audits first; the value is returned once and never cached. */
export async function revealClientSecret(secretId: string): Promise<Result<{ label: string; value: string }>> {
  const context = await requireInternal();
  if (!can(context, 'audit.read')) return err('FORBIDDEN', NOT_ALLOWED);
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('reveal_client_secret', { p_secret_id: secretId });
  if (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'revealClientSecret',
        detail: error.message,
      }),
    );
    return err('INTERNAL', 'Could not open the secret.');
  }
  const row = Array.isArray(data) ? data[0] : data;
  switch (row?.outcome) {
    case 'revealed':
      break;
    case 'revoked':
      return err('NOT_FOUND', 'That secret was revoked; its value is gone.');
    case 'not_found':
      return err('NOT_FOUND', 'That secret was not found.');
    default:
      return err('FORBIDDEN', NOT_ALLOWED);
  }
  try {
    return ok({
      label: row.label ?? '',
      value: decrypt(row.ciphertext as string, row.iv as string, row.auth_tag as string),
    });
  } catch {
    // The view is already audited; a key that no longer opens it is reported, never thrown mid-request.
    return err('INTERNAL', 'The secret could not be decrypted — VAULT_ENCRYPTION_KEY has changed since it was stored.');
  }
}

export async function revokeClientSecret(secretId: string): Promise<Result<void>> {
  const context = await requireInternal();
  if (!can(context, 'audit.read')) return err('FORBIDDEN', NOT_ALLOWED);
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('revoke_client_secret', { p_secret_id: secretId });
  if (error) return err('INTERNAL', 'Could not revoke the secret.');
  const row = Array.isArray(data) ? data[0] : data;
  switch (row?.outcome) {
    case 'revoked':
      return ok(undefined);
    case 'already_revoked':
      return err('VALIDATION', 'That secret was already revoked.');
    case 'not_found':
      return err('NOT_FOUND', 'That secret was not found.');
    default:
      return err('FORBIDDEN', NOT_ALLOWED);
  }
}
