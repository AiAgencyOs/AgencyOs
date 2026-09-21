import type { Metadata } from 'next';

import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { listInternalRoster, listInternalRosterWithRoles, listTeamDefaults } from '@/modules/projects/queries';

import { DefaultDesignReviewerForm, ProjectGroupIdentifierForm } from '../forms';
import { MemberRolesPanel } from '../member-roles-panel';
import { TeamRosterPanel } from '../team-roster-panel';

export const metadata: Metadata = { title: 'Settings — Team' };

export default async function SettingsTeamPage() {
  await requireInternal('/settings');

  // G-267 — the people every new project group card is prepared with.
  const teamDefaults = await listTeamDefaults();
  const roster = await listInternalRoster();
  // G-310 — the same roster, with each person's additional roles attached.
  const rosterWithRoles = await listInternalRosterWithRoles();

  const supabase = await createClient();
  const { data: orgRows } = await supabase
    .schema('core')
    .from('organizations')
    .select('settings, default_design_reviewer_id')
    .limit(1);
  const orgSettings = (orgRows?.[0]?.settings ?? {}) as Record<string, unknown>;
  // G-300 — who a new Phase 3 starts with, and the roster it may be chosen from.
  const defaultDesignReviewer = orgRows?.[0]?.default_design_reviewer_id ?? null;
  // G-188 — the one part of a project group's name that is the owner's to choose.
  const groupIdentifier =
    typeof orgSettings.project_group_identifier === 'string' ? orgSettings.project_group_identifier : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Project group names</h2>
        {/*
          G-188. Four of the five parts are facts about the project — its name,
          the quotation the client agreed, the start date, the client — and
          composing them is not a preference. This is the fifth, which is.
        */}
        <p className="text-xs text-muted">
          A project group is named{' '}
          <span className="tabular">project // price // start date // client</span>, composed from
          the project itself. Add a word here and it goes on the end of every new one.
        </p>
        <ProjectGroupIdentifierForm identifier={groupIdentifier} />
      </div>

      {/*
        G-267. The other half of a group card: G-253 read this roster onto
        every card and gave it no way in, so each one shipped with the
        client's contacts and none of the agency's own people.
      */}
      <TeamRosterPanel members={teamDefaults} />

      {/*
        Multirole — G-310. An owner may grant a person additional roles beyond
        their primary one; see the panel's own comment for exactly what that
        does and does not affect.
      */}
      <MemberRolesPanel members={rosterWithRoles} />

      {/*
        Designer §4, G-300. The gate refuses until a named person holds it, and
        on a fresh project nobody does — a dead stop with no information in it.
        A default removes that, and deliberately does not govern: see the
        wording in the form.
      */}
      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Who reviews design work</h2>
        <p className="text-xs text-muted">
          The internal design gate refuses until somebody specific holds it — a capability check
          would let anyone stand in, and the point of the gate is that a named person looked.
          Nothing reaches Admin review until it passes.
        </p>
        <DefaultDesignReviewerForm current={defaultDesignReviewer} roster={roster} />
      </div>
    </div>
  );
}
