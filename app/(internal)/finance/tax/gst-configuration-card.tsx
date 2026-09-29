import Link from 'next/link';

import type { GstIdentity } from '@/modules/finance/gstr';
import { describeStateCode } from '@/modules/finance/gstr';
import { SUGGESTED_SAC } from '@/modules/finance/gst-identity-schema';
import { Badge, Callout, Card, CardHeader, IconSettings } from '@/ui';

import { GstIdentityForm } from '../../settings/finance/gst-identity-form';

/**
 * GST configuration — SCR-056 puts it on the tax page as a section, with
 * "Configure tax profile" as a primary action. The profile is the agency's
 * own GST identity (`core.organizations.gstin / gst_state_code /
 * default_sac`, set by `core.set_gst_identity`, owner only, audited with old
 * and new). The form is the SAME `GstIdentityForm` Settings › Finance
 * mounts — one component, one door — so the two screens cannot disagree.
 *
 * What the profile does NOT carry is said, not invented: registration type
 * (regular / composition), tax-period basis and filing frequency have no
 * column and no door here; the return period is chosen per export above.
 */
export function GstConfigurationCard({
  identity,
  issues,
  mayConfigure,
  effectiveSince,
}: {
  identity: GstIdentity;
  /** From `gstIdentityIssues` — what the exports refuse on. */
  issues: readonly { reason: string }[];
  /** `hasRole(context, 'owner')` — the door's own rule. */
  mayConfigure: boolean;
  /** When the current identity was set, from the audit trail; null when never set from the panel. */
  effectiveSince: string | null;
}) {
  const configured = Boolean(identity.gstin);
  return (
    <Card id="gst-configuration">
      <CardHeader
        icon={<IconSettings size={16} />}
        title="GST configuration"
        description="The agency's own tax profile: the supplier on every GST invoice and the header of the GSTR-1 and GSTR-3B files exported here. Owner only; every change is audited with the old and new values."
        actions={
          !configured ? (
            <Badge tone="warning" dot>not configured</Badge>
          ) : issues.length > 0 ? (
            <Badge tone="warning" dot>incomplete</Badge>
          ) : (
            <Badge tone="success" dot>configured</Badge>
          )
        }
      />
      <div className="flex flex-col gap-3 px-4 py-3 sm:px-5">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[13px] sm:grid-cols-4">
          <dt className="text-muted">Legal name</dt>
          <dd className="font-medium">{identity.legalName || '—'}</dd>
          <dt className="text-muted">GSTIN</dt>
          <dd className="font-mono">{identity.gstin ?? <span className="text-warning">Not configured</span>}</dd>
          <dt className="text-muted">Registration state</dt>
          <dd>{identity.stateCode ? `${describeStateCode(identity.stateCode)} (${identity.stateCode})` : <span className="text-warning">Not configured</span>}</dd>
          <dt className="text-muted">Default SAC</dt>
          <dd className="font-mono">{identity.defaultSac ?? <span className="text-warning">Not configured</span>}</dd>
          <dt className="text-muted">Effective since</dt>
          <dd>{effectiveSince ?? <span className="text-muted">never set from the panel</span>}</dd>
          <dt className="text-muted">Registration type · period basis · filing frequency</dt>
          <dd className="text-muted sm:col-span-3">
            Not recorded — the profile carries no such fields, so nothing is inferred. The return period is chosen per export above.
          </dd>
        </dl>
        <p className="text-xs text-muted">
          The state code decides whether a line is split CGST+SGST (client in the same state) or IGST (any other state); it is the first two
          characters of the GSTIN and is taken from it when left blank. The default SAC ({SUGGESTED_SAC} is IT design and development services)
          classifies every line in the HSN summary until a per-line code exists. Nothing here verifies a registration with the GST portal; it
          records what the owner states.
        </p>
        {issues.length > 0 ? <Callout tone="warning">The GSTR exports refuse until this is complete: {issues.map((i) => i.reason).join(' ')}</Callout> : null}
        {mayConfigure ? (
          <GstIdentityForm gstin={identity.gstin} stateCode={identity.stateCode} defaultSac={identity.defaultSac} />
        ) : (
          <Callout tone="info">
            Only the owner configures the tax profile — the door refuses everyone else. It is also on{' '}
            <Link href="/settings/finance" className="font-medium text-brand hover:underline">Settings › Finance</Link>.
          </Callout>
        )}
      </div>
    </Card>
  );
}
