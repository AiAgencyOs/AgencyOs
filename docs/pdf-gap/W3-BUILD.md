# W3 build — Global control, Sales, Clients (A.md front matter + SCR-001 to SCR-017)

No migration was needed: every item below is a read of a stored row or a call to a door that already existed
(`core.escalations`, `set_notification_state`, `crm.merge_leads`, `setLeadStatus`, `setClientOwner/Tags`, proposal doors).
No new table, so no live verifier; behavioural tests: `tests/w3-inbox-search-and-client-rules.test.ts`.
Some A.md rows were already stale when this pass started (leads service/budget/date filters and Clear-all exist behind the
Filter toggle; return-to-discovery is in `LEAD_TRANSITIONS`). They are marked PRESENT.

| Row | Result | Where / how |
|---|---|---|
| Front: Clear all filters | BUILT | `FilterBar clearHref` added to Clients and Quotations (Leads, Projects, Follow-ups, Search, Notifications, Approvals already had it) |
| Front: sticky headers, error state w/ reference, nav naming | UNVERIFIED / not a W3 change | needs a forced error; nav list is the 2026-10-03 owner choice in nav-config.ts |
| SCR-001 five named KPIs + Needs Action | BUILT | dashboard header StatGrid; Blocked Projects now uses the projects-list health rule |
| SCR-001 phase distribution | BUILT | "Project Phases" card (lifecycle phases, links to `/projects?phase=`) |
| SCR-001 health column | BUILT | Health column from `healthOfProject` (same rule as /projects, closes the two-rules contradiction on this page) |
| SCR-001 Acknowledge beside Escalate | BUILT | `notifications/acknowledge-button.tsx` -> `set_notification_state` |
| SCR-001 banner action link | BUILT | "Open Operations to retry or review" (inbox link for roles without audit.read) |
| SCR-001 app/web-tier health row, Today itemising, org selector | NOT BUILT | no app-tier signal exists; Today empty in seed |
| SCR-002 requirement/file/agent/audit types | BUILT | `global-search-page.ts` (scope_items, project_files, agent registry passed in by the page, audit_log); chips and sections |
| SCR-002 filter builder | BUILT | stackable `f=field:op:value` conditions (status/owner/created), client `AdvancedFilters`, pure parser tested |
| SCR-002 saved-search edit | BUILT | rename + change query (`editSearch`); conditions are saved with the search |
| SCR-002 AI / semantic search | OWNER-QUESTION | see below |
| SCR-003 more categories | BUILT | Client responses (unanswered inbound threads), System alerts (open `core.alerts`) |
| SCR-003 grouping, per-item history, escalation destination | BUILT | `groupRepeats` for delivery/job/alert streams with count + expand; drawer "Action history"; "Send to" label + who sees it |
| SCR-004 | UNVERIFIED | recents/drafts exist in source; contextual prefill not exercised |
| SCR-005 KPIs | BUILT | Qualified Leads, Proposals Sent, Pipeline Value, Deals Closed, Closed Revenue |
| SCR-005 lead-status view | BUILT | `?view=leads` toggle: New / Qualifying / Qualified / Nurture (read-only; moves need a reason on the lead) |
| SCR-006 service/budget/date filters | PRESENT | behind "Filter" |
| SCR-006 consent / handoff / reply / duplicate indicators | BUILT | `lead-indicators-queries.ts`, Flags column |
| SCR-006 merge from list, open conversation | BUILT | `merge-duplicate-button.tsx` (same door, owner only); "Open conversation" -> `?tab=conversation` |
| SCR-007 tabs | BUILT (hide option) | `LeadTabs` drops tabs with no section on the page, honours `?tab=` |
| SCR-007 header requirement status, Won path | NOT BUILT / UNVERIFIED | needs seeded requirement version; Won is through quote acceptance |
| SCR-008 Qualification screen | BUILT | `/leads/[id]/qualification`: score vs human decision, fit criteria (16 discovery areas), budget, timeline, decision maker, objections, disqualification history, guarded moves, Return to discovery |
| SCR-008 budget band | OWNER-QUESTION | see below |
| SCR-008 numeric score vs ADM-88 | OWNER-QUESTION | not chosen |
| SCR-009, SCR-010 | UNVERIFIED | need seeded requirement versions / a calendar credential |
| SCR-011 total excludes superseded | BUILT | headline and caption |
| SCR-011 list actions | BUILT | row menu: open lead, PDF, drawer hosting the existing Submit / Send / Record-answer forms |
| SCR-012 GST toggle | PRESENT | checkbox already in composer |
| SCR-012 four-milestone schedule | OWNER-QUESTION | schedule is the agency's configured payment structure; the PDF calls 30/20/30/20 "a common example" |
| SCR-012 Share (#13) | BUILT | removed from the composer (nothing is approved there); "Copy link" offered only for approved/sent/accepted quotations |
| SCR-013 Schedule, drawer text, Pause naming | BUILT | `schedule-follow-up-button.tsx`; drawer copy corrected; Stop renamed Pause |
| SCR-014 Preview scoping | BUILT | the three panels under the table follow the selected client (`scopeClientId`) |
| SCR-014 bulk owner/tags, dedupe flag | BUILT | `clients/bulk-bar.tsx` + `bulk-actions.ts` (per-client doors, refusals reported); `duplicateCounts` |
| SCR-014 lifecycle chips overlap | NOT BUILT | definition of "pending" is a business call |
| SCR-015 GSTIN/PAN restricted | BUILT | read-only display needs `invoice.read` |
| SCR-016 Open project finance | BUILT | column in the client's projects table |
| SCR-016/017 remaining | NOT BUILT | storage unreachable locally; announcements come from campaigns |
| Bulk actions beyond Leads | PARTIAL | Clients only (PDF names owner/tags there); Quotations/Projects not named |

## Owner questions
1. Semantic / AI-assisted search (SCR-002): build it, and over which records?
2. Lead numeric score: UI shows "x/100" but ADM-88 refused a number and decision #14 says none; which stands?
3. Budget band (SCR-008): what are the band boundaries?
4. Default payment schedule (SCR-012): should the PDF's 30/20/30/20 four-milestone plan be the seeded default (today: the configured "Standard 30/40/30")?
5. Client lifecycle chips: should "Pending" exclude clients already counted Active?
