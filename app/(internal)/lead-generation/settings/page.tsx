import type { Metadata } from 'next';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listPolicies, listRecentDecisions, listTargetServices, readCurrentIcp, readHandoffSettings } from '@/modules/acquisition/queries';
import { Callout, Card, CardBody, CardHeader, EmptyState, PageHeader, PermissionDenied } from '@/ui';

import { ACTION_TYPES } from '@/modules/acquisition/policy-vocabulary';
import { hasRole } from '@/lib/authz/permissions';

import { HandoffSettingsForm, IcpForm, PolicyForm, ServiceForm } from '../forms';

export const metadata: Metadata = { title: 'Lead generation settings' };

export default async function LeadGenerationSettingsPage() {
  const context = await requireInternal('/lead-generation/settings');
  if (!can(context, 'acquisition.read')) return <PermissionDenied />;
  const mayManage = can(context, 'acquisition.manage');
  const isOwner = hasRole(context, 'owner');
  const [services, { current, versions }, handoff, policies, decisions] = await Promise.all([listTargetServices(), readCurrentIcp(), readHandoffSettings(), listPolicies(), listRecentDecisions()]);
  const policyFor = (a: string) => policies.find((p) => p.actionType === a) ?? null;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Lead generation" title="Targets & ideal customer" description="What every engine aims at. Change it here and the engines follow; nothing is hard-coded." />

      <Card>
        <CardHeader title="Target services" description="The engines work on the active services, lowest priority number first. Website, App and General Development are only the starting defaults." />
        <CardBody>
          {services.length === 0 ? <EmptyState title="No target services" description="Set up lead generation from the Overview, or add one below." /> : null}
          <div className="flex flex-col gap-3">
            {services.map((s) => (mayManage ? <ServiceForm key={`${s.id}-${s.name}-${s.priority}-${s.active}`} service={s} /> : <p key={s.id} className="text-[13px]">{s.name} · priority {s.priority} · {s.active ? 'active' : 'off'}</p>))}
            {mayManage ? <div className="border-t border-line pt-3"><ServiceForm /></div> : null}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Ideal customer profile" description={current ? `Version ${current.version} of ${versions}. Saving creates the next version; earlier ones are kept so past decisions stay explainable.` : 'Not set yet.'} />
        <CardBody>
          {mayManage ? <IcpForm key={current?.version ?? 0} initial={current?.definition ?? {}} /> : <Callout tone="info" title="Read only">Only an owner or ops admin can change the profile.</Callout>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Moving a prospect to WhatsApp" description="A prospect on email, a profile or a marketplace can be sent a link that opens WhatsApp. Their first message continues the lead they already are - nothing is asked twice and no second lead is made." />
        <CardBody>
          {!handoff.businessNumber ? <Callout tone="warning" title="No WhatsApp number set">Handoff links cannot open WhatsApp until the business number is saved below.</Callout> : null}
          {mayManage ? <HandoffSettingsForm key={`${handoff.businessNumber}-${handoff.linkTtlDays}`} initial={{ businessNumber: handoff.businessNumber ?? '', linkTtlDays: handoff.linkTtlDays }} /> : <p className="text-[13px]">{handoff.businessNumber ?? 'Not set'} · links last {handoff.linkTtlDays} days</p>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="What may happen without asking" description="For each kind of action: ask a person first, let it happen on its own, or never. An action with no setting asks first. Making something more automatic is the owner's decision; an admin can only tighten. Publishing, submitting a proposal, launching a campaign, deploying a page and changing a profile always need a person." />
        <CardBody>
          <div className="flex flex-col">
            {ACTION_TYPES.map((a) => (mayManage ? <PolicyForm key={`${a}-${policyFor(a)?.updatedAt ?? 'new'}`} action={a} isOwner={isOwner} current={policyFor(a) ? { mode: policyFor(a)!.mode, approvalAbove: policyFor(a)!.approvalAboveMinor, escalateAbove: policyFor(a)!.escalateAboveMinor } : null} /> : <p key={a} className="border-b border-line py-2 text-[13px]">{a.replaceAll('_', ' ')}: {policyFor(a)?.mode ?? 'asks first'}</p>))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recent decisions" description="Every time an engine asked whether it may act, and what it was told." />
        <CardBody>
          {decisions.length === 0 ? <p className="text-[13px] text-muted">No engine has asked yet.</p> : (
            <ul className="flex flex-col gap-1 text-[13px]">
              {decisions.map((d, n) => <li key={n}>{new Date(d.createdAt).toLocaleString('en-IN')} - {d.actionType.replaceAll('_', ' ')}{d.channel ? ` (${d.channel})` : ''}: <strong>{d.decision.replaceAll('_', ' ').toLowerCase()}</strong> ({d.reason.replaceAll('_', ' ')})</li>)}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
