import { z } from 'zod';

import { PLATFORMS, type DeviceTile, type Platform } from './device-tiles';

/**
 * Registered devices and configurations — SCR-044 "Add Device" and SCR-048's
 * "unsupported devices/configurations must be explicitly recorded".
 *
 * A configuration is a device, optionally narrowed to one browser. It is
 * `supported` (the agency tests on it) or `unsupported` (it does not, and the
 * reason is written down). Pure helpers here so the page, the matrix and the
 * tiles agree on what "unsupported" means.
 */

export type DeviceConfiguration = {
  id: string;
  name: string;
  platform: Platform;
  os: string | null;
  browser: string | null;
  status: 'supported' | 'unsupported';
  reason: string | null;
  createdAt: string;
};

export const addDeviceSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the device.').max(120),
    platform: z.enum(PLATFORMS),
    os: z.string().trim().max(120).optional(),
    browser: z.string().trim().max(120).optional(),
    status: z.enum(['supported', 'unsupported']).default('supported'),
    reason: z.string().trim().max(600).optional(),
  })
  .refine((v) => v.status === 'supported' || (v.reason && v.reason.length > 0), {
    message: 'An unsupported configuration must say why.',
    path: ['reason'],
  });
export type AddDeviceInput = z.input<typeof addDeviceSchema>;

export const setDeviceSupportSchema = z
  .object({
    deviceId: z.uuid(),
    status: z.enum(['supported', 'unsupported']),
    reason: z.string().trim().max(600).optional(),
  })
  .refine((v) => v.status === 'supported' || (v.reason && v.reason.length > 0), {
    message: 'An unsupported configuration must say why.',
    path: ['reason'],
  });
export type SetDeviceSupportInput = z.input<typeof setDeviceSupportSchema>;

const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

/** The unsupported record for one matrix cell (device x browser), or null. A record with no browser covers the device in every browser. */
export function unsupportedFor(configs: readonly DeviceConfiguration[], device: string, browser: string): DeviceConfiguration | null {
  return (
    configs.find((c) => c.status === 'unsupported' && norm(c.name) === norm(device) && (c.browser === null || norm(c.browser) === norm(browser))) ?? null
  );
}

/**
 * The tiles the Device Testing card draws: one per device a run recorded, plus
 * one for every registered device no run has touched (`untested`, or
 * `unsupported` with its reason). A device a run recorded AND the agency
 * marked unsupported is shown as unsupported — the record wins over the
 * history, because a run on a refused device does not make it supported.
 */
export function mergeDeviceCards(tiles: readonly DeviceTile[], configs: readonly DeviceConfiguration[]): DeviceTile[] {
  const cards: DeviceTile[] = [];
  const used = new Set<string>();
  for (const t of tiles) {
    const config = configs.find((c) => norm(c.name) === norm(t.name) && c.browser === null) ?? configs.find((c) => norm(c.name) === norm(t.name));
    if (config) used.add(config.id);
    const refused = config?.status === 'unsupported';
    cards.push({ ...t, state: refused ? 'unsupported' : t.state, reason: refused ? config.reason : null, configId: config?.id ?? null });
  }
  for (const c of configs) {
    if (used.has(c.id)) continue;
    // A browser-specific refusal of a device that has tiles is a matrix fact, not a card of its own.
    if (c.browser && tiles.some((t) => norm(t.name) === norm(c.name))) continue;
    cards.push({
      key: `config:${c.id}`,
      name: c.browser ? `${c.name} · ${c.browser}` : c.name,
      os: c.os,
      platform: c.platform,
      runs: 0,
      state: c.status === 'unsupported' ? 'unsupported' : 'untested',
      lastAt: c.createdAt,
      thumbnailUrl: null,
      evidenceUrl: null,
      reason: c.status === 'unsupported' ? c.reason : null,
      configId: c.id,
    });
  }
  return cards;
}
