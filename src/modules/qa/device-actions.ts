'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { addDevice, setDeviceSupport } from './device-service';

const text = (formData: FormData, name: string) => String(formData.get(name) ?? '').trim();

function revalidateDevices() {
  revalidatePath('/qa');
  revalidatePath('/projects/[projectId]/qa', 'page');
}

/** SCR-044 — "Add Device": a device (optionally one browser of it) supported, or explicitly not, with the reason. */
export async function addDeviceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await addDevice({
    name: text(formData, 'name'),
    platform: text(formData, 'platform') as never,
    status: text(formData, 'status') === 'unsupported' ? 'unsupported' : 'supported',
    ...(text(formData, 'os') ? { os: text(formData, 'os') } : {}),
    ...(text(formData, 'browser') ? { browser: text(formData, 'browser') } : {}),
    ...(text(formData, 'reason') ? { reason: text(formData, 'reason') } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateDevices();
  return { status: 'success', message: 'Device recorded.' };
}

export async function setDeviceSupportAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setDeviceSupport({
    deviceId: text(formData, 'deviceId'),
    status: text(formData, 'status') === 'unsupported' ? 'unsupported' : 'supported',
    ...(text(formData, 'reason') ? { reason: text(formData, 'reason') } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateDevices();
  return { status: 'success', message: result.data.status === 'unsupported' ? 'Marked unsupported.' : 'Marked supported.' };
}
