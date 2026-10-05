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
  // Owner decision 2026-10-04: confirming that money arrived is the owner's alone. The ops admin issues
  // invoices and records and checks claims, but the act that opens the finance gate - and so the project -
  // is a second pair of hands (separation of duties). Not in any role's list below: only the owner's '*'.
  'payment.verify',

  // AI
  'agent.run',
  'agent.configure',
  // The AI Provider Manager. Reading what is configured and managing providers, models and keys are the owner's and the ops admin's
  // (the database re-checks through core.is_admin); REMOVING a key or archiving a provider is the owner's alone (core.is_owner), and
  // the routing mode and the per-agent assignments are a separate capability held by the owner only.
  'ai.provider.read',
  'ai.provider.manage',
  'ai.credential.manage',
  'ai.routing.manage',

  // Administration
  'member.invite',
  'audit.read',
  // Owner decision 11 (round 2): the audit log may be exported as CSV by the owner and the ops admin only,
  // and every export is itself an audit event (audit.log_audit_export). A capability of its own so the
  // finance role's read access (if it ever gains one) is never an export right.
  'audit.export',
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

  // Lead generation & acquisition (the five engines)
  //
  // Both resolve to owner + ops_admin today, and the database says it again
  // through core.is_admin() in every crm.* acquisition door. They are not
  // `lead.write` because that belongs to a day-to-day sales role: steering what
  // the agency targets, how much it may spend and when it pauses is an
  // administrative act. `acquisition.read` stays separate so a read-only
  // viewer can be granted the screens without the controls.
  'acquisition.read',
  'acquisition.manage',
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
    'ai.provider.read', 'ai.provider.manage', 'ai.credential.manage',
    'member.invite',
    'audit.read',
    'audit.export',
    'job.requeue',
    'project.sign_off',
    'acquisition.read', 'acquisition.manage',
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

  // G-314. Reads money, nothing else — no lead/contact/project capability,
  // matching core.is_internal() excluding this role at the RLS layer too.
  finance: ['invoice.read'],

  client_admin: ['project.read', 'invoice.read'],
  client_member: ['project.read'],
};

/**
 * Who a check is about — decision 2026-09-30 (F2): secondary roles are
 * honoured by every permission check.
 *
 * A check used to take one role. Now it takes the SUBJECT: either a bare role
 * (a static question — "may an ops_admin issue an invoice?", the permission
 * matrix, the nav table's tests) or a role-bearing context (a session —
 * `requireInternal()`'s `AuthContext`, whose `role` is the primary and whose
 * `roles` are the primary plus every secondary role an owner granted through
 * `core.membership_roles`). Given a context, `can` reads the union; given a
 * role, exactly what it always did. `context.role` stays the primary, so
 * routing decisions that key on the one role a session carries (`finance`
 * goes to /invoices) are unchanged; only *permission* checks see the union.
 *
 * The one-line rule `tests/a-role-union-is-honoured.test.ts` pins: no check
 * against a context's `.role` alone survives in src/ or app/, because a check
 * written against the primary is a check a granted role cannot reach.
 */
export type RoleBearer = {
  readonly role: Role | undefined;
  /** Every role the session holds — the primary first. Absent = the primary alone. */
  readonly roles?: readonly Role[];
};

export type RoleSubject = Role | RoleBearer | undefined;

/** Every role the subject holds: the primary plus its secondary roles, each once. */
export function rolesOf(subject: RoleSubject): readonly Role[] {
  if (!subject) return [];
  if (typeof subject === 'string') return [subject];
  const out: Role[] = [];
  if (subject.role) out.push(subject.role);
  for (const r of subject.roles ?? []) if (!out.includes(r)) out.push(r);
  return out;
}

/** True when the subject holds the named role — as primary, or as a granted secondary. */
export function hasRole(subject: RoleSubject, role: Role): boolean {
  return rolesOf(subject).includes(role);
}

function roleCan(role: Role, capability: Capability): boolean {
  const granted = ROLE_CAPABILITIES[role];
  return granted.includes('*') || granted.includes(capability);
}

export function can(subject: RoleSubject, capability: Capability): boolean {
  return rolesOf(subject).some((role) => roleCan(role, capability));
}

/** True when the subject holds every listed capability. */
export function canAll(subject: RoleSubject, capabilities: readonly Capability[]): boolean {
  return capabilities.every((c) => can(subject, c));
}

/** True when the subject holds at least one of the listed capabilities. */
export function canAny(subject: RoleSubject, capabilities: readonly Capability[]): boolean {
  return capabilities.some((c) => can(subject, c));
}

export function capabilitiesFor(subject: RoleSubject): readonly Capability[] {
  const roles = rolesOf(subject);
  if (roles.length === 0) return [];
  if (roles.length > 1) return CAPABILITIES.filter((c) => can(subject, c));
  const role = roles[0] as Role;
  const granted = ROLE_CAPABILITIES[role];
  return granted.includes('*') ? CAPABILITIES : (granted as readonly Capability[]);
}

/**
 * Multirole — a membership's PRIMARY role plus zero or more additional roles
 * (`core.membership_roles`, granted by an owner). Since decision 2026-09-30
 * (F2) the union is what every check reads: `requireInternal()` loads the
 * secondary roles into `context.roles`, and `can(context, …)` above consults
 * them. The two functions below are the same union spelled out for a caller
 * that holds a primary role and a list rather than a context — the roster
 * page, a test — and give the same answer `can(context, …)` would.
 *
 * In the database, `core.is_owner()`, `core.is_admin()` and `core.can_write()`
 * consult `core.holds_role()` (20261001150000), which reads the JWT's primary
 * role and then the membership's secondary roles; policies spelled as
 * `core.current_user_role() in (...)` still read the primary alone.
 */
export function effectiveCapabilitiesFor(
  primaryRole: Role | undefined,
  secondaryRoles: readonly Role[] = [],
): ReadonlySet<Capability> {
  if (!primaryRole) return new Set();
  const all = new Set<Capability>(capabilitiesFor(primaryRole));
  for (const role of secondaryRoles) {
    for (const capability of capabilitiesFor(role)) all.add(capability);
  }
  return all;
}

/** True when the union of the primary role and every secondary role holds the capability. */
export function canEffective(
  primaryRole: Role | undefined,
  secondaryRoles: readonly Role[],
  capability: Capability,
): boolean {
  if (can(primaryRole, capability)) return true;
  return secondaryRoles.some((role) => can(role, capability));
}
