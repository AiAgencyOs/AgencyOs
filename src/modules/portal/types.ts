import type { Database } from '@/lib/db/types';

type ProjectRow = Database['projects']['Tables']['projects']['Row'];
type ModuleRow = Database['projects']['Tables']['modules']['Row'];
type DeliverableRow = Database['projects']['Tables']['deliverables']['Row'];
type HandoverRow = Database['projects']['Tables']['handovers']['Row'];
type InvoiceRow = Database['finance']['Tables']['invoices']['Row'];

export type ClientProject = Pick<ProjectRow, 'id' | 'name' | 'status' | 'created_at'>;

export type ClientModule = Pick<ModuleRow, 'id' | 'name' | 'status' | 'position'>;

/**
 * A version the client has been shown.
 *
 * `test_access_method` is carried through because it is how they get into a
 * build to try it — and because the column is incapable of holding the
 * credentials themselves, showing it here leaks nothing.
 */
export type ClientDeliverable = Pick<
  DeliverableRow,
  | 'id'
  | 'kind'
  | 'version'
  | 'title'
  | 'artifact_url'
  | 'changelog'
  | 'known_issues'
  | 'test_access_method'
  | 'status'
  | 'created_at'
>;

export type ClientHandover = Pick<HandoverRow, 'id' | 'status' | 'summary' | 'delivered_at' | 'accepted_at'>;

export type ClientProjectDetail = ClientProject & {
  modules: ClientModule[];
  deliverables: ClientDeliverable[];
  handover: ClientHandover | null;
};

export type ClientInvoice = Pick<
  InvoiceRow,
  'id' | 'number' | 'status' | 'currency' | 'total_minor' | 'paid_minor' | 'due_at' | 'issued_at' | 'project_id'
>;

/**
 * A prototype build, as its client sees it. Deliberately fewer columns than
 * the internal read (`getPrototypeArtifactByUiVersion`,
 * src/modules/projects/queries.ts): no `qaFindings`/`qaReviewedAt` — QA
 * review detail (missing screens, broken routes, secret-scan findings) is
 * internal working detail, not something to show a client, the same
 * restraint `readClientProject` already applies by never surfacing an
 * approval action.
 */
/**
 * The same shape as `PrototypeArtifactScreen`
 * (src/modules/projects/queries.ts) — duplicated rather than imported,
 * because module boundaries (ARCHITECTURE.md §3.2) route cross-module type
 * access through service.ts, and this is exactly the loose element
 * vocabulary `prototypeBuildSchema` already fixes: heading/text/button/
 * link/input/image_placeholder/list, never markup.
 */
type ClientPrototypeElement = {
  type: 'heading' | 'text' | 'button' | 'link' | 'input' | 'image_placeholder' | 'list';
  label: string;
  navigatesTo?: string;
};

export type ClientPrototypeArtifact = {
  id: string;
  projectId: string;
  uiVersionId: string;
  screens: Array<{ screenKey: string; elements: ClientPrototypeElement[] }>;
};
