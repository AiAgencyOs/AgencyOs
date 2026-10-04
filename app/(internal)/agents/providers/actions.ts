'use server';

import { revalidatePath } from 'next/cache';

import {
  addKey,
  archiveProvider,
  deleteProvider,
  refreshModels,
  registerManualModel,
  removeKey,
  rotateKey,
  saveProvider,
  setKeyState,
  setModelEnabled,
  setProviderEnabled,
  testProvider,
  type ProviderInput,
} from '@/lib/ai/provider-admin';
import { clearAssignment, setAssignment, setRoutingMode } from '@/lib/ai/routing-admin';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

/**
 * The AI Provider Manager's server actions: form data in, a sentence out. Every rule lives in the services and, under them, in the
 * `ai.*` doors - an action only parses what was typed. A key arrives in a password field, is encrypted by the service and is never
 * part of a returned message; a failure is shown as the door wrote it.
 */

const text = (fd: FormData, name: string) => String(fd.get(name) ?? '').trim();
const list = (raw: string) => raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
const num = (fd: FormData, name: string, fallback: number) => {
  const raw = text(fd, name);
  const n = raw === '' ? fallback : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

function refresh(providerId?: string) {
  revalidatePath('/agents/providers');
  if (providerId) revalidatePath(`/agents/providers/${providerId}`);
  for (const p of ['/agents/routing', '/agents', '/security/keys', '/production-readiness']) revalidatePath(p);
}

const fail = (message: string): FormState => ({ status: 'error', message });
const done = (message: string): FormState => ({ status: 'success', message });

function parseHeaders(raw: string): { ok: true; headers: Record<string, string> } | { ok: false; message: string } {
  const headers: Record<string, string> = {};
  for (const line of raw.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const at = line.indexOf(':');
    if (at < 1) return { ok: false, message: `"${line}" is not a header - write one per line as Name: value.` };
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { ok: true, headers };
}

export async function saveProviderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const headers = parseHeaders(text(fd, 'extraHeaders'));
  if (!headers.ok) return fail(headers.message);
  const input: ProviderInput = {
    providerId: text(fd, 'providerId').toLowerCase(),
    kind: text(fd, 'kind') as ProviderInput['kind'],
    displayName: text(fd, 'displayName'),
    baseUrl: text(fd, 'baseUrl'),
    authScheme: text(fd, 'authScheme') === 'x-api-key' ? 'x-api-key' : 'bearer',
    matchPrefixes: list(text(fd, 'matchPrefixes')),
    matchContains: list(text(fd, 'matchContains')),
    extraHeaders: headers.headers,
    timeoutMs: num(fd, 'timeoutMs', 60000),
    retryMax: num(fd, 'retryMax', 1),
    modelsPath: text(fd, 'modelsPath') || '/models',
    apiVersion: text(fd, 'apiVersion'),
    priority: num(fd, 'priority', 100),
  };
  if (!['anthropic', 'openai_compat', 'anthropic_compat'].includes(input.kind)) return fail('Choose how the provider speaks: OpenAI-compatible or Anthropic-compatible.');
  const result = await saveProvider(await createClient(), input);
  if (!result.ok) return fail(result.error.message);
  refresh(input.providerId);
  return done(result.data.created ? `${input.displayName} added. Add a key, then refresh its models.` : `${input.displayName} saved.`);
}

export async function setProviderEnabledAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const providerId = text(fd, 'providerId');
  const result = await setProviderEnabled(await createClient(), providerId, text(fd, 'enabled') === 'true', text(fd, 'reason'));
  if (!result.ok) return fail(result.error.message);
  refresh(providerId);
  return done(text(fd, 'enabled') === 'true' ? 'Provider enabled.' : 'Provider disabled. Nothing is routed to it now.');
}

export async function archiveProviderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const providerId = text(fd, 'providerId');
  const result = await archiveProvider(await createClient(), providerId);
  if (!result.ok) return fail(result.error.message);
  refresh(providerId);
  return done('Provider archived. Its history is kept.');
}

export async function deleteProviderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const providerId = text(fd, 'providerId');
  if (text(fd, 'confirm') !== providerId) return fail(`Type ${providerId} to confirm the deletion.`);
  const result = await deleteProvider(await createClient(), providerId);
  if (!result.ok) return fail(result.error.message);
  refresh();
  return done('Provider deleted.');
}

export async function addKeyAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const providerId = text(fd, 'providerId');
  const result = await addKey(await createClient(), {
    providerId,
    label: text(fd, 'label'),
    environment: text(fd, 'environment') === 'test' ? 'test' : 'production',
    secret: String(fd.get('secret') ?? ''),
    priority: num(fd, 'priority', 100),
  });
  if (!result.ok) return fail(result.error.message);
  refresh(providerId);
  return done('Key stored - encrypted, never shown again. Test the connection to confirm it works.');
}

export async function rotateKeyAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const result = await rotateKey(await createClient(), text(fd, 'keyId'), String(fd.get('secret') ?? ''));
  if (!result.ok) return fail(result.error.message);
  refresh(text(fd, 'providerId'));
  return done('Key replaced - the new value is encrypted and the old one is gone.');
}

export async function setKeyStateAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const enabled = text(fd, 'enabled') === 'true';
  const priority = text(fd, 'priority');
  const result = await setKeyState(await createClient(), text(fd, 'keyId'), enabled, priority === '' ? undefined : Number(priority));
  if (!result.ok) return fail(result.error.message);
  refresh(text(fd, 'providerId'));
  return done(enabled ? 'Key enabled and any earlier stop cleared.' : 'Key disabled.');
}

export async function removeKeyAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const result = await removeKey(await createClient(), text(fd, 'keyId'));
  if (!result.ok) return fail(result.error.message);
  refresh(text(fd, 'providerId'));
  return done('Key removed.');
}

export async function testProviderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const providerId = text(fd, 'providerId');
  const result = await testProvider(providerId, text(fd, 'keyId') || null);
  if (!result.ok) return fail(result.error.message);
  refresh(providerId);
  const r = result.data;
  if (!r.ok) return fail(`${r.state.replace('_', ' ')}: ${r.detail}`);
  return done(`Connected in ${r.latencyMs} ms${r.noModelList ? ' - the provider does not list its models, register them by hand.' : ` - it lists ${r.modelCount} model${r.modelCount === 1 ? '' : 's'}.`}`);
}

export async function refreshModelsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const providerId = text(fd, 'providerId');
  const result = await refreshModels(await createClient(), providerId);
  if (!result.ok) return fail(result.error.message);
  refresh(providerId);
  const r = result.data;
  if (r.noModelList) return done('This provider does not list its models. Register them by hand below.');
  return done(`${r.added} new model${r.added === 1 ? '' : 's'} found (arrive disabled), ${r.refreshed} refreshed, ${r.gone} no longer listed.`);
}

export async function registerModelAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const providerId = text(fd, 'providerId');
  const tri = (name: string) => (text(fd, name) === 'yes' ? true : text(fd, name) === 'no' ? false : null);
  const context = text(fd, 'contextTokens');
  const result = await registerManualModel(await createClient(), {
    providerId,
    modelId: text(fd, 'modelId'),
    displayName: text(fd, 'displayName'),
    capabilities: fd.getAll('capabilities').map(String),
    contextTokens: context === '' ? null : Number(context),
    toolCalling: tri('toolCalling'),
    structuredOutput: tri('structuredOutput'),
  });
  if (!result.ok) return fail(result.error.message);
  refresh(providerId);
  return done('Model registered (disabled until you enable it).');
}

export async function setModelEnabledAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const enabled = text(fd, 'enabled') === 'true';
  const result = await setModelEnabled(await createClient(), text(fd, 'modelId'), enabled, text(fd, 'providerId') || undefined);
  if (!result.ok) return fail(result.error.message);
  refresh(text(fd, 'providerId'));
  return done(enabled ? 'Model enabled.' : 'Model disabled.');
}

export async function setRoutingModeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const mode = text(fd, 'mode') === 'manual' ? 'manual' : 'auto';
  const result = await setRoutingMode(await createClient(), mode, text(fd, 'reason'));
  if (!result.ok) return fail(result.error.message);
  refresh();
  if (!result.data.changed) return done(`Already in ${mode.toUpperCase()} mode.`);
  return done(mode === 'manual' ? 'MANUAL: every agent runs exactly on its assignment; nothing is substituted.' : 'AUTO: the orchestrator chooses among the providers and models you enabled. Manual assignments are kept.');
}

export async function setAssignmentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const target = (value: string) => {
    const [providerId, ...rest] = value.split('::');
    return { providerId: providerId ?? '', modelId: rest.join('::') };
  };
  const primary = target(text(fd, 'primary'));
  if (!primary.providerId || !primary.modelId) return fail('Choose a provider and model for this agent.');
  const fallbacks = ['fallback1', 'fallback2', 'fallback3'].map((n) => text(fd, n)).filter(Boolean).map(target);
  const result = await setAssignment(await createClient(), { agentKey: text(fd, 'agentKey'), ...primary, fallbacks, note: text(fd, 'note') });
  if (!result.ok) return fail(result.error.message);
  refresh();
  return done('Assignment saved.');
}

export async function clearAssignmentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const result = await clearAssignment(await createClient(), text(fd, 'agentKey'));
  if (!result.ok) return fail(result.error.message);
  refresh();
  return done('Assignment cleared.');
}
