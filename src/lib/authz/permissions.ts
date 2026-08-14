import type { Role } from '@/lib/auth/claims';

/**
 * Capability model — ARCHITECTURE.md §8.
 *
 * RLS answers "which rows may this principal see at all?". Capabilities answer
 * "may this principal perform this action?" — a question RLS cannot express
 * ("an ops_admin may approve invoices under ₹1L"). Both are required; they are
 * not redundant.
 *
 * Static and dependency-free on purpose: no database round trip on the hot
 * path, and the whole matrix is unit-testable.
 */

export const CAPABILITIES = [
  // CRM
  'lead.read',
  'lead.write',
  'lead.assign',
  'contact.read',
  'contact.write',
  // G-013, ADM-12. §5.3: "a list the Admin maintains" — so owner and
  // ops_admin, and the database says it again through core.is_admin().
  'portfolio.write',

  // Sales
  'proposal.draft',
  'proposal.approve',
  'proposal.send',

  // Delivery
  'project.read',
  'project.write',
  'milestone.write',
  'task.write',

  // Money
  'invoice.read',
  'invoice.create',
  'invoice.issue',
  'refund.issue',

  // AI
  'agent.run',
  'agent.configure',

  // Administration
  'member.invite',
  'audit.read',
  'organization.settings',

  // Operations
  //
  // G-099. Requeuing a dead job is a write, and `/operations` is gated on
  // `audit.read` — which resolves to the same two roles, so finance's rule
  // ("a new capability mapping to an identical role set adds vocabulary
  // without adding control") argues for reuse. It is not reused, because the
  // identical set belongs to a *read*: gating a write on `audit.read` would
  // say the right thing about who and the wrong thing about what, and the
  // capability list is the one place that distinction is written down.
  'job.requeue',

  // Delivery sign-off
  //
  // ADM-19 and docs/business-os/07-approval-rules.md put QA and production
  // readiness with the ops admin. `project.write` would have been the obvious
  // reuse and is wrong by one role: it includes delivery_lead, and a delivery
  // lead declaring their own work production ready is the review signing its
  // own homework.
  'project.sign_off',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** `*` means every capability. Only the owner holds it. */
const ROLE_CAPABILITIES: Record<Role, readonly (Capability | '*')[]> = {
  owner: ['*'],

  ops_admin: [
    'lead.read', 'lead.write', 'lead.assign',
    'contact.read', 'contact.write', 'portfolio.write',
    'proposal.draft', 'proposal.send',
    'project.read', 'project.write', 'milestone.write', 'task.write',
    'invoice.read', 'invoice.create', 'invoice.issue',
    'agent.run',
    'member.invite',
    'audit.read',
    'job.requeue',
    'project.sign_off',
  ],

  delivery_lead: [
    'lead.read',
    'contact.read',
    'project.read', 'project.write', 'milestone.write', 'task.write',
    'agent.run',
  ],

  member: [
    'lead.read',
    'contact.read',
    'project.read', 'task.write',
  ],

  // External collaborator: assigned projects only. Row-level scoping is
  // enforced by RLS; this list keeps the surface small.
  contractor: ['project.read', 'task.write'],

  client_admin: ['project.read', 'invoice.read'],
  client_member: ['project.read'],
};

export function can(role: Role | undefined, capability: Capability): boolean {
  if (!role) return false;
  const granted = ROLE_CAPABILITIES[role];
  return granted.includes('*') || granted.includes(capability);
}

/** True when the role holds every listed capability. */
export function canAll(role: Role | undefined, capabilities: readonly Capability[]): boolean {
  return capabilities.every((c) => can(role, c));
}

/** True when the role holds at least one of the listed capabilities. */
export function canAny(role: Role | undefined, capabilities: readonly Capability[]): boolean {
  return capabilities.some((c) => can(role, c));
}

export function capabilitiesFor(role: Role | undefined): readonly Capability[] {
  if (!role) return [];
  const granted = ROLE_CAPABILITIES[role];
  return granted.includes('*') ? CAPABILITIES : (granted as readonly Capability[]);
}
