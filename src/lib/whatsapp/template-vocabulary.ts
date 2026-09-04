/**
 * The variables an approved template may declare — G-215.
 *
 * ── why this is data in `lib/` and not logic in `crm/` ────────────────────
 *
 * Three places need the same list and none of them may import the others:
 * the Admin panel (a client component, which cannot load server code), the
 * settings service, and the resolver that fills them. ARCHITECTURE.md §3.2
 * forbids `lib/` depending on `modules/`, so the shared half — the names and
 * what a person calls them — lives here, and the filling lives beside the
 * rows it reads.
 *
 * The database holds the same list as a CHECK constraint. That is the real
 * control; this is what lets a person be told which names exist instead of
 * reading a Postgres error.
 */

export const TEMPLATE_PARAMETERS = [
  'contact_first_name',
  'contact_full_name',
  'agency_name',
  'quotation_reference',
  'quotation_version',
] as const;

export type TemplateParameter = (typeof TEMPLATE_PARAMETERS)[number];

/** What a person reads in the Admin panel beside each name. */
export const TEMPLATE_PARAMETER_LABELS: Readonly<Record<TemplateParameter, string>> = {
  contact_first_name: 'Their first name',
  contact_full_name: 'Their full name',
  agency_name: 'Your agency’s name',
  quotation_reference: 'The quotation’s reference',
  quotation_version: 'The quotation’s version',
};

/**
 * What META says about a template, which is not what the Admin wants — G-215.
 *
 * `status` is Meta's word (it pauses a template for quality without anybody
 * here acting) and `active` is the Admin's own switch. A send needs both.
 * Here for the same reason the parameter names are: the Admin panel is a
 * client component and cannot load the service that writes it.
 */
export const TEMPLATE_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'paused',
  'disabled',
  'archived',
] as const;

export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];
