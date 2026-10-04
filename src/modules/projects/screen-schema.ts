import { z } from 'zod';

/**
 * SCR-032/034/035/038 — a person writes the screen inventory
 * (migration 20260929200000). Every door here is refused by the database
 * while the project's latest screen baseline is finalized; the schemas
 * only shape the input.
 */

export const SCREEN_KEY_PATTERN = /^[a-z][a-z0-9_.-]{1,62}$/;
const screenKey = z
  .string()
  .trim()
  .regex(SCREEN_KEY_PATTERN, 'A key is lowercase letters, digits, "_", "." or "-", 2–63 characters, starting with a letter.');

export const DESIGN_STATES = ['not_started', 'in_progress', 'drawn', 'reviewed'] as const;
export type DesignState = (typeof DESIGN_STATES)[number];

export const addScreenSchema = z.object({
  projectId: z.uuid(),
  screenKey,
  name: z.string().trim().min(1, 'Name the screen.').max(200),
  userRole: z.string().trim().min(1, 'Say which role uses it.').max(100),
  purpose: z.string().trim().max(2000).optional(),
  requiredSections: z.string().trim().max(4000).optional(),
  actions: z.string().trim().max(2000).optional(),
  requiredData: z.string().trim().max(2000).optional(),
  dependencies: z.string().trim().max(2000).optional(),
  entryPoint: z.string().trim().max(500).optional(),
  exitAction: z.string().trim().max(500).optional(),
  hasEmptyState: z.boolean().default(false),
  hasLoadingState: z.boolean().default(false),
  hasErrorState: z.boolean().default(false),
  hasSuccessState: z.boolean().default(false),
  scopeItemIds: z.array(z.uuid()).default([]),
});
export type AddScreenInput = z.infer<typeof addScreenSchema>;

export const mergeScreensSchema = z.object({
  projectId: z.uuid(),
  sourceIds: z.array(z.uuid()).min(2, 'Pick at least two screens to merge.'),
  screenKey,
  name: z.string().trim().min(1, 'Name the merged screen.').max(200),
  userRole: z.string().trim().max(100).optional(),
  purpose: z.string().trim().max(2000).optional(),
});
export type MergeScreensInput = z.infer<typeof mergeScreensSchema>;

export const splitPartSchema = z.object({
  screenKey,
  name: z.string().trim().min(1, 'Name every part.').max(200),
  userRole: z.string().trim().max(100).optional(),
  purpose: z.string().trim().max(2000).optional(),
});
export const splitScreenSchema = z.object({
  projectId: z.uuid(),
  sourceId: z.uuid(),
  parts: z.array(splitPartSchema).min(2, 'A split needs at least two parts.').max(20),
});
export type SplitScreenInput = z.infer<typeof splitScreenSchema>;

export const setScreenDesignStateSchema = z.object({
  projectId: z.uuid(),
  screenId: z.uuid(),
  designState: z.enum(DESIGN_STATES),
});
export type SetScreenDesignStateInput = z.infer<typeof setScreenDesignStateSchema>;

export const setScreenFigmaUrlSchema = z.object({
  projectId: z.uuid(),
  screenId: z.uuid(),
  /** Blank clears it. */
  figmaUrl: z
    .string()
    .trim()
    .max(2000)
    .refine((v) => v.length === 0 || v.startsWith('https://'), 'A Figma link starts with https://'),
});
export type SetScreenFigmaUrlInput = z.infer<typeof setScreenFigmaUrlSchema>;

export const screenScopeItemSchema = z.object({
  projectId: z.uuid(),
  screenId: z.uuid(),
  scopeItemId: z.uuid(),
});
export type ScreenScopeItemInput = z.infer<typeof screenScopeItemSchema>;

export const submitScreenForQaSchema = z.object({
  projectId: z.uuid(),
  screenId: z.uuid(),
});
export type SubmitScreenForQaInput = z.infer<typeof submitScreenForQaSchema>;

/** SCR-038 — exactly one target, the same rule the table's CHECK holds. */
export const linkDesignAssetSchema = z
  .object({
    projectId: z.uuid(),
    assetId: z.uuid(),
    screenId: z.uuid().optional(),
    uiVersionId: z.uuid().optional(),
  })
  .refine((v) => (v.screenId ? 1 : 0) + (v.uiVersionId ? 1 : 0) === 1, 'Pick one screen or one UI version.');
export type LinkDesignAssetInput = z.infer<typeof linkDesignAssetSchema>;

export const unlinkDesignAssetSchema = z.object({
  projectId: z.uuid(),
  linkId: z.uuid(),
});
export type UnlinkDesignAssetInput = z.infer<typeof unlinkDesignAssetSchema>;

/** Q-B7 / SCR-035 — draft the next screen baseline from a screen whose baseline is finalized. From v2 a reason is required (the door says so). */
export const draftNextScreenBaselineSchema = z.object({
  projectId: z.uuid(),
  // Required from v2 (the door says so); the FIRST baseline has nothing to reopen, so it may be blank.
  changeReason: z.string().trim().max(2000).default(''),
});
export type DraftNextScreenBaselineInput = z.input<typeof draftNextScreenBaselineSchema>;

/** Master §7.3 - the person who agrees the COMPLETE screen list closes the open baseline. */
export const finalizeScreenBaselineSchema = z.object({ projectId: z.uuid(), baselineId: z.uuid() });
export type FinalizeScreenBaselineInput = z.infer<typeof finalizeScreenBaselineSchema>;
