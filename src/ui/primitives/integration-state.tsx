import Link from 'next/link';

import { IconAlert, IconInfo } from '../icons';
import { Callout } from './empty-state';

/**
 * The shared rule's "integration unavailable / degraded state" — one callout
 * for a provider the page depends on that is not verified: not configured,
 * configured but unproven, degraded, failed, disabled, or unreadable. Used by
 * Integrations and Production readiness (bucket F, stream F-A) and by any
 * page that reads a provider, so the sentence a person reads when WhatsApp
 * is down is the same sentence everywhere.
 *
 * Nothing here decides a state: the page passes the lifecycle its evaluator
 * produced and the evidence it read. A `href` is where the person goes to
 * fix it.
 */
export type IntegrationLifecycle = 'NOT_CONFIGURED' | 'CONFIGURED' | 'VERIFIED' | 'DEGRADED' | 'FAILED' | 'DISABLED' | 'UNKNOWN';

const TONE: Record<IntegrationLifecycle, 'info' | 'warning' | 'danger' | 'success'> = {
  VERIFIED: 'success',
  CONFIGURED: 'warning',
  DEGRADED: 'warning',
  NOT_CONFIGURED: 'info',
  FAILED: 'danger',
  DISABLED: 'info',
  UNKNOWN: 'danger',
};

const WORD: Record<IntegrationLifecycle, string> = {
  VERIFIED: 'verified',
  CONFIGURED: 'configured but not verified',
  DEGRADED: 'degraded',
  NOT_CONFIGURED: 'not configured',
  FAILED: 'failing',
  DISABLED: 'disabled',
  UNKNOWN: 'unreadable',
};

export function IntegrationState({
  name,
  lifecycle,
  detail,
  href,
  actionLabel,
  className,
}: {
  name: string;
  lifecycle: IntegrationLifecycle;
  /** One line of real evidence — what was observed, never what was assumed. */
  detail: React.ReactNode;
  /** Where the person goes to configure, verify or repair it. */
  href?: string;
  actionLabel?: string;
  className?: string;
}) {
  const tone = TONE[lifecycle];
  return (
    <Callout
      tone={tone}
      icon={tone === 'danger' || tone === 'warning' ? <IconAlert size={16} /> : <IconInfo size={16} />}
      title={`${name} is ${WORD[lifecycle]}`}
      className={className}
    >
      <span>{detail}</span>
      {href ? (
        <>
          {' '}
          <Link href={href} className="font-medium underline underline-offset-2">
            {actionLabel ?? 'Open'}
          </Link>
        </>
      ) : null}
    </Callout>
  );
}
