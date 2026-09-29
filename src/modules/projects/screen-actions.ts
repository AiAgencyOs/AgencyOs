'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { DESIGN_STATES, type DesignState } from './screen-schema';
import {
  addScreen,
  linkDesignAsset,
  mapScreenToScopeItem,
  mergeScreens,
  setScreenDesignState,
  setScreenFigmaUrl,
  splitScreen,
  submitScreenForQa,
  unlinkDesignAsset,
  unmapScreenScopeItem,
} from './screen-service';

/** SCR-032/034/035/038 — the screen inventory's writes. */

function revalidateScreens(formData: FormData) {
  const projectId = String(formData.get('projectId') ?? '');
  revalidatePath(`/projects/${projectId}/design`);
  revalidatePath(`/projects/${projectId}/design/screens`);
  const screenId = String(formData.get('screenId') ?? '');
  if (screenId) revalidatePath(`/projects/${projectId}/design/screens/${screenId}`);
}

const str = (formData: FormData, key: string) => String(formData.get(key) ?? '');
const flag = (formData: FormData, key: string) => formData.get(key) === 'on' || formData.get(key) === 'true';
const uuids = (formData: FormData, key: string) => formData.getAll(key).map(String).filter((v) => v.length > 0);

export async function addScreenAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await addScreen({
    projectId: str(formData, 'projectId'),
    screenKey: str(formData, 'screenKey'),
    name: str(formData, 'name'),
    userRole: str(formData, 'userRole'),
    purpose: str(formData, 'purpose'),
    requiredSections: str(formData, 'requiredSections'),
    actions: str(formData, 'actions'),
    requiredData: str(formData, 'requiredData'),
    dependencies: str(formData, 'dependencies'),
    entryPoint: str(formData, 'entryPoint'),
    exitAction: str(formData, 'exitAction'),
    hasEmptyState: flag(formData, 'hasEmptyState'),
    hasLoadingState: flag(formData, 'hasLoadingState'),
    hasErrorState: flag(formData, 'hasErrorState'),
    hasSuccessState: flag(formData, 'hasSuccessState'),
    scopeItemIds: uuids(formData, 'scopeItemIds'),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateScreens(formData);
  return { status: 'success', message: 'Screen added.' };
}

export async function mergeScreensAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await mergeScreens({
    projectId: str(formData, 'projectId'),
    sourceIds: uuids(formData, 'sourceIds'),
    screenKey: str(formData, 'screenKey'),
    name: str(formData, 'name'),
    userRole: str(formData, 'userRole'),
    purpose: str(formData, 'purpose'),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateScreens(formData);
  return { status: 'success', message: 'Screens merged; the sources are now superseded.' };
}

/**
 * The parts come as lines of `key | name`, one part per line — a textarea
 * is the only control that can take N parts without a client-side list.
 */
export async function splitScreenAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parts = str(formData, 'parts')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [screenKey = '', name = ''] = line.split('|').map((s) => s.trim());
      return { screenKey, name: name.length > 0 ? name : screenKey.replace(/[_.-]+/g, ' ') };
    });
  const result = await splitScreen({
    projectId: str(formData, 'projectId'),
    sourceId: str(formData, 'sourceId'),
    parts,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateScreens(formData);
  return { status: 'success', message: `Split into ${result.data.screenIds.length} screens; the source is now superseded.` };
}

export async function setScreenDesignStateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const designState = str(formData, 'designState');
  if (!(DESIGN_STATES as readonly string[]).includes(designState)) {
    return { status: 'error', message: 'Not a design state this system recognises.' };
  }
  const result = await setScreenDesignState({
    projectId: str(formData, 'projectId'),
    screenId: str(formData, 'screenId'),
    designState: designState as DesignState,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateScreens(formData);
  return { status: 'success', message: result.data.changed ? 'Design state set.' : 'Already in that state.' };
}

export async function setScreenFigmaUrlAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setScreenFigmaUrl({
    projectId: str(formData, 'projectId'),
    screenId: str(formData, 'screenId'),
    figmaUrl: str(formData, 'figmaUrl'),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateScreens(formData);
  return { status: 'success', message: result.data.cleared ? 'Figma link cleared.' : 'Figma link attached.' };
}

export async function mapScreenScopeItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const input = { projectId: str(formData, 'projectId'), screenId: str(formData, 'screenId'), scopeItemId: str(formData, 'scopeItemId') };
  const remove = formData.get('remove') === 'true';
  const result = remove ? await unmapScreenScopeItem(input) : await mapScreenToScopeItem(input);
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateScreens(formData);
  return { status: 'success', message: remove ? 'Requirement unmapped.' : 'Requirement mapped.' };
}

export async function submitScreenForQaAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await submitScreenForQa({ projectId: str(formData, 'projectId'), screenId: str(formData, 'screenId') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateScreens(formData);
  const d = result.data;
  const head = d.alreadySubmitted ? 'Already submitted for QA.' : 'Submitted for QA.';
  const plan = d.planId === null
    ? 'No draft test plan exists for this project, so only the status changed.'
    : `${d.planned} UI test item${d.planned === 1 ? '' : 's'} added to the draft test plan${d.skipped > 0 ? `, ${d.skipped} already planned` : ''}.`;
  return { status: 'success', message: [head, plan, ...d.notes].join(' ') };
}

export async function linkDesignAssetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const target = str(formData, 'target'); // "screen:<id>" | "ui_version:<id>"
  const [kind, id] = target.split(':');
  const result = await linkDesignAsset({
    projectId: str(formData, 'projectId'),
    assetId: str(formData, 'assetId'),
    screenId: kind === 'screen' && id ? id : undefined,
    uiVersionId: kind === 'ui_version' && id ? id : undefined,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateScreens(formData);
  return { status: 'success', message: result.data.existed ? 'Already linked.' : 'Asset linked.' };
}

export async function unlinkDesignAssetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await unlinkDesignAsset({ projectId: str(formData, 'projectId'), linkId: str(formData, 'linkId') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateScreens(formData);
  return { status: 'success', message: result.data.removed ? 'Asset unlinked.' : 'Nothing to unlink.' };
}
