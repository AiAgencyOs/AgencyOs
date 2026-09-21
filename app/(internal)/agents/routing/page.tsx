import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { listRoutingPolicies } from '@/lib/admin/model-routing';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { PageHeader } from '@/ui';

import { RoutingPolicyForm } from './routing-form';

export const metadata: Metadata = { title: 'Model routing' };

/**
 * Model Routing — SCR-064, ai.routing_policies (ADM-84). Per category, not
 * per agent. `routing_policies_write` already admits owner/ops_admin
 * directly under RLS (core.is_admin()) — the only gap here was the screen;
 * unlike the qa/scope doors, no write path was missing.
 *
 * `ai.models` ships empty by design (ADM-84 deferred the second provider),
 * so preferred models are free text rather than a picker against a registry
 * with nothing in it.
 */
export default async function ModelRoutingPage() {
  const context = await requireInternal('/agents/routing');
  if (!can(context.role, 'organization.settings')) redirect('/agents');

  const policies = await listRoutingPolicies();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Model routing"
        description="What each category of agent optimises for, and which model it prefers. An admin override wins outright over the resolver's own preference."
      />

      <div className="flex flex-col gap-3">
        {policies.map((p) => (
          <RoutingPolicyForm key={p.category} policy={p} />
        ))}
      </div>
    </div>
  );
}
