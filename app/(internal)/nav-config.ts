import { can, type Capability, type RoleSubject } from '@/lib/authz/permissions';

/**
 * The Admin Panel's information architecture, as one table.
 *
 * Mirrors §2 and §8 of the screen architecture (`admin panel ui single
 * truth/AgencyOS_Enterprise_Admin_Panel_Complete_Screen_Architecture.pdf`):
 * "Implement left navigation exactly as the organized modules — Command
 * Center; Sales & CRM; Clients; Projects; Requirements; Design & Prototype;
 * Development; QA & Release; Finance; Communication; AI Workforce;
 * Operations; Governance & Security; Integrations; Settings." The owner then
 * chose the reference screenshots' own list over the PDF's grouping (2026-10-03):
 * Communications; Approvals; Operations; Analytics & Costs; Integrations;
 * Security & Audit; Organization — each of the 71 screens keeps its one home. Every screen
 * of the 71-screen baseline lives under exactly one of these modules, so a
 * person never has to remember which unrelated page a control is buried in.
 *
 * Pure data plus two pure functions, kept out of the layout so a test can
 * assert the shape (every module has a home, every item names the capability
 * that guards its page) without rendering anything. The layout filters this
 * table by role; the sidebar, the phone drawer, the bottom tabs, the command
 * palette and the breadcrumb trail all read the SAME filtered result, so a
 * role can never reach a destination on one presentation it cannot on another.
 */

export type NavItem = {
  href: string;
  label: string;
  /** The capability whose page this is. Omitted = every internal role (Approvals). */
  capability?: Capability;
  /** The screen IDs from the 71-screen baseline this destination serves. */
  screens?: readonly string[];
};

export type NavModule = {
  /** Stable key — used for collapse state and tests, never shown. */
  key: string;
  /** `null` renders the items flat at the top of the rail (Command Center). */
  title: string | null;
  items: NavItem[];
};

export const NAV_MODULES: readonly NavModule[] = [
  {
    key: 'command-center',
    title: null,
    items: [
      { href: '/dashboard', label: 'Command Center', capability: 'project.read', screens: ['SCR-001'] },
      { href: '/notifications', label: 'Notifications', screens: ['SCR-003'] },
      { href: '/my-tasks', label: 'My tasks', screens: ['SCR-021'] },
    ],
  },
  {
    key: 'sales',
    title: 'Sales & CRM',
    items: [
      { href: '/leads', label: 'Leads', capability: 'lead.read', screens: ['SCR-006', 'SCR-007', 'SCR-008', 'SCR-009', 'SCR-012'] },
      { href: '/sales-funnel', label: 'Pipeline', capability: 'lead.read', screens: ['SCR-005'] },
      { href: '/quotations', label: 'Quotations', capability: 'lead.read', screens: ['SCR-011'] },
      { href: '/meetings', label: 'Meetings', capability: 'lead.read', screens: ['SCR-010'] },
      { href: '/follow-ups', label: 'Follow-ups', capability: 'lead.read', screens: ['SCR-013'] },
      { href: '/contracts', label: 'Contracts', capability: 'lead.read', screens: ['SCR-072'] },
    ],
  },
  {
    key: 'clients',
    title: 'Clients',
    items: [
      { href: '/clients', label: 'Clients', capability: 'project.read', screens: ['SCR-014', 'SCR-015', 'SCR-016', 'SCR-017'] },
      { href: '/portfolio', label: 'Portfolio', capability: 'portfolio.write' },
    ],
  },
  {
    key: 'projects',
    title: 'Projects',
    items: [
      { href: '/projects', label: 'All projects', capability: 'project.read', screens: ['SCR-018', 'SCR-019', 'SCR-020', 'SCR-022', 'SCR-023', 'SCR-024', 'SCR-025', 'SCR-027'] },
      { href: '/projects/escalations', label: 'Escalations', capability: 'project.read', screens: ['SCR-019'] },
    ],
  },
  {
    key: 'requirements',
    title: 'Requirements & Scope',
    items: [
      { href: '/requirements', label: 'Requirements', capability: 'lead.read', screens: ['SCR-028', 'SCR-029', 'SCR-030', 'SCR-031'] },
    ],
  },
  {
    key: 'design',
    title: 'Design & Prototype',
    items: [
      { href: '/design', label: 'Design dashboard', capability: 'project.read', screens: ['SCR-032', 'SCR-033', 'SCR-034', 'SCR-035', 'SCR-036', 'SCR-037', 'SCR-038'] },
    ],
  },
  {
    key: 'development',
    title: 'Development',
    items: [
      { href: '/development', label: 'Development dashboard', capability: 'project.read', screens: ['SCR-039', 'SCR-040', 'SCR-041', 'SCR-042', 'SCR-043'] },
    ],
  },
  {
    key: 'qa',
    title: 'QA & Release',
    items: [
      { href: '/qa', label: 'QA dashboard', capability: 'project.read', screens: ['SCR-044', 'SCR-045', 'SCR-046', 'SCR-047', 'SCR-048'] },
      { href: '/production-readiness', label: 'Production readiness', capability: 'organization.settings', screens: ['SCR-049', 'SCR-067'] },
    ],
  },
  {
    key: 'finance',
    title: 'Finance',
    items: [
      { href: '/finance', label: 'Finance overview', capability: 'invoice.read', screens: ['SCR-050'] },
      { href: '/invoices', label: 'Invoices', capability: 'invoice.read', screens: ['SCR-051', 'SCR-052'] },
      { href: '/invoices/verify', label: 'Payment verification', capability: 'invoice.issue', screens: ['SCR-054'] },
      { href: '/finance/payments', label: 'Payments', capability: 'invoice.read', screens: ['SCR-053'] },
      { href: '/finance/expenses', label: 'Expenses', capability: 'invoice.read', screens: ['SCR-055'] },
      { href: '/finance/tax', label: 'GST & tax', capability: 'invoice.read', screens: ['SCR-056'] },
    ],
  },
  {
    key: 'communication',
    title: 'Communications',
    items: [
      { href: '/communication', label: 'Conversations', capability: 'lead.read', screens: ['SCR-057', 'SCR-058'] },
      { href: '/settings/communication', label: 'Templates', capability: 'organization.settings', screens: ['SCR-059'] },
      // Owner decision 2026-09-30: broadcast reopened as a governed campaign.
      { href: '/communication/campaigns', label: 'Campaigns', capability: 'lead.write', screens: ['SCR-059'] },
      { href: '/communication/email-outreach', label: 'Email outreach', capability: 'lead.write', screens: [] },
    ],
  },
  {
    key: 'ai',
    title: 'AI Workforce',
    items: [
      { href: '/agents', label: 'Agents', capability: 'audit.read', screens: ['SCR-061', 'SCR-062', 'SCR-063'] },
      { href: '/agents/providers', label: 'AI providers', capability: 'audit.read', screens: [] },
      { href: '/agents/routing', label: 'Model routing', capability: 'audit.read', screens: ['SCR-064'] },
      { href: '/agents/automations', label: 'Automations', capability: 'audit.read', screens: ['SCR-065'] },
    ],
  },
  {
    key: 'approvals',
    title: 'Approvals',
    items: [
      { href: '/approvals', label: 'Approvals', screens: ['SCR-068'] },
      { href: '/governance/overrides', label: 'Overrides & controls', capability: 'audit.read', screens: ['SCR-068'] },
    ],
  },
  {
    key: 'operations',
    title: 'Operations',
    items: [
      { href: '/operations', label: 'Jobs & system health', capability: 'audit.read', screens: ['SCR-060', 'SCR-066', 'SCR-067'] },
    ],
  },
  {
    key: 'analytics',
    title: 'Analytics & Costs',
    items: [
      { href: '/reports', label: 'Reports', capability: 'project.read', screens: ['SCR-026'] },
      { href: '/usage', label: 'Usage & costs', capability: 'audit.read', screens: ['SCR-065'] },
    ],
  },
  {
    key: 'integrations',
    title: 'Integrations',
    items: [
      { href: '/integrations', label: 'Integrations', capability: 'organization.settings', screens: ['SCR-070'] },
      { href: '/import', label: 'Import', capability: 'organization.settings', screens: ['SCR-070'] },
    ],
  },
  {
    key: 'security',
    title: 'Security & Audit',
    items: [
      { href: '/security', label: 'Security', capability: 'audit.read', screens: ['SCR-069'] },
      { href: '/security/users', label: 'Users & roles', capability: 'audit.read', screens: ['SCR-069'] },
      { href: '/security/incidents', label: 'Incidents', capability: 'audit.read', screens: ['SCR-069'] },
      { href: '/security/keys', label: 'Keys & secrets', capability: 'audit.read', screens: ['SCR-071'] },
      { href: '/audit', label: 'Audit log', capability: 'audit.read', screens: ['SCR-069'] },
    ],
  },
  {
    key: 'organization',
    title: 'Organization',
    items: [{ href: '/settings', label: 'Organization settings', capability: 'organization.settings', screens: ['SCR-071'] }],
  },
];

/** The serialisable shape handed from the layout to the client components. */
export type VisibleItem = { href: string; label: string };
export type VisibleModule = { key: string; title: string | null; items: VisibleItem[] };

/**
 * The modules a role may see, with every item it may not open removed and
 * every module that ends up empty dropped. The capability check is the same
 * `can()` every page re-runs for itself — this only decides what to draw.
 */
export function visibleModulesFor(subject: RoleSubject): VisibleModule[] {
  return NAV_MODULES.map((m) => ({
    key: m.key,
    title: m.title,
    items: m.items
      .filter((i) => i.capability === undefined || can(subject, i.capability))
      .map(({ href, label }) => ({ href, label })),
  })).filter((m) => m.items.length > 0);
}

/**
 * Which item is current for a pathname: the item with the LONGEST href that
 * is the pathname or one of its ancestors at a segment boundary. So `/finance`
 * and `/finance/payments` can both be in the rail, and `/finance/payments/x`
 * lights only the second — the naive `startsWith` test lit both.
 */
export function currentItem(
  pathname: string,
  modules: readonly VisibleModule[],
): { module: VisibleModule; item: VisibleItem } | null {
  let best: { module: VisibleModule; item: VisibleItem } | null = null;
  for (const module of modules) {
    for (const item of module.items) {
      const matches = pathname === item.href || pathname.startsWith(item.href + '/');
      if (matches && (best === null || item.href.length > best.item.href.length)) {
        best = { module, item };
      }
    }
  }
  return best;
}

/**
 * The breadcrumb trail for a pathname: module › item › (a deeper record, if
 * the path continues below the item). The record's own name is the page's
 * job — the trail only says which room of the building it is in.
 */
export function trailFor(pathname: string, modules: readonly VisibleModule[]): VisibleItem[] {
  const hit = currentItem(pathname, modules);
  if (!hit) return [];
  const trail: VisibleItem[] = [];
  const first = hit.module.items[0];
  // A module whose title is its first item's label ("Clients › Clients")
  // would print itself twice; one crumb says it.
  if (hit.module.title && first && hit.module.title !== hit.item.label) {
    trail.push({ href: first.href, label: hit.module.title });
  }
  trail.push(hit.item);
  return trail;
}
