import type { ProjectGroupName } from '@/modules/projects/queries';

/**
 * The project WhatsApp group's name — G-188.
 *
 * The brief specifies it exactly, and the audit found (PG-03) that nothing
 * composed it: the link form took free text, so the name was whatever somebody
 * typed. **This panel does not create the group and cannot**: Meta's Cloud API
 * has no Groups API (#131215, established against the real Graph API). A
 * person creates it in WhatsApp.
 *
 * So the honest half is to hand them the exact name and let them copy it —
 * and, when a fact is still missing, to say which one rather than showing a
 * name with a hole in it.
 */
export function ProjectGroupPanel({ group }: { group: ProjectGroupName }) {
  const linkedName = group.linked?.title ?? null;
  const matches = linkedName !== null && group.title !== null && linkedName === group.title;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[13px] font-semibold tracking-tight">Project WhatsApp group</h2>

      {group.linked ? (
        <>
          <p className="text-sm">
            Linked{group.linked.externalRef ? <> · <span className="tabular text-muted">{group.linked.externalRef}</span></> : null}
          </p>
          <p className="break-words rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
            {linkedName ?? <span className="text-muted">This group has no name recorded.</span>}
          </p>
          {/*
            Stated rather than corrected. Renaming somebody's group behind them
            would be a worse answer than telling them the two disagree, and the
            owner may have named it deliberately.
          */}
          {!matches && group.title ? (
            <p className="text-[13px] text-muted">
              The standard name for this project is{' '}
              <span className="text-fg">{group.title}</span> — rename it in WhatsApp if you want
              them to match.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-[13px] leading-relaxed text-muted">
            One of the three conditions for this project officially starting (ADM-13).{' '}
            <strong className="text-fg">AgencyOS cannot create it</strong> — WhatsApp gives no API
            for making a group or adding people to one — so create it on your phone, then paste its
            id on the group form.
          </p>

          {group.title ? (
            <>
              <p className="text-[13px] text-muted">Create it with exactly this name:</p>
              <p className="break-words rounded-md border border-line bg-surface px-3 py-2 text-[13px] font-medium">
                {group.title}
              </p>
              <p className="text-xs text-muted">
                Linking the group without typing a name will record this one.
              </p>
            </>
          ) : (
            <>
              <p className="text-[13px] text-muted">
                The standard name cannot be composed yet — it is missing{' '}
                <strong className="text-fg">{group.missing.join(', ')}</strong>.
              </p>
              {/*
                Named rather than guessed. A name assembled around a missing
                price would be read as the price the client agreed, and pasted
                into a chat the client is in.
              */}
              <p className="text-xs text-muted">
                Fill that in and the name appears here. Nothing stops you creating the group in the
                meantime.
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}
