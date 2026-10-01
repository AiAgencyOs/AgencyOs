# Theme W4 — Requirements, Design, Prototype, Development: what was built

Rows: `B.md` SCR-028 to SCR-036 and `C.md` SCR-037 to SCR-043. Migrations (prefix `20261006400…`):

| migration | adds |
|---|---|
| `20261006400000_a_clarification_is_asked_of_a_requirement` | `projects.requirement_clarifications`; doors `raise_requirement_clarification`, `answer_requirement_clarification` |
| `20261006400100_a_design_review_is_a_thread_and_a_screen_is_approved_by_a_gate` | `design_review_comments` + `comment_on_design_review`; `record_design_share` now delivery-role only; `screens.category`, `qa_confirmed_*`, doors `set_screen_category`, `confirm_screen_qa`, `approve_screen` (refuses missing states / no QA confirmation; status-only moves stay possible after a baseline is finalized); asset kinds logo/icon/font + font media types + licence on upload (`record_uploaded_design_asset` gains `p_licence`); `brand_rules` + `add_brand_rule` / `remove_brand_rule` |
| `20261006400200_a_build_has_details_and_a_prototype_goes_to_the_client_through_a_gate` | `deliverable_details` (platform, Admin status, QA check, commit ref, build number, rollback target); doors `set_deliverable_details`, `decide_prototype_admin`, `record_prototype_qa_check`; `prototype_send_gate`; `submit_deliverable` refuses a prototype that is not QA-passed and Admin-approved; `send_prototype_for_client_review` (owner override with a reason, audited); `project_plans.approved_*` + `approve_project_plan`; `repository_links.access_level / merge_min_approvals / merge_role` + `set_repository_policy` |

Verifier: `scripts/verify-requirements-design-build.mjs` (`npm run db:verify:w4`, step in `.github/workflows/verify.yml`) — 100+ live checks, all passing. Behavioural tests: `tests/a-repository-policy-limits-what-the-panel-does-with-the-token.test.ts`, `tests/a-handoff-bundle-is-a-real-zip-and-the-dashboard-filter-is-exact.test.ts`. Rendered at 1536 and 390 (no horizontal overflow on any changed route). Temporary local rows (marker `zzbuild-W4`) were seeded to render populated states and deleted afterwards. Storage is unreachable locally: file flows (asset upload, ZIP file entries from storage) are verified by code path and unit tests, not in the browser. GitHub is unreachable: the merge policy is verified by the pure policy functions and the database door, not a live merge.

Legend: BUILT (where; how verified) / ALREADY (present from an earlier stream, re-verified rendered) / OWNER-QUESTION / NOT-BUILDABLE.

## SCR-028 Requirements Dashboard
| item | result |
|---|---|
| Open requirement set | BUILT — rows open `/projects/{id}/requirements`; lead tab links to the project's set. Rendered. |
| Request clarification | BUILT — new requirement-level door (no plan needed), shown on the requirement, counted in "Open clarifications", listed in the queue. Verifier A + rendered. The old plan question stays as "Raise a plan question". |
| Open-question queue | BUILT — "Open-question queue" card lists every unanswered requirement question, oldest first. Rendered with a seeded row. |
| Search/filter | BUILT — search, scope-state and open-item filters, paging (`requirements-dashboard-filter.ts`, unit-tested). |
| Note: "Frozen scopes" counted versions | BUILT — now counts projects with a frozen baseline. |

## SCR-029 Requirement Set / Detail
| item | result |
|---|---|
| Header / nine sections / Edit draft / Approve-freeze / source retained | ALREADY in source (lead tab `RequirementSetPanel`); still UNVERIFIED rendered: `crm.requirement_versions` is empty locally and this stream did not seed a conversation pipeline. |
| Request client clarification | BUILT (see SCR-028), on each requirement. |
| Link to quotation / design / development task | BUILT — requirement detail shows the quotation(s) priced from its scope's requirement version and the development tasks under its feature (links to the task); the "Source Requirement Set" card shows the lead and the links declared from the requirement version (quotation, design, task). |
| One coherent set | BUILT — project list says which requirement version it descends from (Source Requirement Set), lead's Extracted requirements names the project scope(s) frozen from it. |

## SCR-030 / SCR-031 (scope, change requests)
| item | result |
|---|---|
| Revision allowance tiles | ALREADY (three tiles render from the phase rows). OWNER-QUESTION: before a phase row exists the allowance is unknown and shows "—". Where is the revision allowance defined before Phase 3/4 open (contract term, quotation clause, or a fixed 2)? |
| Change-request state tiles (awaiting approval, rejected), CR filter by status/classification | ALREADY — tiles and `?crStatus=&crClass=` filter present; re-checked rendered. |
| Linked tasks, approve/reject, send quotation | UNVERIFIED — need a CR in those states; doors exist. |

## SCR-032 Design Dashboard
| item | result |
|---|---|
| Design versions / Prototype builds tiles | BUILT — two tiles with in-review/approved captions. |
| Open Figma reference | BUILT — Themes tab links the recorded file key + node to Figma. |
| Upload design | UNVERIFIED (storage). |

## SCR-033 UI Theme Finalization
| item | result |
|---|---|
| KPI strip on Themes | BUILT — screen list, options, colour combinations, reviewer, decision status. |
| Send approved options to client | NOT-BUILDABLE — no channel exists (recorded decisions BLK-003/007). The door records what a person sent. |
| Reference uploads | UNVERIFIED (storage). |

## SCR-034 Screen Inventory
| item | result |
|---|---|
| Planned / designed / approved / missing screens | BUILT — tiles "Planned", "Designed", "Approved", "Missing Screens" (included requirements with no screen). |
| Category grouping | BUILT — `screens.category`, category column, "By category" grouping, category form on the screen. |
| Missing states block completeness | BUILT — `approve_screen` refuses naming the missing states. Screens already Approved in the seed are history and show as such. Verifier C. |

## SCR-035 Screen Detail
| item | result |
|---|---|
| QA must confirm before approval | BUILT — "Design Approval" panel: states, QA submitted, QA confirmed (owner/ops admin only), then approve. |
| Navigation paths / Buttons-actions | OWNER-QUESTION: should navigation be structured links between screens and actions a structured list (new tables), or is the current free text acceptable? |
| Map requirement | OWNER-QUESTION: a finalized baseline refuses mapping by design (owner decision); should the control be offered with a "draft the next baseline" action instead? |

## SCR-036 Design Review & Approval
| item | result |
|---|---|
| KPI strip on the review screen | BUILT — Final tab: awaiting internal / Admin / client, revision count. |
| Review queue | BUILT — `/design` queue now includes design and prototype deliverables in review (was "Artifacts in review 2, queue 0"); new tile "Deliverables in review". |
| Comments | BUILT — comment thread per theme option and per design/prototype deliverable. |
| PM send to client after Admin approval | BUILT — `record_design_share` restricted to delivery roles; Final tab shows which options are ready and what each waits for. Sending itself stays "record what was sent" (no channel). |

## SCR-037 Prototype Builds & Review
| item | result |
|---|---|
| Platform/type, Admin status, revision count | BUILT — columns on the build table; platform on create and edit. |
| Build detail | BUILT — `/projects/{id}/prototype/builds/{deliverableId}`. |
| QA evidence / client feedback | BUILT on the detail page (artifact verdict, recorded QA check, client feedback). Test runs cannot name a prototype (Doc 14 §2), so a prototype's QA is the agent verdict or a person's recorded check. |
| Upload build | PARTIAL — platform, commit and link are captured; a file upload is NOT-BUILDABLE here (storage unreachable locally). |
| Submit to QA / Admin confirm-edit / record client approval-change | BUILT — QA check form, Admin decision form, client answer recorded through the approval engine with evidence (form on the build page). Submit-to-QA on agent builds is the existing door. |
| Only QA-passed + Admin-approved is sent | BUILT — gate shown with both states, refused by the database; the owner may override with a reason (audited). Verifier E. |
| Search/filter, inspection drawer | BUILT — search, status, platform, QA filters; the detail page is the inspection surface. |

## SCR-038 Assets, Brand Kit & Feedback History
| item | result |
|---|---|
| Phase 3-5 reachability | BUILT — a project with design/prototype work but no Phase 3 record now shows its design versions and prototype links instead of only "Phase 3 has not started". Asset upload still needs a Phase 3 record (`design_assets.phase_three_id`). Rendered. |
| Asset categories | BUILT — per-kind counts on the asset card; Brand Kit tiles. |
| Brand kit, asset kinds, licence | BUILT — `/design/brand`: logos, icons, fonts (files), written brand rules; licence captured on upload and flagged when missing. Verifier D. |
| Export handoff package | BUILT — ZIP (manifest, asset sheet CSV, brand-kit.md, generated images from the database, uploaded files from storage, `MISSING.txt` for anything storage would not hand over). ZIP writer unit-tested. |
| Licensed/private assets outside permissions | PARTIAL — licence is recorded and shown; OWNER-QUESTION: should assets be blockable from client-facing surfaces by a visibility flag (none of the client surfaces shows design assets today)? |
| Recent feedback list, feedback linked to the exact version, asset search | NOT BUILT — OWNER-QUESTION: feedback rows are tied to theme option and round; should they also carry a UI-version / prototype-build reference (new column on client decisions)? |
| Folders, version links, replace, mark approved, link asset | UNVERIFIED (storage). |

## SCR-039 Development Dashboard
| item | result |
|---|---|
| Active developer tasks | BUILT — cross-project list with assignee. |
| Recent commits/builds | BUILT — builds (with commit ref and number) join the commit/action list. |
| Open plan/task/repository/build | BUILT — "Open" column links Plan, Repository, Builds. |
| Search/filter | BUILT — search plus In build / Blocked / No active plan. |
| Upcoming dependency needs, "PM does not split technical work" | UNVERIFIED (need a plan / a non-PM role pass). |

## SCR-040 Implementation Plan
| item | result |
|---|---|
| Plan page renders plans | BUILT/VERIFIED — a local plan was seeded and the page rendered: deliverables with execution order, layers, definition of done, dependencies, risks; header now also shows client dependencies outstanding and risk count. |
| Contradictory "operational, never technical" copy | BUILT — copy now states the boundary (the pinned sentence stays) and what the page does hold. |
| Approve plan internally | BUILT — `approve_project_plan`; Activate is offered after approval. Not a database gate on activation (existing verifiers activate directly); OWNER-QUESTION: should activation require the approval in the database? |
| Plan version/status, coverage, modules/features, dependencies, execution order, DoD, create tasks, version | Rendered with the seeded plan (version/status, coverage, deliverables, order, DoD); create-tasks and next-version forms exist (not exercised). |
| Acceptance criteria per feature in the plan | OWNER-QUESTION: criteria live on scope items; should each plan deliverable copy or cite them? |
| Request missing client dependency through PM | OWNER-QUESTION: which role is "the PM" in routing (delivery lead)? |
| Filter | BUILT — deliverable filter. |

## SCR-041 Task Execution
| item | result |
|---|---|
| Request clarification without a plan | BUILT — goes to a requirement the task delivers. |
| Implementation notes | BUILT — dedicated card (the task description, editable from the Board). |
| Acceptance criteria, requirement-check gate, Start task, Reopen after QA failure | ALREADY/UNVERIFIED — criteria via the feature's scope items; OWNER-QUESTION: should "requirement check" be a gate before Start (new rule)? |

## SCR-042 Repository, Branch & Code Review
| item | result |
|---|---|
| Merge policy | BUILT — who may merge, approving reviews needed (read from GitHub), green checks always; enforced in the merge door; pure rules unit-tested. |
| Least privilege per repo | BUILT — access level read only / branches and reviews / full, enforced by every write door, with the token permissions each level needs listed. The org-wide token cannot be shrunk by the panel. |
| Branch/commit/PR/findings/actions | UNVERIFIED — GitHub unreachable locally. |
| Auto-mapping code to tasks | OWNER-QUESTION: map commits to tasks by a branch-name or message convention (`task/<id>-…` branches already embed the id)? |
| Search | BUILT — search over commits, branches and pull requests. |

## SCR-043 Builds, Environments & Dependencies
| item | result |
|---|---|
| Migration/API compatibility tile | BUILT — counts environments with both checks ok. |
| Build reproducibility and rollback | BUILT — commit/ref, build number, rollback target and note per build; warnings when missing. Verifier F. |
| Run contract/migration checks | OWNER-QUESTION: no runner exists for a client's environment; which should run them (a workflow on the linked repo dispatched from here, or an HTTP probe of the environment URL)? Until then they stay recorded by a person with evidence. |
| Build history/environment matrix/promote/mark supplied | UNVERIFIED (need environments). |
| Search/filter | BUILT — builds by text and status, dependencies by status. |

## Counts
BUILT 52 · ALREADY/UNVERIFIED (needs data or a role pass) 17 · OWNER-QUESTION 14 (listed above) · NOT-BUILDABLE 3 (client channel, file upload locally, live GitHub/storage verification).
