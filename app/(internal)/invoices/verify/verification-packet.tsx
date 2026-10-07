import { readVerificationPacket } from '@/modules/finance/phase-nine-packet-queries';
import type { PacketTone } from '@/modules/finance/phase-nine-verification-packet';
import { Badge } from '@/ui';

/**
 * A read-only, packet-ready summary of ONE payment claim for the person who is about to verify it (Phase 9B). It is composed from the claim, its invoice,
 * the imported bank lines, the open exceptions and the recorded account check; it verifies, rejects and sends nothing, and says so. A role that reads no
 * finance sees nothing (the database answers, not this component).
 *
 * Wiring (the parent adds ONE line inside each claim's detail in app/(internal)/invoices/verify/page.tsx, next to <ClaimDecision />):
 *   <VerificationPacket submissionId={claim.id} />   (import { VerificationPacket } from './verification-packet')
 */
const TONE: Record<PacketTone, 'success' | 'warning' | 'danger'> = { ok: 'success', attention: 'warning', blocking: 'danger' };

export async function VerificationPacket({ submissionId }: { submissionId: string }) {
  const packet = await readVerificationPacket(submissionId);
  if (!packet) return null;
  return (
    <section aria-label="Verification packet" className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] font-medium text-foreground">{packet.headline}</p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[13px]">
        {packet.lines.map((l) => (
          <div key={l.label} className="contents">
            <dt className="text-muted">{l.label}</dt>
            <dd className="text-foreground">{l.value}</dd>
          </div>
        ))}
      </dl>
      <ul className="flex flex-col gap-1">
        {packet.flags.map((f, i) => (
          <li key={`${i}-${f.code}`} className="flex items-start gap-2 text-[13px]">
            <Badge tone={TONE[f.tone]}>{f.tone === 'ok' ? 'Checks out' : f.tone === 'attention' ? 'Look' : 'Stop and look'}</Badge>
            <span className="text-foreground">{f.text}</span>
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-muted">{packet.reminder}</p>
    </section>
  );
}
