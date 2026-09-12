import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { packetSections, readiness, unresolvedSentences } from '@/modules/sales/handoff-view';
import { readWonHandoffPacket } from '@/modules/sales/queries';
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, IconArrowLeft, IconArrowUpRight, StatusBadge } from '@/ui';

export const metadata: Metadata = { title: 'Handoff packet' };

/**
 * The WON handoff packet, shown — G-235 (the face of G-232).
 *
 * Master Plan V3 §13.4's nine rows, each from the packet `sales.won_handoff_packet`
 * projects over recorded facts, and each absence the packet named shown in
 * its row as a sentence (ADM-72). The Blueprint places this exactly here:
 * §8's WON state is "Converted + handoff link", action "Read/audit".
 *
 * Read-only, and there is nothing to write: the row is one per deal, admin
 * tables refuse an end-user write, and nothing consumes it while Phase 2 is
 * not activated — which the banner says in those words.
 */
export default async function HandoffPage({ params }: { params: Promise<{ opportunityId: string }> }) {
  const { opportunityId } = await params;
  const context = await requireInternal(`/handoffs/${opportunityId}`);
  if (!can(context.role, 'lead.read')) redirect('/dashboard');

  const packet = await readWonHandoffPacket(opportunityId);
  if (!packet) {
    // Not a 404: a deal won before packets were written at the transition
    // (G-232) has none, and the projection reads under the caller's RLS, so a
    // deal of another organization answers the same way. Both are said.
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Link href="/leads" className="flex items-center gap-1.5 hover:text-foreground">
            <IconArrowLeft size={15} />
            Leads
          </Link>
          <span className="text-faint">/</span>
          <span className="truncate font-medium text-foreground">Handoff</span>
        </div>
        <EmptyState
          title="No handoff packet is recorded for this deal"
          description="Packets are written at the moment a deal is won (G-232). A deal won before that existed has none, and a deal that is not this organization's answers the same way. Nothing here is reconstructed after the fact."
        />
      </div>
    );
  }

  const sections = packetSections(packet);
  const absences = unresolvedSentences(packet);
  const banner = readiness(packet);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center gap-2 text-[13px] text-muted">
        {packet.client?.lead_id ? (
          <Link href={`/leads/${packet.client.lead_id}`} className="flex items-center gap-1.5 hover:text-foreground">
            <IconArrowLeft size={15} />
            Lead
          </Link>
        ) : (
          <Link href="/leads" className="flex items-center gap-1.5 hover:text-foreground">
            <IconArrowLeft size={15} />
            Leads
          </Link>
        )}
        <span className="text-faint">/</span>
        <span className="truncate font-medium text-foreground">Handoff · {packet.opportunity?.name ?? 'deal'}</span>
      </div>

      <Card>
        <CardHeader
          title={`Handoff packet — ${packet.opportunity?.name ?? 'deal'}`}
          description="What Sales hands to Phase 2, as references to recorded facts. Nothing here is a summary; every line points at a row."
          actions={
            <>
              <StatusBadge status={packet.status ?? null} />
              {packet.opportunity?.stage ? <Badge tone="success">Deal: {packet.opportunity.stage}</Badge> : null}
            </>
          }
        />
        <CardBody className="flex flex-col gap-3">
          <Callout tone={banner.tone} title={banner.title}>
            {banner.text}
          </Callout>
          {absences.length > 0 ? (
            <Callout tone="warning" title={`${absences.length} thing${absences.length === 1 ? '' : 's'} the packet does not know`}>
              <ul className="flex list-disc flex-col gap-0.5 pl-4">
                {absences.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </Callout>
          ) : (
            <p className="text-[13px] text-muted">Nothing the packet checks is missing. What it cannot carry at all is said in its row — see acceptance evidence under 5.</p>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {sections.map((section) => (
          <Card key={section.key} className={section.key === 'next' ? 'lg:col-span-2' : undefined}>
            <CardHeader
              title={section.title}
              actions={section.absences.length > 0 ? <Badge tone="warning" dot>{section.absences.length} missing</Badge> : null}
            />
            <CardBody className="flex flex-col gap-2">
              {section.lines.length === 0 && section.absences.length === 0 ? (
                <p className="text-[13px] text-muted">Nothing recorded.</p>
              ) : null}
              {section.lines.map((line, i) => (
                <p key={`${i}-${line}`} className="text-[13px] leading-relaxed">{line}</p>
              ))}
              {section.absences.map((a, i) => (
                <p key={`${i}-${a}`} className="text-[13px] leading-relaxed text-warning">{a}</p>
              ))}
              {section.links.length > 0 ? (
                <div className="flex flex-wrap gap-3 pt-1">
                  {section.links.map((l) => (
                    <Link key={l.href} href={l.href} className="inline-flex items-center gap-1 text-[12.5px] underline underline-offset-2 hover:text-foreground">
                      {l.label}
                      <IconArrowUpRight size={13} />
                    </Link>
                  ))}
                </div>
              ) : null}
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
