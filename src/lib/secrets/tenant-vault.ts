import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encryption for a credential that belongs to ONE organisation's integration (20261016100000).
 *
 * The same primitive as the deployment vault (AES-256-GCM, keyed from VAULT_ENCRYPTION_KEY, which lives only in the
 * hosting environment) with two differences that matter once credentials are per-tenant:
 *
 *   1. AUTHENTICATED DATA. The organisation, the integration and the secret's name are bound into the tag. A
 *      ciphertext lifted out of one tenant's row and pasted into another's - or into a different slot of the same
 *      integration - fails to decrypt instead of quietly handing tenant A's token to tenant B's connector.
 *   2. KEY SEPARATION. The key is derived with a domain label, so a bug in one vault cannot decrypt the other's rows.
 *
 * Pure: the key is a parameter, so it is testable without an environment. Callers read it from serverEnv().
 */

export type BoundContext = { organizationId: string; integrationId: string; name: string };
export type Sealed = { ciphertext: string; iv: string; authTag: string };

const aad = (c: BoundContext) => Buffer.from(`connector-credential|${c.organizationId}|${c.integrationId}|${c.name}`, 'utf8');

function key(secret: string): Buffer {
  if (!secret) throw new Error('VAULT_ENCRYPTION_KEY is not set - the tenant vault cannot encrypt or decrypt anything.');
  return createHash('sha256').update(`tenant-vault:v1:${secret}`).digest();
}

export function sealForTenant(plaintext: string, context: BoundContext, secret: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
}

/** Throws when the context is not the one sealed under - which is the point. Never log the thrown error with the value. */
export function openForTenant(sealed: Sealed, context: BoundContext, secret: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(aad(context));
  decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

/** The last four characters, for "which key is this" - never enough to use it. Short values reveal nothing. */
export function hintOfSecret(value: string): string | null {
  return value.length >= 12 ? value.slice(-4) : null;
}
