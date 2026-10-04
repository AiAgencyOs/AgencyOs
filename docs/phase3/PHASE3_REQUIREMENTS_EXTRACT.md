# Phase 3 Requirements Extract (locked PDFs)

Extracted 2026-10-04 by reading every page of the three locked PDFs in `phase 3/`.

Source key (page numbers are the PDF's own footer page numbers):
- **M** = `AgencyOS_Phase_3_UI_Theme_Color_Finalization_Master_Flow_Implementation_Plan_Checklist.pdf` (18 pp). IDs `P3-M-nn`.
- **PM** = `AgencyOS_Phase_3_PM_Agent_Responsibilities_Implementation_Specification.pdf` (18 pp). IDs `P3-PM-nn`.
- **UD** = `AgencyOS_Phase_3_UI_Designer_Agent_Responsibilities_Implementation_Specification.pdf` (20 pp). IDs `P3-UD-nn`.

Conventions: "approx. 2-3" is the PDFs' own wording for the option count and the client-revision limit; it is quoted rather than resolved to a number. Section numbers are the PDFs' own. Where the PDF text renders overlapped or clipped (M section 4 table, M section 8 last row, PM section 13 last row, PM section 16 last row, UD section 20 last row), the row is flagged "(clipped in PDF)".

---

## Part 1. Master flow, plan and checklist (P3-M)

| ID | Source (section, page) | Requirement | Named state / event / role / field / number |
|---|---|---|---|
| P3-M-01 | M cover, p.1 | Phase 3 is a LOCKED implementation baseline; entry requires Phase 2 complete plus official kickoff plus approved project context. | Status "LOCKED PHASE 3 IMPLEMENTATION BASELINE"; Entry |
| P3-M-02 | M cover, p.1 | Primary design role is the Figma Designer Agent. | Figma Designer Agent |
| P3-M-03 | M cover, p.1 | Three human/review gates in order: Internal review, then Admin approval, then Client selection/confirmation. | Internal review -> Admin approval -> Client selection/confirmation |
| P3-M-04 | M cover, p.1 | Primary output is a client-approved UI theme, a client-approved color combination, and a finalized screen/content baseline. | Output |
| P3-M-05 | M cover, p.1 | Next phase is Phase 4 (Full UI Design + UI Prototype). | Phase 4 |
| P3-M-06 | M cover, p.1 | Cost principle: reuse first, avoid duplicate AI/design/API work, use one canonical design pipeline. | Cost Principle |
| P3-M-07 | M cover, p.1 | The spec adds implementation, Admin Panel traceability, cost-control, QA, state, event, data and production-readiness requirements without changing the agreed business flow. | - |
| P3-M-08 | M s1, p.2 | Phase 3 is a design-direction phase only; it does not create the complete final UI or functional product. | - |
| P3-M-09 | M s1, p.2 | Phase 3 converts approved project context into a locked visual direction that Phase 4 can use without re-deciding theme and colors. | - |
| P3-M-10 | M s1, p.2 | Final outcome comprises: finalized screen list + screen-by-screen content baseline + client-approved UI theme + client-approved color combination + complete approval/history evidence. | Final Phase 3 outcome |
| P3-M-11 | M s2, p.2 | Locked high-level flow (in order): PHASE 2 COMPLETE -> PM PHASE 3 ANNOUNCEMENT -> LOAD APPROVED SCOPE/PROJECT PLAN -> FINALIZE SCREEN LIST -> FINALIZE SCREEN CONTENT -> FIGMA DESIGNER CREATES 2-3 UI THEME DIRECTIONS -> 2-3 COLOR COMBINATIONS PER DIRECTION AS APPLICABLE -> INTERNAL REVIEW -> ADMIN REVIEW -> ADMIN CONFIRM/EDIT -> CLIENT REVIEW -> CLIENT SELECTS OR REQUESTS CHANGE -> LIMITED REVISION LOOP -> CLIENT FINAL CONFIRMATION -> LOCK THEME + COLOR -> PHASE 3 COMPLETE -> PHASE 4 HANDOFF. | 2-3 themes; 2-3 colors per direction |
| P3-M-12 | M s3, p.2 | Start condition: Phase 2 completed successfully. | - |
| P3-M-13 | M s3, p.2 | Start condition: official project kickoff has occurred. | - |
| P3-M-14 | M s3, p.2 | Start condition: accepted quotation and approved scope are available. | - |
| P3-M-15 | M s3, p.2 | Start condition: Project Planning Agent output / operational blueprint is available in project context. | - |
| P3-M-16 | M s3, p.2 | Start condition: known requirements and Phase 1/2 decisions are loaded. | - |
| P3-M-17 | M s3, p.2 | Start condition: PM Agent is assigned. | - |
| P3-M-18 | M s3, p.2 | Start condition: Phase 3 has not already been started for the same project/version (duplicate-start guard). | project/version |
| P3-M-19 | M s3, p.2 | Start condition: required project design context is accessible without asking the client to repeat confirmed information. | - |
| P3-M-20 | M s4, p.3 | PM Agent owns client communication, Phase 3 announcement, sharing approved options, collecting selection/change requests, and confirmation; must not own design execution or technical implementation (cell partly clipped in PDF). | Actor: PM Agent |
| P3-M-21 | M s4, p.3 | Figma Designer Agent owns UI theme directions, color combinations, visual samples and revisions; must not own scope changes or client approval. | Actor: Figma Designer Agent |
| P3-M-22 | M s4, p.3 | Internal Design Reviewer owns quality/consistency/requirements review before Admin; must not give client-facing approval. | Actor: Internal Design Reviewer |
| P3-M-23 | M s4, p.3 | Admin (Human) owns internal approval or edit request before client sharing; must not do routine design generation. | Actor: Admin (Human) |
| P3-M-24 | M s4, p.3 | Client (Human) owns theme/color selection, references, change requests and final confirmation; must not own internal workflow state. | Actor: Client (Human) |
| P3-M-25 | M s4, p.3 | Orchestrator/Coordination owns routing, state, tasks, versions, blockers, evidence and retries; must not make design decisions by itself. | Actor: Orchestrator/Coordination |
| P3-M-26 | M s4, p.3 | Admin Panel owns visibility/history/control surface for all Phase 3 artifacts and decisions; it is not the source of design truth, because Figma remains the canonical design artifact (cell clipped in PDF). | Actor: Admin Panel |
| P3-M-27 | M s5, p.3 | The Figma artifact is the canonical source of truth for Phase 3 design direction and the Phase 4 handoff. | Locked design rule |
| P3-M-28 | M s5, p.3 | Figma Designer Agent creates the actual design directions/samples in Figma or through an approved Figma-integrated workflow. | - |
| P3-M-29 | M s5, p.3 | Image generation may be used only when it materially helps inspiration/reference creation. | - |
| P3-M-30 | M s5, p.3 | Do not pay for separate image-generation work when the same result can be created directly in, or reused in, Figma. | - |
| P3-M-31 | M s5, p.3 | Any generated inspiration image that affects the chosen design must be traceable to the final Figma direction. | - |
| P3-M-32 | M s5, p.3 | Phase 4 must consume the locked Figma direction rather than recreate the visual decision from scratch. | - |
| P3-M-33 | M s6, p.3 | Optimize for total useful project cost, not maximum model/API activity; do not independently regenerate the same design work across multiple tools/agents without a real review or quality need. | Cost-control principle |
| P3-M-34 | M s6, p.3 | Reuse Phase 1 requirements, Phase 2 onboarding data and Project Planning output. | - |
| P3-M-35 | M s6, p.3 | Reuse existing brand assets, design references and confirmed client preferences. | - |
| P3-M-36 | M s6, p.3 | Reuse approved components/design tokens where AgencyOS already has them. | - |
| P3-M-37 | M s6, p.3 | Generate only 2-3 meaningful design directions, not excessive variants. | 2-3 |
| P3-M-38 | M s6, p.3 | Use deterministic code/rules (not LLM tokens) for orchestration, state, comparison metadata and storage. | - |
| P3-M-39 | M s6, p.3 | Use a lower-cost model/capability for simple classification/extraction where quality is sufficient. | - |
| P3-M-40 | M s6, p.3 | Use a stronger model only for genuinely complex visual/design reasoning. | - |
| P3-M-41 | M s6, p.3 | Cache/reuse agent outputs where input/version has not changed. | - |
| P3-M-42 | M s6, p.3 | Do not regenerate Figma samples because of a job retry. | - |
| P3-M-43 | M s6, p.3 | Track AI/model/API usage by project, phase, agent and task where infrastructure supports it. | project, phase, agent, task |
| P3-M-44 | M s7.1, p.4 | After Phase 2 completion, PM posts a short client-facing message that setup/kickoff is complete and UI Finalization is starting. | PM announcement |
| P3-M-45 | M s7.1, p.4 | The announcement message stays simple; internal agent/model details are not exposed. | - |
| P3-M-46 | M s7.1, p.4 | The announcement event starts the backend Phase 3 workflow. | Announcement event (see contradiction C-01) |
| P3-M-47 | M s7.2, p.4 | Load accepted scope, requirements, project plan, client references, brand assets and confirmed preferences. | - |
| P3-M-48 | M s7.2, p.4 | Do not ask the client to repeat confirmed data. | - |
| P3-M-49 | M s7.2, p.4 | Detect missing/conflicting design information and route only genuine clarifications through PM. | - |
| P3-M-50 | M s7.3, p.4 | Create/confirm the complete screen/page list required by approved scope. | Screen list |
| P3-M-51 | M s7.3, p.4 | Map every screen to its source requirement/scope. | - |
| P3-M-52 | M s7.3, p.4 | Do not silently add out-of-scope screens. | - |
| P3-M-53 | M s7.3, p.4 | Version the screen list. | - |
| P3-M-54 | M s7.4, p.4 | For every screen define required sections/content/components/actions at requirement level. | - |
| P3-M-55 | M s7.4, p.4 | The screen-content output is a content/requirements baseline, not the full final visual UI. | - |
| P3-M-56 | M s7.4, p.4 | Identify unresolved content dependencies. | - |
| P3-M-57 | M s7.4, p.4 | Store source references and version for the content baseline. | - |
| P3-M-58 | M s7.5, p.4 | Figma Designer Agent creates 2-3 distinct, meaningful UI theme directions. | 2-3 |
| P3-M-59 | M s7.5, p.4 | Directions reflect project type, approved scope, brand/reference context and usability. | - |
| P3-M-60 | M s7.5, p.4 | Do not create excessive variants purely to consume generation capacity. | - |
| P3-M-61 | M s7.5, p.4 | Store Figma links/node/file references, preview assets and version metadata. | - |
| P3-M-62 | M s7.6, p.4 | Prepare approx. 2-3 appropriate color combinations for design directions, as applicable. | approx. 2-3 |
| P3-M-63 | M s7.6, p.4 | Color options remain coherent with the design direction and available brand constraints. | - |
| P3-M-64 | M s7.6, p.4 | Store token/palette metadata for later Phase 4 reuse. | - |
| P3-M-65 | M s7.7, p.4 | Internal reviewer checks requirement alignment, completeness, visual consistency, basic usability, theme distinction and presentation quality. | Review criteria |
| P3-M-66 | M s7.7, p.4 | A failed direction returns to the Figma Designer for correction. | - |
| P3-M-67 | M s7.7, p.4 | Review evidence/status is recorded. | - |
| P3-M-68 | M s7.8, p.4 | Only internally reviewed options go to Admin. | - |
| P3-M-69 | M s7.8, p.4 | Admin receives preview, Figma reference, screen/context summary and review evidence. | - |
| P3-M-70 | M s7.8, p.4 | Admin chooses CONFIRM or EDIT. | CONFIRM / EDIT |
| P3-M-71 | M s7.8, p.4 | If EDIT: structured reason -> Figma Designer -> internal review -> Admin again. | - |
| P3-M-72 | M s7.9, p.4 | Only Admin-approved options are shared by PM with the client. | - |
| P3-M-73 | M s7.9, p.4 | PM asks the client to choose a preferred theme/color or share their own reference/theme/color preference. | - |
| P3-M-74 | M s7.9, p.4 | All samples actually sent to the client are recorded in Admin Panel history. | - |
| P3-M-75 | M s7.10, p.5 | If the client requests changes, record the exact request and the source message/evidence. | - |
| P3-M-76 | M s7.10, p.5 | An accepted design request goes to the Figma Designer. | "accepted" undefined (see OQ-14) |
| P3-M-77 | M s7.10, p.5 | A revised output receives internal review and Admin review before being shared again. | - |
| P3-M-78 | M s7.10, p.5 | Mark the revision as originating from client feedback. | origin = client |
| P3-M-79 | M s7.10, p.5 | Repeat only within the configured limited revision policy, approx. 2-3 iterations. | approx. 2-3 iterations; configured |
| P3-M-80 | M s7.10, p.5 | Beyond the limit, escalate for human/scope/commercial decision rather than endless regeneration. | Escalation |
| P3-M-81 | M s7.11, p.5 | Client selects/confirms the final theme and color combination. | - |
| P3-M-82 | M s7.11, p.5 | Store client confirmation evidence, selected option IDs, Figma version and timestamp. | evidence, option IDs, Figma version, timestamp |
| P3-M-83 | M s7.11, p.5 | Lock the visual direction for Phase 4. | - |
| P3-M-84 | M s7.12, p.5 | Validate screen list, screen-content baseline, selected theme, selected colors and approval evidence before completion. | - |
| P3-M-85 | M s7.12, p.5 | Mark Phase 3 COMPLETED. | COMPLETED |
| P3-M-86 | M s7.12, p.5 | Emit structured Phase3Completed / Phase4Ready handoff. | Phase3Completed, Phase4Ready |
| P3-M-87 | M s8, p.6 | Locked AgencyOS-wide principle: important work, decisions, outputs and history from every phase must be visible in the Admin Panel; Phase 3 is not an exception. Admin must see the complete decision trail, not only the final UI. | - |
| P3-M-88 | M s8, p.6 | Admin Panel area "Phase 3 Overview": current state, owner, blockers, timestamps, progress. | Admin area |
| P3-M-89 | M s8, p.6 | Admin Panel area "Project Plan": Project Planning Agent blueprint relevant to the project. | Admin area |
| P3-M-90 | M s8, p.6 | Admin Panel area "Screen List": all finalized screens, source requirement, status, version. | Admin area |
| P3-M-91 | M s8, p.6 | Admin Panel area "Screen Content": screen-by-screen content/requirement baseline. | Admin area |
| P3-M-92 | M s8, p.6 | Admin Panel area "Theme Options": every theme option generated and its Figma/preview reference. | Admin area |
| P3-M-93 | M s8, p.6 | Admin Panel area "Color Options": every palette/combination and its linked theme. | Admin area |
| P3-M-94 | M s8, p.6 | Admin Panel area "Internal Review": reviewer result, comments, timestamps. | Admin area |
| P3-M-95 | M s8, p.6 | Admin Panel area "Admin Decisions": CONFIRM/EDIT history and reasons. | Admin area |
| P3-M-96 | M s8, p.6 | Admin Panel area "Client Shares": exactly which samples/options were sent and when. | Admin area |
| P3-M-97 | M s8, p.6 | Admin Panel area "Client Feedback": selection, change request, references, source evidence. | Admin area |
| P3-M-98 | M s8, p.6 | Admin Panel area "Revision History": V1/V2/V3..., origin, changes, reviewer/admin/client status. | V1/V2/V3 |
| P3-M-99 | M s8, p.6 | Admin Panel area "Final Selection": chosen theme + color + Figma version + client confirmation. | Admin area |
| P3-M-100 | M s8, p.6 | Admin Panel area "Phase Handoff": Phase 4-ready package and completion evidence. | Admin area |
| P3-M-101 | M s8, p.6 | Admin Panel area "Cost/Usage": design/model/API usage where available for cost monitoring (row clipped in PDF). | Admin area |
| P3-M-102 | M s8, p.6 | Historical data must be preserved; editing current state must not destroy the previous decision/version trail. | - |
| P3-M-103 | M s9, p.6 | Project Planning Agent's operational blueprint remains visible from the project Admin workspace. | - |
| P3-M-104 | M s9, p.6 | Phase 3 consumes the relevant project-plan context rather than duplicating it. | - |
| P3-M-105 | M s9, p.6 | Admin can inspect deliverables, applicable phases, dependencies, timeline shell, risks/blockers and readiness information. | - |
| P3-M-106 | M s9, p.6 | Phase 3 design decisions link back to relevant scope/deliverable references. | - |
| P3-M-107 | M s9, p.6 | Plan updates and Phase 3 design updates are independently versioned. | - |
| P3-M-108 | M s10, p.7 | Suggested Admin view "Overview": state, PM, Designer, Reviewer, blockers, revision count, final selection. | Suggested UI |
| P3-M-109 | M s10, p.7 | Suggested Admin view "Screens": list, content baseline, source, version, missing items. | Suggested UI |
| P3-M-110 | M s10, p.7 | Suggested Admin view "Theme Studio": theme cards, Figma link, preview, version, review status. | Suggested UI |
| P3-M-111 | M s10, p.7 | Suggested Admin view "Color Studio": palette cards/tokens, linked theme, status. | Suggested UI |
| P3-M-112 | M s10, p.7 | Suggested Admin view "Internal Review Queue": PASS / CHANGES REQUIRED + comments. | PASS / CHANGES REQUIRED |
| P3-M-113 | M s10, p.7 | Suggested Admin view "Admin Approval Queue": CONFIRM / EDIT + reason. | CONFIRM / EDIT |
| P3-M-114 | M s10, p.7 | Suggested Admin view "Client Review History": sent options, WhatsApp evidence, client reply. | WhatsApp |
| P3-M-115 | M s10, p.7 | Suggested Admin view "Revision Timeline": chronological design and approval trail. | Suggested UI |
| P3-M-116 | M s10, p.7 | Suggested Admin view "Final Direction": locked theme, palette, Figma version, confirmation. | Suggested UI |
| P3-M-117 | M s10, p.7 | Suggested Admin view "Phase 4 Handoff": validated handoff payload + readiness. | Suggested UI |
| P3-M-118 | M s10, p.7 | Suggested Admin view "Usage/Cost": calls/tokens/generation count/cost if supported. | Suggested UI |
| P3-M-119 | M s11, p.7 | Theme Option data contract fields: theme_option_id, project_id, phase3_version, name/title, description, design_direction_metadata, figma_file_reference, figma_node/page reference where applicable, preview_asset_refs, linked_color_option_ids, source_context_version, generation/revision origin, internal_review_status, admin_status, client_status, created_at/updated_at. | 17 fields |
| P3-M-120 | M s12, p.7 | Color Option data contract fields: color_option_id, theme_option_id, name, primary/secondary/accent/background/surface/text token metadata as applicable, brand/reference source, preview reference, version, review/admin/client status, created_at/updated_at. | 9 field groups |
| P3-M-121 | M s13, p.8 | Screen Definition contract: screen_id (stable project-specific id), name, scope_reference (approved requirement/quotation ref), description, required_sections (content baseline), key_actions (requirement-level), dependencies (other screens/data/client inputs), status, version, evidence (requirement/source refs). | status = DRAFT / REVIEW / FINALIZED / BLOCKED |
| P3-M-122 | M s14, p.8 | Phase 3 state machine: NOT_STARTED -> CONTEXT_LOADING -> SCREEN_DEFINITION -> THEME_GENERATION -> INTERNAL_REVIEW -> ADMIN_REVIEW -> CLIENT_REVIEW -> REVISION (if required) -> FINAL_CONFIRMATION -> LOCKED -> COMPLETED. | 11 states |
| P3-M-123 | M s14, p.8 | Theme Option state machine: DRAFT -> INTERNAL_REVIEW -> CHANGES_REQUIRED / INTERNAL_PASS -> ADMIN_REVIEW -> ADMIN_EDIT / ADMIN_APPROVED -> CLIENT_SHARED -> CLIENT_CHANGE / CLIENT_SELECTED -> LOCKED. | 11 states |
| P3-M-124 | M s14, p.8 | Screen Definition state machine: DRAFT -> REVIEW -> FINALIZED or BLOCKED. | DRAFT, REVIEW, FINALIZED, BLOCKED |
| P3-M-125 | M s15, p.8 | Event Phase2Completed: producer Phase 2; consumer Orchestrator/PM; action evaluate/start Phase 3. | Phase2Completed |
| P3-M-126 | M s15, p.8 | Event Phase3Started: producer Orchestrator; consumer PM/Design workflow; action initialize state. | Phase3Started |
| P3-M-127 | M s15, p.8 | Event ScreenListDrafted: producer Definition workflow; consumer Review/Designer; action persist/version. | ScreenListDrafted |
| P3-M-128 | M s15, p.8 | Event ScreenListFinalized: producer Workflow; consumer Designer; action open theme generation. | ScreenListFinalized |
| P3-M-129 | M s15, p.8 | Event ThemeOptionsGenerated: producer Figma Designer; consumer Internal Review; action review options. | ThemeOptionsGenerated |
| P3-M-130 | M s15, p.8 | Event InternalDesignPassed: producer Reviewer; consumer Admin; action create Admin approval task. | InternalDesignPassed |
| P3-M-131 | M s15, p.8 | Event AdminDesignEditRequested: producer Admin; consumer Designer; action revision. | AdminDesignEditRequested |
| P3-M-132 | M s15, p.8 | Event AdminDesignApproved: producer Admin; consumer PM; action prepare client share. | AdminDesignApproved |
| P3-M-133 | M s15, p.8 | Event DesignOptionsSharedToClient: producer PM; consumer Coordination; action track evidence. | DesignOptionsSharedToClient |
| P3-M-134 | M s15, p.8 | Event ClientDesignChangeRequested: producer PM/client; consumer Designer; action revision loop. | ClientDesignChangeRequested |
| P3-M-135 | M s15, p.8 | Event ClientDesignSelected: producer PM/client; consumer Workflow; action lock selection. | ClientDesignSelected |
| P3-M-136 | M s15, p.8 | Event Phase3Completed: producer Workflow; consumer Phase 4; action structured handoff. | Phase3Completed |
| P3-M-137 | M s15, p.8 | Event Phase4Ready: producer Coordination; consumer Phase 4; action start eligibility. | Phase4Ready |
| P3-M-138 | M s16, p.9 | Internal review happens before Admin review. | Gate order |
| P3-M-139 | M s16, p.9 | Admin approval happens before a client receives an option. | Gate order |
| P3-M-140 | M s16, p.9 | Admin EDIT always returns to Designer and then internal review before Admin again. | - |
| P3-M-141 | M s16, p.9 | Client-requested revision returns to Designer, then internal review, then Admin review, then PM/client. | - |
| P3-M-142 | M s16, p.9 | Client revision loop is limited to approx. 2-3 iterations under the locked business rule. | approx. 2-3 |
| P3-M-143 | M s16, p.9 | Revision counter and origin must be visible. | revision counter, origin |
| P3-M-144 | M s16, p.9 | Beyond allowed iterations, create human escalation rather than automatically continuing. | - |
| P3-M-145 | M s16, p.9 | Final selection cannot be overwritten silently; a later change creates a new version/change process. | - |
| P3-M-146 | M s17, p.9 | Every screen/theme direction must trace to approved project context. | - |
| P3-M-147 | M s17, p.9 | New client-requested functionality is not automatically a design revision. | - |
| P3-M-148 | M s17, p.9 | If feedback implies new scope, route to the appropriate requirement/scope/change workflow. | - |
| P3-M-149 | M s17, p.9 | Do not let Figma Designer invent functional requirements to make a screen look complete. | - |
| P3-M-150 | M s17, p.9 | Record design assumptions separately from approved requirements. | - |
| P3-M-151 | M s17, p.9 | Phase 3 does not perform full UI production or prototype coding. | - |
| P3-M-152 | M s18, p.9 | Cost control: same visual regenerated repeatedly -> hash/version input; reuse existing artifact if unchanged. | Cost risk/control |
| P3-M-153 | M s18, p.9 | Cost control: too many theme options -> hard/default policy of 2-3 meaningful directions. | "hard/default" (see OQ-05) |
| P3-M-154 | M s18, p.9 | Cost control: multiple agents doing same design -> single Figma Designer ownership + review agents only. | - |
| P3-M-155 | M s18, p.9 | Cost control: expensive model used for simple task -> route by complexity/capability. | - |
| P3-M-156 | M s18, p.9 | Cost control: retry causes new AI call -> idempotent job + artifact reuse. | - |
| P3-M-157 | M s18, p.9 | Cost control: image generation + Figma duplicate work -> use image generation only when it adds real value. | - |
| P3-M-158 | M s18, p.9 | Cost control: repeated context tokens -> use structured project context/version references. | - |
| P3-M-159 | M s18, p.9 | Cost control: untracked API spend -> phase/project/agent/task usage telemetry. | - |
| P3-M-160 | M s18, p.9 | Cost control: client endless revisions -> revision limit + escalation. | - |
| P3-M-161 | M s19, p.10 | Entity Phase3Workspace: project, status, PM, designer, reviewer, revision count, current version. | Entity |
| P3-M-162 | M s19, p.10 | Entity ScreenDefinition: screen contract fields + source/version/status. | Entity |
| P3-M-163 | M s19, p.10 | Entity ThemeOption: Figma/preview refs, metadata, version, statuses. | Entity |
| P3-M-164 | M s19, p.10 | Entity ColorOption: palette/tokens, linked theme, version/status. | Entity |
| P3-M-165 | M s19, p.10 | Entity DesignReview: artifact/version, reviewer, result, comments, evidence, timestamp. | Entity |
| P3-M-166 | M s19, p.10 | Entity AdminDesignDecision: artifact/version, confirm/edit, reason, admin, timestamp. | Entity |
| P3-M-167 | M s19, p.10 | Entity ClientDesignDecision: shared options, selected option, feedback, evidence, timestamp. | Entity |
| P3-M-168 | M s19, p.10 | Entity DesignRevision: from/to version, origin, requested changes, status. | Entity |
| P3-M-169 | M s19, p.10 | Entity Phase3Handoff: locked screens/theme/colors/Figma refs/approval evidence. | Entity |
| P3-M-170 | M s19, p.10 | Entity UsageRecord: project/phase/agent/task/provider/model/tokens/calls/cost if available. | Entity |
| P3-M-171 | M s19, p.10 | Entity AuditEvent: actor, action, entity/version, before/after, evidence, timestamp. | Entity |
| P3-M-172 | M s20, p.10 | Inspect existing Figma integration/provider capability before building. | - |
| P3-M-173 | M s20, p.10 | Use the official/supported integration method available to the system. | - |
| P3-M-174 | M s20, p.10 | Store stable file/page/node references instead of only screenshots. | - |
| P3-M-175 | M s20, p.10 | Store preview assets for Admin/client convenience. | - |
| P3-M-176 | M s20, p.10 | Do not expose sensitive Figma credentials in project data. | - |
| P3-M-177 | M s20, p.10 | Use idempotency/versioning for design-generation jobs. | - |
| P3-M-178 | M s20, p.10 | Preserve the final selected Figma version for Phase 4. | - |
| P3-M-179 | M s20, p.10 | If fully automated Figma creation is not supported by the chosen integration, expose the exact manual/assisted step instead of faking success. | - |
| P3-M-180 | M s21, p.10 | Only an authorized Admin can perform Admin approval/edit decisions. | RBAC |
| P3-M-181 | M s21, p.10 | Client selection is tied to verified project communication/evidence. | - |
| P3-M-182 | M s21, p.10 | Design artifacts are project/tenant isolated. | - |
| P3-M-183 | M s21, p.10 | Figma/provider credentials are stored securely. | - |
| P3-M-184 | M s21, p.10 | PM cannot silently mark Admin approval. | - |
| P3-M-185 | M s21, p.10 | Designer cannot mark client confirmation. | - |
| P3-M-186 | M s21, p.10 | Historical versions and decisions are auditable. | - |
| P3-M-187 | M s21, p.10 | Admin Panel APIs enforce server-side authorization. | - |
| P3-M-188 | M s21, p.10 | Sensitive internal prompts/model details are not client-visible. | - |
| P3-M-189 | M s22, p.11 | Failure: Phase 2 handoff incomplete -> block Phase 3 start and show missing context. | Failure table |
| P3-M-190 | M s22, p.11 | Failure: screen requirement ambiguous -> PM clarification; do not guess. | Failure table |
| P3-M-191 | M s22, p.11 | Failure: Figma generation fails -> retry safely; retain job state; no duplicate option. | Failure table |
| P3-M-192 | M s22, p.11 | Failure: internal review fails -> Designer revision -> re-review. | Failure table |
| P3-M-193 | M s22, p.11 | Failure: Admin requests edit -> structured edit -> Designer -> review -> Admin. | Failure table |
| P3-M-194 | M s22, p.11 | Failure: client asks for change -> revision loop with origin/evidence. | Failure table |
| P3-M-195 | M s22, p.11 | Failure: client adds new feature -> route to scope/change process. | Failure table |
| P3-M-196 | M s22, p.11 | Failure: revision limit exceeded -> human escalation. | Failure table |
| P3-M-197 | M s22, p.11 | Failure: Figma provider unavailable -> retry/fallback/manual assisted step per configured capability. | Failure table |
| P3-M-198 | M s22, p.11 | Failure: duplicate event/job -> return existing artifact/version idempotently. | Failure table |
| P3-M-199 | M s22, p.11 | Failure: cost threshold exceeded -> surface alert/policy action without corrupting workflow. | Failure table; threshold unspecified |
| P3-M-200 | M s22, p.11 | Failure: Phase 4 attempted early -> block until Phase 3 final selection/handoff is complete. | Failure table |
| P3-M-201 | M s23 P3-01, p.11 | Inspect Phase 2 handoff, project workspace, Project Planning output, Admin Panel, agent framework, Figma integration, files/assets, WhatsApp, events/jobs, approvals, audit and usage/cost tracking. | Plan item P3-01 |
| P3-M-202 | M s23 P3-01, p.11 | Create a requirement-to-code traceability / gap matrix. | Plan item P3-01 |
| P3-M-203 | M s23 P3-02, p.11 | Implement/extend Phase3Workspace, ScreenDefinition, ThemeOption, ColorOption, reviews, decisions, revisions and handoff. | Plan item P3-02 |
| P3-M-204 | M s23 P3-02, p.11 | Add validated transitions, versioning, uniqueness and idempotency. | Plan item P3-02 |
| P3-M-205 | M s23 P3-03, p.11 | Context reuse: load approved scope, project plan, brand assets, client references and prior decisions. | Plan item P3-03 |
| P3-M-206 | M s23 P3-03, p.11 | Build a missing/conflicting design-context resolver. | Plan item P3-03 |
| P3-M-207 | M s23 P3-04, p.11 | Build the screen list and screen-content baseline workflow; add source traceability, versioning, blockers and Admin visibility. | Plan item P3-04 |
| P3-M-208 | M s23 P3-05, p.11 | Figma Designer Agent: implement structured design brief input; create 2-3 theme directions and color options through the supported Figma workflow; persist canonical Figma references and previews. | Plan item P3-05 |
| P3-M-209 | M s23 P3-06, p.11 | Internal Review: implement review task/checklist and changes-required loop; require pass before Admin. | Plan item P3-06 |
| P3-M-210 | M s23 P3-07, p.11-12 | Admin Approval: build approval queue with previews/Figma references; implement CONFIRM/EDIT, reason, audit and revision routing. | Plan item P3-07 |
| P3-M-211 | M s23 P3-08, p.12 | PM/Client Review: PM shares only Admin-approved options; record exactly what was shared and the client feedback/selection evidence. | Plan item P3-08 |
| P3-M-212 | M s23 P3-09, p.12 | Revision Engine: implement client/admin revision origin, version history and the 2-3 iteration policy; escalate beyond limit. | Plan item P3-09 |
| P3-M-213 | M s23 P3-10, p.12 | Final Lock and Phase 4 Handoff: lock selected theme/color/Figma version and screen baseline; emit Phase3Completed/Phase4Ready with structured handoff. | Plan item P3-10 |
| P3-M-214 | M s23 P3-11, p.12 | Admin Project History: Phase 3 plus Project Planning Agent outputs visible from the project Admin workspace; preserve historical versions instead of overwriting. | Plan item P3-11 |
| P3-M-215 | M s23 P3-12, p.12 | Cost/Usage Controls: reuse unchanged artifacts/context; add generation/call/token/cost telemetry where available; prevent duplicate generation on retries and excessive variants. | Plan item P3-12 |
| P3-M-216 | M s23 P3-13, p.12 | Security/Observability/Recovery: implement RBAC, project isolation, audit, provider-secret handling, logs, retries and failed-job visibility. | Plan item P3-13 |
| P3-M-217 | M s23 P3-14, p.12 | Full QA and Production Readiness: run unit, integration, agent, Figma, event, Admin UI, approval, revision, security, recovery, regression and E2E tests; fix/retest until acceptance criteria pass. | Plan item P3-14 |
| P3-M-218 | M s24, p.13 | Preserve existing repository conventions when equivalent services already exist; suggested contracts follow. | - |
| P3-M-219 | M s24, p.13 | Suggested service signatures: startPhase3(projectId, idempotencyKey); getPhase3DesignContext(projectId); upsertScreenDefinitions(projectId, version, items); generateThemeDirections(projectId, contextVersion); submitInternalDesignReview(artifactId, version, decision); submitAdminDesignDecision(artifactId, version, decision, reason); recordClientDesignShare(projectId, optionIds, evidence); recordClientDesignDecision(projectId, payload); createDesignRevision(projectId, sourceVersion, request); lockPhase3Direction(projectId, themeId, colorId, figmaVersion); completePhase3(projectId); recordPhaseUsage(projectId, phase, agent, task, usage). | 12 signatures |
| P3-M-220 | M s25, p.13 | Client message "Phase 3 start": "Your project setup is complete. We are now starting the UI finalization stage. We will prepare design theme and color options for your review." | Template |
| P3-M-221 | M s25, p.13 | Client message "Theme selection": "We have prepared the UI theme options for your project. Please review them carefully and select the direction you prefer. You can also share a reference or color preference if you have one." | Template |
| P3-M-222 | M s25, p.13 | Client message "Revision": "We have updated the design based on your feedback. Please check the revised option carefully and let us know if anything else needs to be changed." | Template |
| P3-M-223 | M s25, p.13 | Client message "Final confirmation": "Please confirm the selected UI theme and color combination so we can proceed with the complete UI design in the next stage." | Template |
| P3-M-224 | M s25, p.13 | The four messages are configurable examples, not mandatory hard-coded wording. | Configurable |
| P3-M-225 | M s26, p.14 | QA area Phase entry: valid Phase 2 completion; duplicate start; incomplete handoff. | QA matrix |
| P3-M-226 | M s26, p.14 | QA area Context reuse: project plan/scope reused; no unnecessary client repeat. | QA matrix |
| P3-M-227 | M s26, p.14 | QA area Screens: complete list; source mapping; missing/ambiguous; versioning. | QA matrix |
| P3-M-228 | M s26, p.14 | QA area Theme generation: 2-3 options; distinct; Figma refs; retry idempotency. | QA matrix |
| P3-M-229 | M s26, p.14 | QA area Colors: 2-3 appropriate combinations; linked theme; token persistence. | QA matrix |
| P3-M-230 | M s26, p.14 | QA area Internal review: pass/fail; designer revision loop. | QA matrix |
| P3-M-231 | M s26, p.14 | QA area Admin: confirm/edit; permissions; evidence; re-review. | QA matrix |
| P3-M-232 | M s26, p.14 | QA area Client: only Admin-approved options shared; selection/change evidence. | QA matrix |
| P3-M-233 | M s26, p.14 | QA area Revision: Admin/client origin; versioning; 2-3 loop; escalation. | QA matrix |
| P3-M-234 | M s26, p.14 | QA area Scope protection: new feature does not silently become a design revision. | QA matrix |
| P3-M-235 | M s26, p.14 | QA area Final lock: theme/color/Figma version immutable via silent overwrite. | QA matrix |
| P3-M-236 | M s26, p.14 | QA area Admin history: all samples, reviews, decisions and final selection visible. | QA matrix |
| P3-M-237 | M s26, p.14 | QA area Project plan visibility: planning blueprint accessible in project Admin view. | QA matrix |
| P3-M-238 | M s26, p.14 | QA area Cost controls: no duplicate generation; usage recorded; artifact reuse. | QA matrix |
| P3-M-239 | M s26, p.14 | QA area Security: RBAC, tenant/project isolation, secret handling. | QA matrix |
| P3-M-240 | M s26, p.14 | QA area Recovery: provider failure, worker crash, replay, duplicate event. | QA matrix |
| P3-M-241 | M s26, p.14 | QA area Phase 4 gate: cannot start before Phase3Completed/Phase4Ready. | QA matrix |
| P3-M-242 | M s27, p.14 | Mandatory E2E scenario (19 steps): start from completed Phase 2 project; PM announcement recorded; scope/project plan loaded; complete screen list created and finalized; screen content baseline created; Figma Designer creates 2-3 theme directions; color combinations linked; internal review finds one issue, Designer fixes, review passes; Admin requests one edit, Designer revises, internal review passes, Admin confirms; PM shares only approved options; Admin Panel records exactly which options were sent; client requests one change; revision marked client-originated; Designer revises -> internal review -> Admin approval -> PM re-share; client selects final theme/color; confirmation evidence stored; final Figma version locked; Phase 3 handoff generated; Phase 4 eligibility opens; historical options/revisions remain viewable. | E2E; 1 internal issue, 1 admin edit, 1 client change |
| P3-M-243 | M s28, p.15 | Definition of Done (22 items): every locked requirement mapped to implementation/test evidence; Phase 2 -> Phase 3 handoff works; PM Phase 3 communication works; Project Planning output reused and visible; screen list complete, versioned, traceable; screen-by-screen content baseline complete; Figma canonical; 2-3 theme directions supported; 2-3 color combinations supported as applicable; internal review gate works; Admin CONFIRM/EDIT gate works; only Admin-approved options reach client; client selection/change loop works; client revisions get internal + Admin review before re-sharing; revision limit/escalation works; final theme/color/Figma version locked; Admin Panel shows all generated/sent/finalized UI details and history; historical data preserved; cost/reuse controls prevent obvious duplicate generation; Phase 4 handoff structured and validated; permissions, audit, isolation, idempotency and recovery tests pass; no unresolved P0/P1 Phase 3 workflow defects. | P0/P1 undefined (see OQ-23) |
| P3-M-244 | M s29A, p.15 | Master checklist A Discovery & Context: read locked requirements; inspect existing code; inspect Figma capability; inspect Admin Panel; inspect Project Planning output; create gap matrix. | Checklist A |
| P3-M-245 | M s29B, p.15 | Checklist B Domain: Phase3Workspace; ScreenDefinition; ThemeOption; ColorOption; Reviews; Admin decisions; Client decisions; Revisions; Handoff; Usage record; Audit. | Checklist B |
| P3-M-246 | M s29C, p.15-16 | Checklist C Screen Finalization: scope mapping; complete screen list; screen content; missing info; versioning; Admin visibility. | Checklist C |
| P3-M-247 | M s29D, p.16 | Checklist D Design: Figma canonical source; 2-3 themes; color options; previews; Figma refs; artifact reuse; no duplicate generation. | Checklist D |
| P3-M-248 | M s29E, p.16 | Checklist E Reviews: internal review; changes required; Admin queue; confirm/edit; Designer loop; audit. | Checklist E |
| P3-M-249 | M s29F, p.16 | Checklist F Client: PM share; sent-option evidence; selection; reference input; change request; revision; final confirmation. | Checklist F |
| P3-M-250 | M s29G, p.16 | Checklist G Revision Governance: origin; version; count; 2-3 limit; escalation; historical preservation. | Checklist G |
| P3-M-251 | M s29H, p.16 | Checklist H Admin Panel: overview; screens; themes; colors; reviews; client history; final selection; project plan; Phase 4 handoff; cost/usage. | Checklist H |
| P3-M-252 | M s29I, p.17 | Checklist I Cost Controls: reuse context; reuse assets; cache artifacts; model routing; idempotency; usage telemetry; variant limits. | Checklist I |
| P3-M-253 | M s29J, p.17 | Checklist J Security & Reliability: RBAC; isolation; secrets; audit; retries; recovery; failed jobs; illegal-state blocks. | Checklist J |
| P3-M-254 | M s29K, p.17 | Checklist K QA: unit; integration; agent; Figma; Admin UI; E2E; negative; regression; security; recovery; Phase 4 gate. | Checklist K |
| P3-M-255 | M s30, p.18 | Execution protocol order: DISCOVER EXISTING IMPLEMENTATION -> READ/MAP PHASE 3 REQUIREMENTS -> REUSE EXISTING PROJECT/ADMIN/AGENT/Figma INFRASTRUCTURE -> IMPLEMENT ONE GAP -> TEST -> VERIFY -> UPDATE TRACEABILITY -> NEXT GAP -> FULL E2E -> COST REVIEW -> SECURITY REVIEW -> PRODUCTION READINESS. | Protocol |
| P3-M-256 | M s30, p.18 | Prohibitions: do not rewrite working Phase 1/2 foundations unnecessarily; do not create duplicate design workflows if an existing one can be extended; do not create separate agents for work already owned by PM/Designer/Reviewer; do not fake Figma automation unsupported by the configured integration; do not regenerate unchanged theme artifacts on retries; do not send unapproved design options to client; do not silently exceed revision policy; do not silently change scope; do not overwrite history. | 9 prohibitions |
| P3-M-257 | M s30, p.18 | Do not mark a requirement complete until implementation + integration + tests + evidence exist. | Completion gate |
| P3-M-258 | M s30, p.18 | Final report must list changed files, migrations, events/APIs, tests, manual Figma/provider setup, remaining limitations and Phase 4 readiness. | Final report contents |
| P3-M-259 | M s31, p.18 | Final locked flow: PHASE 2 COMPLETE -> PM ANNOUNCES UI FINALIZATION -> LOAD APPROVED SCOPE + PROJECT PLANNING CONTEXT -> FINALIZE SCREEN LIST -> FINALIZE SCREEN CONTENT -> FIGMA DESIGNER CREATES 2-3 UI THEMES + APPROPRIATE COLOR OPTIONS -> INTERNAL REVIEW -> ADMIN CONFIRM/EDIT -> PM SHARES ADMIN-APPROVED OPTIONS -> CLIENT SELECTS / REQUESTS CHANGE -> DESIGNER REVISION -> INTERNAL REVIEW -> ADMIN REVIEW -> PM RE-SHARE -> MAX APPROX. 2-3 CLIENT REVISION LOOPS -> CLIENT FINAL CONFIRMATION -> LOCK THEME + COLOR + FIGMA VERSION -> RECORD COMPLETE HISTORY IN ADMIN PANEL -> PHASE 3 COMPLETE -> PHASE 4 READY. | max approx. 2-3 client revision loops |
| P3-M-260 | M s31, p.18 | Locked principles: Figma is canonical; reuse before regeneration; Admin sees the full project/design history; internal review precedes Admin; Admin precedes client; client-approved theme + color is the final output, not a full UI prototype. | Principles |

---

## Part 2. PM Agent specification (P3-PM)

| ID | Source (section, page) | Requirement | Named state / event / role / field / number |
|---|---|---|---|
| P3-PM-01 | PM cover, p.1 | PM Agent is the primary client-facing coordination owner for UI theme + color finalization; the baseline is locked. Works with Figma Designer Agent, Internal Design Reviewer, Admin, Orchestrator/Coordination; canonical design source is Figma. | Status LOCKED PHASE 3 PM RESPONSIBILITY BASELINE |
| P3-PM-02 | PM cover, p.1 | Final PM outcome: client-approved theme + color + confirmation evidence + Phase 4 handoff readiness. | Outcome |
| P3-PM-03 | PM s1, p.2 | PM is the single client-facing operational bridge: it translates backend design progress into simple client communication, shares only approved options, captures client selection/change requests, and ensures final confirmation is recorded before Phase 4 begins. | - |
| P3-PM-04 | PM s1, p.2 | Core boundary: PM coordinates and communicates; PM does not design the UI, perform internal design QA, approve on behalf of Admin, or silently change scope. | Boundary |
| P3-PM-05 | PM s1, p.2 | The client experiences one clean flow: AgencyOS prepares options internally, Admin approves, PM shares, client selects or requests changes, PM carries feedback back into the controlled design workflow. | - |
| P3-PM-06 | PM s2, p.2 | Start condition: Phase 2 complete. | - |
| P3-PM-07 | PM s2, p.2 | Start condition: official project kickoff already occurred. | - |
| P3-PM-08 | PM s2, p.2 | Start condition: accepted scope and requirements available. | - |
| P3-PM-09 | PM s2, p.2 | Start condition: Project Planning Agent output available in project context. | - |
| P3-PM-10 | PM s2, p.2 | Start condition: PM Agent assigned to the project. | - |
| P3-PM-11 | PM s2, p.2 | Start condition: Phase 3 workflow not already active for the same version/idempotency key. | idempotency key |
| P3-PM-12 | PM s2, p.2 | Start condition: prior-phase design context reusable without asking the client to repeat confirmed information. | - |
| P3-PM-13 | PM s3, p.2 | PM inputs: approved scope and requirements; finalized/working screen list and screen-content baseline; Project Planning Agent operational blueprint; client brand assets and confirmed preferences; prior client references and decisions; Figma theme options and color combinations after internal review/Admin approval; Admin decision status; revision count/history; client messages/feedback/confirmation evidence; Phase 3 state and readiness data. | 10 inputs |
| P3-PM-14 | PM s4.1, p.3 | After Phase 2 completes, send a short client-facing message that UI Finalization has started. | Announcement |
| P3-PM-15 | PM s4.1, p.3 | Do not expose internal AI/model/provider details. | - |
| P3-PM-16 | PM s4.1, p.3 | Record message delivery/evidence and trigger/confirm the Phase 3 workflow state. | - |
| P3-PM-17 | PM s4.2, p.3 | Use existing Phase 1/2/project-plan context before asking the client anything. | - |
| P3-PM-18 | PM s4.2, p.3 | Only request genuinely missing or conflicting design information. | - |
| P3-PM-19 | PM s4.2, p.3 | Do not re-ask confirmed brand/theme/reference preferences unnecessarily. | - |
| P3-PM-20 | PM s4.2, p.3 | Keep client communication simple and non-technical. | - |
| P3-PM-21 | PM s4.3, p.3 | On a structured clarification request from backend/Figma Designer about a screen/content ambiguity: translate it into a concise client question. | ScreenClarificationRequired |
| P3-PM-22 | PM s4.3, p.3 | Store the client's answer as structured evidence and return it to the appropriate design workflow. | - |
| P3-PM-23 | PM s4.3, p.3 | Do not invent missing screen functionality. | - |
| P3-PM-24 | PM s4.4, p.3 | Wait until internal design review passes and Admin approves before sharing. | Share gate |
| P3-PM-25 | PM s4.4, p.3 | Share only Admin-approved theme/color options with the client. | - |
| P3-PM-26 | PM s4.4, p.3 | Record exactly which options/versions were shared and when. | - |
| P3-PM-27 | PM s4.4, p.3 | Do not send drafts or rejected options to the client. | - |
| P3-PM-28 | PM s4.5, p.3 | Ask the client to select a preferred UI theme and color direction. | - |
| P3-PM-29 | PM s4.5, p.3 | Allow the client to share their own reference/theme/color preference. | - |
| P3-PM-30 | PM s4.5, p.3 | Capture selected option IDs, comments, reference attachments and source message evidence. | - |
| P3-PM-31 | PM s4.5, p.3 | Do not treat ambiguous feedback as final approval. | - |
| P3-PM-32 | PM s4.6, p.3 | Record exact requested changes. | - |
| P3-PM-33 | PM s4.6, p.3 | Identify whether feedback is a design revision or appears to be new scope/functionality. | - |
| P3-PM-34 | PM s4.6, p.3 | Route genuine design revisions to the Designer workflow. | - |
| P3-PM-35 | PM s4.6, p.3 | Route new/out-of-scope requirements to the appropriate scope/change process rather than silently adding them. | - |
| P3-PM-36 | PM s4.6, p.3 | Track client revision count. | revision count |
| P3-PM-37 | PM s4.7, p.3 | After Designer revision + internal review + Admin approval, re-share the approved revision with the client. | - |
| P3-PM-38 | PM s4.7, p.3 | Clearly tell the client that the requested updates are ready. | - |
| P3-PM-39 | PM s4.7, p.3 | Ask the client to review carefully and identify anything else that must change. | - |
| P3-PM-40 | PM s4.7, p.3 | Repeat within the locked approx. 2-3 client revision limit. | approx. 2-3 |
| P3-PM-41 | PM s4.8, p.3-4 | When the configured revision limit is reached/exceeded, do not continue an endless generation loop. | "reached/exceeded" (see C-12) |
| P3-PM-42 | PM s4.8, p.3-4 | Create a human escalation carrying revision history, client requests and current state. | - |
| P3-PM-43 | PM s4.8, p.4 | Wait for a governed decision on continuation/scope/commercial handling. | - |
| P3-PM-44 | PM s4.9, p.4 | Obtain explicit client confirmation of the selected theme + color combination. | - |
| P3-PM-45 | PM s4.9, p.4 | Store confirmation evidence, selected option IDs and Figma version. | - |
| P3-PM-46 | PM s4.9, p.4 | Ensure the final selection is locked in backend state. | - |
| P3-PM-47 | PM s4.9, p.4 | Do not rely on an informal assumption that the client "seems okay". | - |
| P3-PM-48 | PM s4.10, p.4 | Verify final confirmation exists and required Phase 3 outputs are ready. | - |
| P3-PM-49 | PM s4.10, p.4 | Trigger/record Phase 3 completion according to workflow policy. | - |
| P3-PM-50 | PM s4.10, p.4 | Ensure Phase 4 receives the locked screen baseline, selected theme, color combination, Figma references and approval evidence. | - |
| P3-PM-51 | PM s4.10, p.4 | The client should not need to reselect the visual direction in Phase 4. | - |
| P3-PM-52 | PM s5, p.5 | PM must not create Figma designs itself as the responsible design role. | Prohibition 1 |
| P3-PM-53 | PM s5, p.5 | PM must not bypass the Figma Designer Agent. | Prohibition 2 |
| P3-PM-54 | PM s5, p.5 | PM must not perform the internal design review on behalf of the reviewer. | Prohibition 3 |
| P3-PM-55 | PM s5, p.5 | PM must not mark Admin approval without Admin action/evidence. | Prohibition 4 |
| P3-PM-56 | PM s5, p.5 | PM must not share unapproved draft designs with the client. | Prohibition 5 |
| P3-PM-57 | PM s5, p.5 | PM must not silently alter the screen list or approved functional scope. | Prohibition 6 |
| P3-PM-58 | PM s5, p.5 | PM must not convert new functionality into a normal design revision. | Prohibition 7 |
| P3-PM-59 | PM s5, p.5 | PM must not exceed the configured client revision policy automatically. | Prohibition 8 |
| P3-PM-60 | PM s5, p.5 | PM must not overwrite old design versions/history. | Prohibition 9 |
| P3-PM-61 | PM s5, p.5 | PM must not expose internal AI model/provider/API details to the client. | Prohibition 10 |
| P3-PM-62 | PM s5, p.5 | PM must not promise a design change is complete before backend status confirms it. | Prohibition 11 |
| P3-PM-63 | PM s5, p.5 | PM must not mark final client approval without explicit evidence. | Prohibition 12 |
| P3-PM-64 | PM s5, p.5 | PM must not start Phase 4 before the Phase 3 completion gate passes. | Prohibition 13 |
| P3-PM-65 | PM s6 PM3-01, p.5 | Receive Phase 3 start: consume Phase2Completed/Phase3Started; validate project/context references; load latest project plan and design context. | PM3-01; Phase2Completed, Phase3Started |
| P3-PM-66 | PM s6 PM3-02, p.5 | Announce UI Finalization: send the configured short client message; record delivery evidence; do not overload the client with internal workflow details. | PM3-02 |
| P3-PM-67 | PM s6 PM3-03, p.5 | Monitor screen baseline: track screen-list/content finalization; handle only client clarifications routed to PM; do not independently design screen structure. | PM3-03 |
| P3-PM-68 | PM s6 PM3-04, p.5 | Wait for internal + Admin approval: do not share theme options until InternalDesignPassed and AdminDesignApproved are both true; surface blockers in Admin Panel. | PM3-04; InternalDesignPassed AND AdminDesignApproved |
| P3-PM-69 | PM s6 PM3-05, p.5 | Share approved options: send theme/color options through the official project communication channel; include clear labels/references so selection maps to exact option IDs; record a shared-option snapshot. | PM3-05 |
| P3-PM-70 | PM s6 PM3-06, p.5 | Collect client decision: capture SELECT / CHANGE REQUEST / CLIENT REFERENCE; normalize free-form response into a structured design-decision record; preserve the original message/evidence. | PM3-06 |
| P3-PM-71 | PM s6 PM3-07, p.5-6 | Route changes: design revision -> structured revision request; scope change -> scope/change workflow; do not mix the two. | PM3-07 |
| P3-PM-72 | PM s6 PM3-08, p.6 | Re-share revised design: wait for Designer -> Internal Review -> Admin approval; share the approved revision; increment and display the client revision count. | PM3-08 |
| P3-PM-73 | PM s6 PM3-09, p.6 | Final confirmation: obtain explicit final confirmation; link it to selected theme ID, color ID and Figma version; lock the client decision. | PM3-09 |
| P3-PM-74 | PM s6 PM3-10, p.6 | Complete Phase 3: validate handoff readiness; record Phase3Completed / Phase4Ready; preserve all history in Admin Panel. | PM3-10 |
| P3-PM-75 | PM s7, p.7 | Mandatory gate order: FIGMA DESIGNER -> INTERNAL REVIEW -> ADMIN REVIEW -> PM -> CLIENT; PM may not collapse or skip gates to speed up communication. | Gate order |
| P3-PM-76 | PM s7, p.7 | Stage ownership table: Design creation (Figma Designer; PM monitors status only); Internal review (Internal Design Reviewer; PM waits, handles clarification if routed); Admin review (Admin; PM waits for CONFIRM/EDIT); Client share (PM; share only Admin-approved option/version); Client feedback (Client via PM; capture, structure and route); Final confirmation (Client via PM; store explicit confirmation evidence). | 6 stages |
| P3-PM-77 | PM s8, p.7 | Admin EDIT decision must include structured reason/comments. | Admin EDIT loop |
| P3-PM-78 | PM s8, p.7 | PM does not directly edit the design; Designer revises; internal review runs again; Admin reviews again. | Admin EDIT loop |
| P3-PM-79 | PM s8, p.7 | Only after Admin approval may PM share the revised option with the client; all versions and decisions remain visible in the Admin Panel. | Admin EDIT loop |
| P3-PM-80 | PM s9, p.7 | Client revision loop: CLIENT CHANGE REQUEST -> PM CAPTURES REQUEST -> DESIGNER REVISION -> INTERNAL REVIEW -> ADMIN REVIEW -> PM RE-SHARE -> CLIENT REVIEW. | Loop |
| P3-PM-81 | PM s9, p.7 | Revision origin is marked CLIENT. | origin = CLIENT |
| P3-PM-82 | PM s9, p.7 | Revision count is incremented only for client-requested rounds (Admin EDIT rounds are not counted). | counted: client only |
| P3-PM-83 | PM s9, p.7 | Approx. 2-3 client revision rounds are allowed under the locked flow. | approx. 2-3 |
| P3-PM-84 | PM s9, p.7 | After each revision PM asks the client to check the updated design carefully. | - |
| P3-PM-85 | PM s9, p.7 | Beyond allowed rounds PM triggers escalation instead of endless design generation. | - |
| P3-PM-86 | PM s10, p.8 | Use simple English / Hinglish-ready configurable templates. | English, Hinglish |
| P3-PM-87 | PM s10, p.8 | Keep messages short and action-oriented; tell the client exactly what must be reviewed or selected. | - |
| P3-PM-88 | PM s10, p.8 | Never mention internal AI provider/model/API routing; do not expose raw internal prompts/reasoning. | - |
| P3-PM-89 | PM s10, p.8 | Do not claim a revision is ready before approved backend state; do not present rejected/internal-only designs. | - |
| P3-PM-90 | PM s10, p.8 | Do not create pressure; request clear selection/feedback. | - |
| P3-PM-91 | PM s10, p.8 | Use actual backend state for progress updates; preserve official communication evidence. | - |
| P3-PM-92 | PM s11, p.8 | Template "Phase 3 start": "Your project setup is complete. We are now starting the UI finalization stage. We will prepare UI theme and color options for your review." | Template |
| P3-PM-93 | PM s11, p.8 | Template "Theme review": "We have prepared the UI options for your project. Please review them carefully and let us know which theme and color direction you prefer. You can also share a reference if you have one." | Template |
| P3-PM-94 | PM s11, p.8 | Template "Revision ready": "We have updated the design based on your feedback. Please check the revised option carefully and let us know if anything else needs to be changed." | Template |
| P3-PM-95 | PM s11, p.8 | Template "Final confirmation": "Please confirm the selected UI theme and color combination so we can proceed with the complete UI design in the next stage." | Template |
| P3-PM-96 | PM s11, p.8 | Templates must remain configurable; examples, not hard-coded mandatory wording. | Configurable |
| P3-PM-97 | PM s12, p.8 | Classification: client selects option -> CLIENT_SELECTED -> validate exact theme/color IDs. | CLIENT_SELECTED |
| P3-PM-98 | PM s12, p.8 | Classification: client requests visual change -> DESIGN_CHANGE_REQUEST -> create revision request. | DESIGN_CHANGE_REQUEST |
| P3-PM-99 | PM s12, p.8 | Classification: client shares own reference -> CLIENT_REFERENCE -> attach reference -> Designer review. | CLIENT_REFERENCE |
| P3-PM-100 | PM s12, p.8 | Classification: client asks for new feature -> POSSIBLE_SCOPE_CHANGE -> route scope/change process. | POSSIBLE_SCOPE_CHANGE |
| P3-PM-101 | PM s12, p.8 | Classification: response unclear -> CLARIFICATION_REQUIRED -> PM asks precise follow-up. | CLARIFICATION_REQUIRED |
| P3-PM-102 | PM s12, p.8 | Classification: client confirms final -> FINAL_CONFIRMED -> lock selection and prepare Phase 4 handoff. | FINAL_CONFIRMED |
| P3-PM-103 | PM s13, p.9 | PM operates from the same project history visible to Admin; Phase 3 communication must not live only in chat history. | - |
| P3-PM-104 | PM s13, p.9 | Admin Panel PM surfaces: Phase 3 Overview (state, owner, blockers, revision count); Screen Baseline (finalized list/content for communication context); Theme Options (exact options + version + Figma refs + review/admin status); Color Options (exact palettes linked to theme); Client Share History (what PM sent, when, channel, version); Client Feedback (original evidence + structured decision); Revision Timeline (client/Admin origin, requested changes, version); Final Selection (theme ID + color ID + Figma version + confirmation); Project Plan (operational blueprint/context); Phase 4 Handoff (readiness and payload status, row clipped in PDF). | 10 surfaces |
| P3-PM-105 | PM s13, p.9 | Locked principle: all important phase activities, history, outputs and decisions are visible in Admin Panel, including which samples were sent to the client and what the client finalized. | - |
| P3-PM-106 | PM s14, p.9 | PM data/evidence contract fields: project_id, phase3_workspace_id, communication_id, channel, message/template version, shared theme_option_ids, shared color_option_ids, shared Figma/preview version references, delivery status/timestamp, client response source evidence, structured decision type, selected option IDs, revision request ID, revision count, final confirmation evidence, phase completion/handoff reference. | 16 fields |
| P3-PM-107 | PM s15, p.10 | PM state model: ASSIGNED -> PHASE3_ANNOUNCED -> WAITING_DESIGN -> WAITING_INTERNAL_REVIEW -> WAITING_ADMIN -> CLIENT_REVIEW -> WAITING_CLIENT / REVISION_COORDINATION -> FINAL_CONFIRMATION -> PHASE3_COMPLETE. | 10 states |
| P3-PM-108 | PM s15, p.10 | PM may move between waiting states multiple times; waiting is not failure; every wait must show owner, reason, next action and timestamp. | wait fields: owner, reason, next action, timestamp |
| P3-PM-109 | PM s16, p.10 | PM consumes Phase3Started (announce Phase 3/start communication). | Event, Consume |
| P3-PM-110 | PM s16, p.10 | PM consumes ScreenClarificationRequired (ask client only if needed). | Event, Consume |
| P3-PM-111 | PM s16, p.10 | PM consumes InternalDesignPassed (wait for Admin approval). | Event, Consume |
| P3-PM-112 | PM s16, p.10 | PM consumes AdminDesignApproved (prepare/share client options). | Event, Consume |
| P3-PM-113 | PM s16, p.10 | PM consumes AdminDesignEditRequested (do not share; wait for revision). | Event, Consume |
| P3-PM-114 | PM s16, p.10 | PM produces DesignOptionsSharedToClient (store exact shared snapshot/evidence). | Event, Produce |
| P3-PM-115 | PM s16, p.10 | PM produces ClientDesignChangeRequested (create structured revision). | Event, Produce |
| P3-PM-116 | PM s16, p.10 | PM produces ClientReferenceReceived (attach and route to design workflow). | Event, Produce |
| P3-PM-117 | PM s16, p.10 | PM produces ClientDesignSelected (store selected option). | Event, Produce |
| P3-PM-118 | PM s16, p.10 | PM produces ClientFinalDesignConfirmed (lock explicit confirmation evidence). | Event, Produce |
| P3-PM-119 | PM s16, p.10 | Phase3Completed: PM produces/consumes per policy (complete PM Phase 3 tasks). | Event |
| P3-PM-120 | PM s16, p.10 | Phase4Ready: PM consumes/produces per architecture (handoff readiness; row clipped in PDF). | Event |
| P3-PM-121 | PM s17, p.10 | Do not request unnecessary additional design options once 2-3 meaningful options exist. | 2-3 |
| P3-PM-122 | PM s17, p.10 | Do not trigger regeneration merely because the same message/job was retried. | - |
| P3-PM-123 | PM s17, p.10 | Reuse previously shared approved assets/links when unchanged. | - |
| P3-PM-124 | PM s17, p.10 | Do not send client feedback to multiple design agents for duplicate independent work. | - |
| P3-PM-125 | PM s17, p.10 | Bundle related client feedback into a structured revision request where appropriate. | - |
| P3-PM-126 | PM s17, p.10 | Track revision count so endless changes do not create uncontrolled design/API cost. | - |
| P3-PM-127 | PM s17, p.10 | Use existing project context instead of repeatedly asking/reprocessing the same information. | - |
| P3-PM-128 | PM s17, p.10 | Surface abnormal repeated generation/revision patterns to Admin. | - |
| P3-PM-129 | PM s18, p.11 | PM distinguishes visual revision from new functionality. | - |
| P3-PM-130 | PM s18, p.11 | A new screen/feature not present in approved scope is flagged. | - |
| P3-PM-131 | PM s18, p.11 | An out-of-scope request is not silently passed to the Designer as normal feedback. | - |
| P3-PM-132 | PM s18, p.11 | The client can still explain the request; PM records it accurately. | - |
| P3-PM-133 | PM s18, p.11 | The appropriate requirement/scope/change workflow decides commercial and delivery treatment. | - |
| P3-PM-134 | PM s18, p.11 | Existing Phase 3 finalization continues only according to governed decision. | - |
| P3-PM-135 | PM s19, p.11 | PM permissions: can read project-scoped approved design/context information; can create client communication and feedback records. | RBAC |
| P3-PM-136 | PM s19, p.11 | PM cannot perform Admin approval action; cannot alter reviewer result; cannot silently change the locked selected design; cannot access other client/project data. | RBAC |
| P3-PM-137 | PM s19, p.11 | Client attachments/references follow project-scoped secure storage. | - |
| P3-PM-138 | PM s19, p.11 | Figma/provider secrets are not exposed to PM chat/client messages. | - |
| P3-PM-139 | PM s19, p.11 | All PM state-changing actions are audited. | - |
| P3-PM-140 | PM s20, p.11 | Failure: Phase 2 handoff incomplete -> do not announce/advance; surface blocker. | Failure table |
| P3-PM-141 | PM s20, p.11 | Failure: design clarification needed -> ask concise client question; store answer. | Failure table |
| P3-PM-142 | PM s20, p.11 | Failure: internal review failed -> do not share; wait for Designer revision. | Failure table |
| P3-PM-143 | PM s20, p.11 | Failure: Admin edit requested -> do not share; track internal revision. | Failure table |
| P3-PM-144 | PM s20, p.11 | Failure: client no response -> WAITING_CLIENT + policy-based follow-up. | WAITING_CLIENT; follow-up policy unspecified |
| P3-PM-145 | PM s20, p.11 | Failure: client feedback ambiguous -> clarify before routing. | Failure table |
| P3-PM-146 | PM s20, p.11 | Failure: client asks new feature -> route scope/change process. | Failure table |
| P3-PM-147 | PM s20, p.11 | Failure: revision limit reached -> escalate for human decision. | Failure table |
| P3-PM-148 | PM s20, p.11 | Failure: shared link/file fails -> retry communication safely; preserve same version. | Failure table |
| P3-PM-149 | PM s20, p.11 | Failure: duplicate message/job -> do not create a new revision/share record unnecessarily. | Failure table |
| P3-PM-150 | PM s20, p.11 | Failure: client says final but option unclear -> ask exact confirmation. | Failure table |
| P3-PM-151 | PM s20, p.11 | Failure: Phase 4 attempted early -> block until final confirmation + Phase 3 completion. | Failure table |
| P3-PM-152 | PM s21 PM3-I01, p.12 | Existing code discovery: locate PM framework, Phase 2 handoff, project state, Figma/design workflow, Admin approvals, communication adapters, project history, events/jobs and audit; create requirement-to-code traceability matrix. | Plan item |
| P3-PM-153 | PM s21 PM3-I02, p.12 | PM Phase 3 domain contract: define PM Phase 3 state, client design decision types, share records, revision coordination records and final confirmation evidence; add idempotency and transition guards. | Plan item |
| P3-PM-154 | PM s21 PM3-I03, p.12 | Context loader: load approved scope/project plan/design context; prevent repetitive client questions. | Plan item |
| P3-PM-155 | PM s21 PM3-I04, p.12 | Phase 3 announcement: configurable start template, delivery tracking and evidence. | Plan item |
| P3-PM-156 | PM s21 PM3-I05, p.12 | Clarification coordination: consume screen/design clarification events; create client question/response mapping. | Plan item |
| P3-PM-157 | PM s21 PM3-I06, p.12 | Admin-approved share gate: deterministic check requiring internal pass + Admin approval before PM share; block drafts/rejected versions. | Plan item |
| P3-PM-158 | PM s21 PM3-I07, p.12 | Client decision intake: parse/store SELECT, DESIGN CHANGE, REFERENCE, POSSIBLE SCOPE CHANGE, FINAL CONFIRMATION; preserve raw source evidence. | Plan item |
| P3-PM-159 | PM s21 PM3-I08, p.12 | Revision coordination: create structured client revision request; track origin/count/version; wait Designer -> review -> Admin before re-share. | Plan item |
| P3-PM-160 | PM s21 PM3-I09, p.12 | Revision limit and escalation: implement approx. 2-3 client revision policy as a configurable workflow rule; create human escalation beyond limit. | Plan item; configurable |
| P3-PM-161 | PM s21 PM3-I10, p.12 | Final lock and handoff: link selected theme/color/Figma version to final confirmation; trigger Phase 3 completion readiness and Phase 4 handoff. | Plan item |
| P3-PM-162 | PM s21 PM3-I11, p.12 | Admin history integration: all PM shares, feedback, decisions and confirmation visible chronologically in the project Admin workspace. | Plan item |
| P3-PM-163 | PM s21 PM3-I12, p.12 | Cost/idempotency controls: prevent duplicate communication/revision/generation triggers; reuse unchanged artifact references. | Plan item |
| P3-PM-164 | PM s21 PM3-I13, p.13 | QA/observability/security: add logs, audit, RBAC, tenant isolation, retries and PM workflow dashboards; run full negative and E2E coverage. | Plan item |
| P3-PM-165 | PM s22, p.14 | Suggested PM service signatures (use existing repo conventions if equivalent exist): announcePhase3Start(projectId); getPMPhase3Context(projectId); recordDesignShare(projectId, optionIds, evidence); recordClientDesignResponse(projectId, payload); createClientDesignRevision(projectId, version, request); attachClientDesignReference(projectId, fileRef, note); escalateDesignRevisionLimit(projectId); recordFinalDesignConfirmation(projectId, themeId, colorId, figmaVersion, evidence); evaluatePhase3PMReadiness(projectId); completePhase3PMHandoff(projectId). | 10 signatures |
| P3-PM-166 | PM s23, p.14 | QA: Phase start (valid Phase2 completion; duplicate event; incomplete context). | QA matrix |
| P3-PM-167 | PM s23, p.14 | QA: Announcement (correct message; delivery evidence; no duplicate). | QA matrix |
| P3-PM-168 | PM s23, p.14 | QA: Context reuse (known data reused; only missing ambiguity asked). | QA matrix |
| P3-PM-169 | PM s23, p.14 | QA: Share gate (cannot share before internal + Admin approval). | QA matrix |
| P3-PM-170 | PM s23, p.14 | QA: Option mapping (shared option IDs/version exactly match approved artifact). | QA matrix |
| P3-PM-171 | PM s23, p.14 | QA: Client select (exact selection captured). | QA matrix |
| P3-PM-172 | PM s23, p.14 | QA: Client change (revision created with source/evidence). | QA matrix |
| P3-PM-173 | PM s23, p.14 | QA: Client reference (attachment linked and routed). | QA matrix |
| P3-PM-174 | PM s23, p.14 | QA: Scope change (new feature classified and routed, not normal revision). | QA matrix |
| P3-PM-175 | PM s23, p.14 | QA: Revision loop (Designer-review-Admin-client order enforced). | QA matrix |
| P3-PM-176 | PM s23, p.14 | QA: Revision limit (2-3 configured limit + escalation). | QA matrix |
| P3-PM-177 | PM s23, p.14 | QA: Final confirmation (explicit evidence required; exact theme/color/Figma version). | QA matrix |
| P3-PM-178 | PM s23, p.14 | QA: Phase 4 gate (blocked before completion; opens after valid final confirmation). | QA matrix |
| P3-PM-179 | PM s23, p.14 | QA: Admin history (every share/feedback/revision/final decision visible). | QA matrix |
| P3-PM-180 | PM s23, p.14 | QA: Cost/idempotency (retries do not duplicate share/revision). | QA matrix |
| P3-PM-181 | PM s23, p.14 | QA: Security (RBAC, project isolation, unauthorized approval blocked). | QA matrix |
| P3-PM-182 | PM s23, p.14 | QA: Recovery (communication failure, event replay, worker retry). | QA matrix |
| P3-PM-183 | PM s24, p.14-15 | Definition of Done (14 items): PM starts only from valid Phase 3 entry; announces UI Finalization; reuses context before asking; handles genuine clarifications without inventing requirements; cannot share before internal review + Admin approval; exact options sent are stored in history; client selection/change/reference captured structurally; revisions follow Designer -> Internal Review -> Admin -> PM -> Client; client revision count and limit enforced; new scope not treated as design feedback; explicit final theme/color confirmation stored with Figma version; Phase 4 cannot start before valid Phase 3 completion; all PM Phase 3 actions/history visible in Admin Panel; duplicate/retry behavior idempotent; permissions/audit/isolation/recovery tests pass; no unresolved P0/P1 PM Phase 3 defects. | P0/P1 undefined |
| P3-PM-184 | PM s25 A, p.16 | Checklist A Start & Context: Phase3Started consumed; project/PM validated; project plan loaded; approved scope loaded; design context loaded; no-repeat client logic. | Checklist A |
| P3-PM-185 | PM s25 B, p.16 | Checklist B Announcement: start message configured; sent; delivery stored; no internal AI details exposed. | Checklist B |
| P3-PM-186 | PM s25 C, p.16 | Checklist C Clarification: clarification event; client question; response evidence; structured answer; scope-change detection. | Checklist C |
| P3-PM-187 | PM s25 D, p.16 | Checklist D Design Share Gate: internal pass verified; Admin approval verified; exact option IDs; exact version; client share evidence. | Checklist D |
| P3-PM-188 | PM s25 E, p.16 | Checklist E Client Decision: selection; change request; reference; ambiguity handling; final confirmation. | Checklist E |
| P3-PM-189 | PM s25 F, p.16 | Checklist F Revision: client origin; revision record; count; Designer handoff; internal review wait; Admin wait; re-share; limit escalation. | Checklist F |
| P3-PM-190 | PM s25 G, p.16-17 | Checklist G Final Lock: theme ID; color ID; Figma version; confirmation evidence; Phase 3 completion; Phase 4 handoff. | Checklist G |
| P3-PM-191 | PM s25 H, p.17 | Checklist H Admin Panel: share history; feedback history; revision timeline; final selection; project plan visibility; phase status. | Checklist H |
| P3-PM-192 | PM s25 I, p.17 | Checklist I Cost Control: no duplicate shares; no duplicate revision triggers; reuse links/assets; revision cap; abnormal usage visibility. | Checklist I |
| P3-PM-193 | PM s25 J, p.17 | Checklist J Quality: unit; integration; E2E; negative; permissions; isolation; idempotency; recovery; audit; Phase 4 gate. | Checklist J |
| P3-PM-194 | PM s26, p.17 | Execution protocol order: DISCOVER EXISTING PM/DESIGN WORKFLOW -> MAP THIS PDF -> REUSE CURRENT INFRASTRUCTURE -> IMPLEMENT ONE PM GAP -> TEST -> VERIFY -> UPDATE TRACEABILITY -> NEXT GAP -> FULL PHASE 3 E2E -> ADMIN HISTORY VALIDATION -> SECURITY/COST REVIEW -> PRODUCTION READINESS. | Protocol |
| P3-PM-195 | PM s26, p.17 | Prohibitions: do not create a separate client Communication Agent; do not let PM design UI or perform Admin approval; do not allow client share before internal + Admin approval; do not overwrite design/revision history; do not turn new scope into a normal visual revision; do not exceed revision policy automatically; do not expose internal AI/provider details; do not mark completion from code generation alone (require test/evidence). | 8 prohibitions |
| P3-PM-196 | PM s26, p.17 | Final report must include changed files, migrations, events/APIs, tests, manual configuration, limitations and Phase 4 readiness. | Final report contents |
| P3-PM-197 | PM s27, p.17-18 | Final locked PM flow: PHASE 2 COMPLETE -> PM ANNOUNCES UI FINALIZATION -> LOAD EXISTING CONTEXT -> HANDLE ONLY REQUIRED CLARIFICATIONS -> WAIT FOR FIGMA DESIGNER + INTERNAL REVIEW + ADMIN APPROVAL -> PM SHARES APPROVED THEME/COLOR OPTIONS -> RECORD EXACT SHARED OPTIONS -> CLIENT SELECTS / SHARES REFERENCE / REQUESTS CHANGE -> PM CLASSIFIES RESPONSE -> DESIGN REVISION OR SCOPE-CHANGE ROUTING -> DESIGNER -> INTERNAL REVIEW -> ADMIN -> PM RE-SHARE -> MAX APPROX. 2-3 CLIENT REVISION ROUNDS -> EXPLICIT CLIENT FINAL CONFIRMATION -> LOCK THEME + COLOR + FIGMA VERSION -> RECORD COMPLETE ADMIN HISTORY -> PHASE 3 COMPLETE -> PHASE 4 READY. | max approx. 2-3 rounds |
| P3-PM-198 | PM s27, p.18 | Locked PM principle: PM is the communication and coordination bridge; it protects approval order, scope, revision limits, historical evidence and final client confirmation while the Figma Designer and reviewers own the actual design work. | Principle |

---

## Part 3. UI Designer Agent specification (P3-UD)

| ID | Source (section, page) | Requirement | Named state / event / role / field / number |
|---|---|---|---|
| P3-UD-01 | UD cover, p.1 | UI Designer Agent (a.k.a. Figma Designer Agent) is the canonical design owner for Phase 3 UI theme + color finalization; canonical tool is Figma. Baseline is LOCKED. | Official Role |
| P3-UD-02 | UD cover, p.1 | Primary output: 2-3 meaningful UI theme directions + appropriate color combinations + approved final visual direction. | 2-3 |
| P3-UD-03 | UD cover, p.1 | Gates: Internal Design Review -> Admin Review -> Client review via PM. | Gate order |
| P3-UD-04 | UD cover, p.1 | The final locked Figma direction becomes the Phase 4 design baseline. | - |
| P3-UD-05 | UD cover, p.1 | Cost principle: reuse first; no duplicate generation; image generation only when it adds real value. | - |
| P3-UD-06 | UD s1, p.2 | Designer turns approved project context, finalized screen baseline, brand info and client references into a small set of high-quality visual directions in Figma. | - |
| P3-UD-07 | UD s1, p.2 | Phase 3 does not require the Designer to create every final production screen; the goal is to establish and lock the visual system Phase 4 uses for full UI design and prototype. | - |
| P3-UD-08 | UD s1, p.2 | Canonical rule: Figma is the design source of truth; preview images may support review but screenshots or generated images must never replace the underlying Figma artifact. | - |
| P3-UD-09 | UD s2, p.2 | Start condition: Phase 3 active for the project. | - |
| P3-UD-10 | UD s2, p.2 | Start condition: approved scope and requirements available; Project Planning Agent context available. | - |
| P3-UD-11 | UD s2, p.2 | Start condition: screen list and screen-by-screen content baseline sufficiently defined for theme work. | "sufficiently defined" (see C-07) |
| P3-UD-12 | UD s2, p.2 | Start condition: known brand assets/references/preferences loaded. | - |
| P3-UD-13 | UD s2, p.2 | Start condition: any mandatory design clarification blocking theme generation has been resolved. | - |
| P3-UD-14 | UD s2, p.2 | Start condition: Designer job is not a duplicate/replay of an already completed input version. | - |
| P3-UD-15 | UD s3, p.2 | Designer inputs: project identity and type; approved scope reference; finalized/working screen list; screen-by-screen content and action baseline; Project Planning Agent operational blueprint; brand assets, logo, fonts if supplied, style references, existing product assets; client-provided inspiration/reference images or URLs; previously confirmed color/brand constraints; target platforms (mobile, web, responsive or other agreed); known accessibility/usability constraints; current design-context version and prior theme/revision history. | 11 inputs |
| P3-UD-16 | UD s4.1, p.3 | Read the latest approved scope and relevant design requirements before creating anything; use the finalized screen/content baseline for actual product needs. | - |
| P3-UD-17 | UD s4.1, p.3 | Use Project Planning output for context/dependencies, not visual invention; do not invent features or screens to make a theme look more impressive. | - |
| P3-UD-18 | UD s4.2, p.3 | Create approx. 2-3 distinct UI theme directions, each meaningfully different in visual language yet suitable for the same approved product. | approx. 2-3 |
| P3-UD-19 | UD s4.2, p.3 | No superficial duplicates where only one minor property changes; keep option count deliberately limited for client clarity and cost control. | - |
| P3-UD-20 | UD s4.3, p.3 | Prepare approx. 2-3 suitable color combinations per direction as applicable. | approx. 2-3 per direction |
| P3-UD-21 | UD s4.3, p.3 | Respect confirmed brand colors/constraints. | - |
| P3-UD-22 | UD s4.3, p.3 | Define reusable color tokens, not only visual swatches. | tokens |
| P3-UD-23 | UD s4.3, p.3 | Consider basic text/background contrast and usability. | - |
| P3-UD-24 | UD s4.4, p.3 | Create theme/sample screens and reusable styles/components in Figma or the configured supported Figma workflow. | - |
| P3-UD-25 | UD s4.4, p.3 | Store stable Figma file/page/node references; use preview assets only as secondary review artifacts. | - |
| P3-UD-26 | UD s4.4, p.3 | Keep layer/component naming structured enough for Phase 4 reuse. | - |
| P3-UD-27 | UD s4.5, p.3 | Define only the Phase 3 level of visual primitives needed to communicate the direction (examples: typography style, color tokens, surfaces, buttons, cards, spacing feel, border/radius/shadow style, icon treatment, key navigation style); do not overbuild the complete production design system. | Primitives list |
| P3-UD-28 | UD s4.6, p.3 | Support internal review: submit directions to Internal Design Reviewer with clear option/version identifiers; receive structured feedback; revise only requested/validated items; resubmit with change summary. | - |
| P3-UD-29 | UD s4.7, p.3 | Support Admin review: after internal pass prepare Admin-ready artifacts and previews; on Admin EDIT consume structured reason/comments; revise the exact affected version; send back through internal review before Admin receives it again. | - |
| P3-UD-30 | UD s4.8, p.3 | Support client revisions: receive client feedback only through the controlled workflow/PM; mark revision origin CLIENT; apply only approved visual/design changes; do not treat new functionality as normal visual feedback; send the revised design through internal review and Admin approval before PM re-shares. | origin = CLIENT |
| P3-UD-31 | UD s4.9, p.4 | Final lock preparation: after client selects, ensure exact theme ID, color ID and Figma version are stable; finalize necessary Phase 3 tokens/reference assets for Phase 4; do not silently overwrite the chosen version; produce structured design handoff metadata. | - |
| P3-UD-32 | UD s5, p.5 | Designer must not communicate directly with the client when PM owns client communication. | Prohibition 1 |
| P3-UD-33 | UD s5, p.5 | Designer must not mark Admin approval. | Prohibition 2 |
| P3-UD-34 | UD s5, p.5 | Designer must not mark client final confirmation. | Prohibition 3 |
| P3-UD-35 | UD s5, p.5 | Designer must not bypass the Internal Design Reviewer. | Prohibition 4 |
| P3-UD-36 | UD s5, p.5 | Designer must not add screens/features outside approved scope without a governed scope/change decision. | Prohibition 5 |
| P3-UD-37 | UD s5, p.5 | Designer must not generate 10-20 options when the locked requirement is approx. 2-3 meaningful directions. | Prohibition 6 |
| P3-UD-38 | UD s5, p.5 | Designer must not use image generation as a substitute for the canonical Figma artifact. | Prohibition 7 |
| P3-UD-39 | UD s5, p.5 | Designer must not create duplicate designs after a retry when the same input/version already produced an artifact. | Prohibition 8 |
| P3-UD-40 | UD s5, p.5 | Designer must not overwrite earlier versions or destroy review history. | Prohibition 9 |
| P3-UD-41 | UD s5, p.5 | Designer must not expose internal AI/provider/model details inside client-facing design artifacts. | Prohibition 10 |
| P3-UD-42 | UD s5, p.5 | Designer must not proceed on ambiguous functional requirements by guessing. | Prohibition 11 |
| P3-UD-43 | UD s5, p.5 | Designer must not create Phase 4 full-production UI/prototype in Phase 3 unless the user later changes the locked boundary. | Prohibition 12 |
| P3-UD-44 | UD s6, p.5 | A theme direction is a coherent visual language, not merely a color palette. | - |
| P3-UD-45 | UD s6, p.5 | Theme dimension "Visual personality": modern, premium, minimal, playful, editorial, enterprise, etc., justified by project context. | Dimension 1 |
| P3-UD-46 | UD s6, p.5 | Theme dimension "Typography": font family or safe candidate, hierarchy, weight/size feel. | Dimension 2 |
| P3-UD-47 | UD s6, p.5 | Theme dimension "Layout language": density, whitespace, alignment, container/card treatment. | Dimension 3 |
| P3-UD-48 | UD s6, p.5 | Theme dimension "Navigation feel": tabs, bottom nav, side nav or context-relevant visual treatment. | Dimension 4 |
| P3-UD-49 | UD s6, p.5 | Theme dimension "Components": button, card, input, badge/chip, modal/sheet treatment as samples. | Dimension 5 |
| P3-UD-50 | UD s6, p.5 | Theme dimension "Imagery/iconography": illustration/photo/icon style when relevant. | Dimension 6 |
| P3-UD-51 | UD s6, p.5 | Theme dimension "Surface treatment": background, elevation, border, radius, shadow approach. | Dimension 7 |
| P3-UD-52 | UD s6, p.5 | Theme dimension "Motion feel": only high-level interaction/motion direction if relevant; not a full animation spec. | Dimension 8 |
| P3-UD-53 | UD s6, p.5 | Theme dimension "Color direction": linked tokenized palettes. | Dimension 9 |
| P3-UD-54 | UD s6, p.5 | Theme dimension "Reference screens": enough representative screens/states to judge the direction. | Dimension 10 |
| P3-UD-55 | UD s7, p.5 | Use representative screens that expose the most important visual decisions; select across key patterns rather than designing every screen. | - |
| P3-UD-56 | UD s7, p.5 | Include at least one primary/home/dashboard-like screen when applicable. | min 1 |
| P3-UD-57 | UD s7, p.5 | Include at least one content/detail/form/list pattern when applicable. | min 1 |
| P3-UD-58 | UD s7, p.5 | Include enough navigation/state context for Admin/client to judge the direction. | - |
| P3-UD-59 | UD s7, p.5 | Do not create redundant sample screens that add cost without decision value. | - |
| P3-UD-60 | UD s7, p.5 | Record which final screen definitions each representative sample maps to. | - |
| P3-UD-61 | UD s8, p.6 | Treat the selected Figma artifact/version as the authoritative Phase 3 design output. | - |
| P3-UD-62 | UD s8, p.6 | Store Figma file key/reference; page/node IDs for each theme option where available; preview thumbnails/renders. | - |
| P3-UD-63 | UD s8, p.6 | Preserve version association between preview and Figma artifact. | - |
| P3-UD-64 | UD s8, p.6 | Ensure Phase 4 can open the exact final selection without relying on screenshots. | - |
| P3-UD-65 | UD s8, p.6 | Do not silently replace a Figma file/node and reuse the same version identifier. | - |
| P3-UD-66 | UD s8, p.6 | Protect provider credentials and access tokens through secure configuration. | - |
| P3-UD-67 | UD s9, p.6 | Image generation is optional support, not the default design workflow. | - |
| P3-UD-68 | UD s9, p.6 | Use image generation only when it materially helps produce an illustration, reference, texture, mood-board element or visual asset that cannot be efficiently produced/reused otherwise. | - |
| P3-UD-69 | UD s9, p.6 | Do not generate a whole fake app screenshot and treat it as the Phase 3 source of truth. | - |
| P3-UD-70 | UD s9, p.6 | Do not pay for both image generation and separate Figma recreation when direct Figma design would be more efficient. | - |
| P3-UD-71 | UD s9, p.6 | If generated imagery influences the final design, preserve asset/source linkage and usage-rights metadata where relevant. | usage-rights metadata |
| P3-UD-72 | UD s9, p.6 | Reuse generated assets across relevant screens instead of regenerating near-identical versions. | - |
| P3-UD-73 | UD s10, p.6 | Designer optimization target: maximum useful design-decision quality per project cost, not maximum number of generations. | - |
| P3-UD-74 | UD s10, p.6 | Create only the requested 2-3 meaningful directions; reuse approved components, tokens and brand assets; reuse unchanged results when input context/version has not changed. | 2-3 |
| P3-UD-75 | UD s10, p.6 | Use lower-cost suitable model/tool for routine extraction/classification; stronger model only when complex visual reasoning materially benefits quality. | - |
| P3-UD-76 | UD s10, p.6 | Do not send the same brief independently to multiple expensive providers unless a governed comparison is actually needed. | - |
| P3-UD-77 | UD s10, p.6 | Cache design-brief summaries and normalized context; bundle related feedback into one revision where possible. | - |
| P3-UD-78 | UD s10, p.6 | Track design-generation/model/tool usage by project/phase/task where supported; expose abnormal repeated-generation patterns to Admin. | - |
| P3-UD-79 | UD s11, p.7 | Design Brief contract fields: project_id, phase3_workspace_id, design_context_version, project_type, target_platforms, approved_scope_refs, screen_definition_refs, representative_screen_candidates, brand_asset_refs, client_reference_refs, confirmed_visual_preferences, confirmed_color_constraints, accessibility/usability constraints if applicable, option_count policy, color_option policy, revision policy, existing reusable component/token refs, output/Figma workspace target. | 18 fields |
| P3-UD-80 | UD s12, p.7 | Theme Option output contract fields: theme_option_id, project_id, phase3_version, option_name, visual_direction_summary, representative_screen_refs, figma_file_ref, figma_page/node refs, preview_asset_refs, design_token_refs, linked_color_option_ids, source_context_version, generation/job id, generation cost/usage reference if available, internal_review_status, admin_status, client_status, created_at/updated_at. | 18 fields |
| P3-UD-81 | UD s13, p.7-8 | Color Option output contract fields: color_option_id, theme_option_id, palette_name, primary token, secondary token, accent token, background/surface tokens, text tokens, semantic success/warning/error tokens if represented, contrast/accessibility notes, brand constraint source, preview refs, version/status. | 13 fields |
| P3-UD-82 | UD s14, p.9 | Internal review loop: DESIGNER DRAFT -> INTERNAL DESIGN REVIEW -> PASS or CHANGES_REQUIRED. | PASS, CHANGES_REQUIRED |
| P3-UD-83 | UD s14, p.9 | Reviewer receives the exact artifact/version; feedback is structured by option/screen/component where possible. | - |
| P3-UD-84 | UD s14, p.9 | Designer records a change summary; changes only the necessary artifact version; resubmission creates auditable review history. | - |
| P3-UD-85 | UD s14, p.9 | Internal PASS is required before Admin review. | Gate |
| P3-UD-86 | UD s15, p.9 | Admin review loop: INTERNAL PASS -> ADMIN REVIEW -> CONFIRM or EDIT -> if EDIT: DESIGNER REVISION -> INTERNAL REVIEW -> ADMIN REVIEW. | CONFIRM / EDIT |
| P3-UD-87 | UD s15, p.9 | Admin sees Figma reference, previews, theme/color identifiers and internal-review evidence. | - |
| P3-UD-88 | UD s15, p.9 | Admin EDIT must have reason/comments. | - |
| P3-UD-89 | UD s15, p.9 | Designer does not communicate the Admin edit directly to the client; a revised option remains a new version. | - |
| P3-UD-90 | UD s15, p.9 | Only Admin-approved versions become eligible for PM/client sharing. | - |
| P3-UD-91 | UD s16, p.9 | Client revision loop: CLIENT FEEDBACK via PM -> DESIGN REVISION REQUEST -> DESIGNER -> INTERNAL REVIEW -> ADMIN REVIEW -> PM -> CLIENT. | Loop |
| P3-UD-92 | UD s16, p.9 | Client feedback arrives as a structured request linked to source evidence. | - |
| P3-UD-93 | UD s16, p.9 | Designer differentiates visual change from possible functional/scope change; if the request affects scope, return/flag instead of implementing silently. | - |
| P3-UD-94 | UD s16, p.9 | Revision origin is CLIENT; revision count is maintained by workflow. | - |
| P3-UD-95 | UD s16, p.9 | Designer stops automatic revision generation when the configured approx. 2-3 client revision limit is reached and waits for the escalation outcome. | approx. 2-3; "reached" |
| P3-UD-96 | UD s17, p.10 | Every designed screen or representative sample maps to an approved ScreenDefinition or an explicitly approved design requirement. | - |
| P3-UD-97 | UD s17, p.10 | Designer may visually interpret an approved requirement but must not invent new business logic. | - |
| P3-UD-98 | UD s17, p.10 | New client feature requests must be flagged as POSSIBLE_SCOPE_CHANGE. | POSSIBLE_SCOPE_CHANGE |
| P3-UD-99 | UD s17, p.10 | A new screen request not traceable to approved scope must be blocked/flagged until governed. | - |
| P3-UD-100 | UD s17, p.10 | Designer documents visual assumptions separately from functional requirements; visual simplification must not remove required functionality from the representation. | - |
| P3-UD-101 | UD s18, p.10 | Design quality checklist (13 items): themes meaningfully distinct; visual hierarchy clear; typography legible and consistent; spacing rhythm coherent; colors usable and consistent; primary actions visually clear; navigation patterns understandable; representative screens demonstrate the direction adequately; brand constraints respected; UI patterns reusable in Phase 4; basic contrast/accessibility concerns not obviously violated; design appropriate to target platform(s); option presentation-ready for Admin/client review. | 13 items |
| P3-UD-102 | UD s19, p.10 | Final selected theme/color is represented by a stable Figma version. | Handoff prep |
| P3-UD-103 | UD s19, p.10 | Phase 4 receives design tokens/primitives rather than recreating them; reusable components created in Phase 3 are preserved; representative screens remain available as reference. | - |
| P3-UD-104 | UD s19, p.10 | Screen list/content baseline and client/Admin approval evidence are linked; known exceptions/limitations are documented. | - |
| P3-UD-105 | UD s19, p.10 | Phase 4 must not redo theme selection unless a governed change is introduced. | - |
| P3-UD-106 | UD s20, p.11 | Admin visibility principle: important work and history from every phase must be visible in the Admin Panel. | - |
| P3-UD-107 | UD s20, p.11 | Admin views for Designer: Phase 3 Overview (Designer job/state, current version, blockers, revision count); Screen Definitions (screens/content Designer works from); Theme Options (all generated options with Figma/preview refs); Color Options (palettes linked to each theme); Internal Reviews (pass/change history and comments); Admin Reviews (confirm/edit history); Client Share Status (whether exact option/version was shared); Client Feedback (structured feedback relevant to Designer); Revision History (version, origin, changes, timestamps); Final Selection (locked theme/color/Figma version); Project Plan (relevant planning context); Cost/Usage (generation calls/tool/model usage/cost where supported; row clipped in PDF). | 12 views |
| P3-UD-108 | UD s20, p.11 | Historical artifacts must remain accessible; a new revision must not erase a previously reviewed or client-shared version. | - |
| P3-UD-109 | UD s21, p.11 | Designer Work Item state machine: QUEUED -> CONTEXT_LOADING -> DRAFTING -> FIGMA_SYNC -> INTERNAL_REVIEW -> CHANGES_REQUIRED / INTERNAL_PASS -> ADMIN_REVIEW -> ADMIN_EDIT / ADMIN_APPROVED -> CLIENT_FEEDBACK_WAIT -> CLIENT_REVISION -> FINAL_LOCK_READY. | 13 states |
| P3-UD-110 | UD s21, p.11 | Theme Option state machine: DRAFT -> INTERNAL_REVIEW -> INTERNAL_PASS -> ADMIN_REVIEW -> ADMIN_APPROVED -> CLIENT_SHARED -> CLIENT_SELECTED / CLIENT_CHANGE -> LOCKED. | 9 states |
| P3-UD-111 | UD s21, p.11 | Failure states: BLOCKED_REQUIREMENT, PROVIDER_FAILED, FIGMA_SYNC_FAILED, SCOPE_ESCALATION, REVISION_LIMIT_ESCALATION. | 5 failure states |
| P3-UD-112 | UD s22, p.12 | Event Phase3Started: producer Workflow; Designer prepares/validates design context. | Event |
| P3-UD-113 | UD s22, p.12 | Event ScreenListFinalized: producer Screen workflow; Designer opens theme-generation eligibility. | Event |
| P3-UD-114 | UD s22, p.12 | Event DesignContextReady: producer Coordination; Designer starts drafting if not duplicate. | Event |
| P3-UD-115 | UD s22, p.12 | Event ThemeGenerationRequested: producer Orchestrator; Designer creates options. | Event |
| P3-UD-116 | UD s22, p.12 | Event ThemeOptionsGenerated: producer Designer; Designer persists options + previews + Figma refs. | Event |
| P3-UD-117 | UD s22, p.12 | Event InternalDesignChangesRequired: producer Reviewer; Designer revises the exact version. | Event |
| P3-UD-118 | UD s22, p.12 | Event InternalDesignPassed: producer Reviewer; Designer prepares Admin review. | Event |
| P3-UD-119 | UD s22, p.12 | Event AdminDesignEditRequested: producer Admin; Designer revises and resubmits internally. | Event |
| P3-UD-120 | UD s22, p.12 | Event AdminDesignApproved: producer Admin; no design action unless client feedback arrives. | Event |
| P3-UD-121 | UD s22, p.12 | Event ClientDesignChangeRequested: producer PM/workflow; Designer creates client-origin revision. | Event |
| P3-UD-122 | UD s22, p.12 | Event PossibleScopeChangeDetected: producer Designer; Designer stops the affected change and routes escalation. | Event |
| P3-UD-123 | UD s22, p.12 | Event ClientDesignSelected: producer PM/workflow; Designer prepares final lock/handoff. | Event |
| P3-UD-124 | UD s22, p.12 | Event Phase3Completed: producer Workflow; Designer freezes the selected Phase 3 reference set. | Event |
| P3-UD-125 | UD s23, p.12 | Entity DesignJob: project, input/context version, job type, status, idempotency key, provider/tool usage. | Entity |
| P3-UD-126 | UD s23, p.12 | Entity ThemeOption: theme contract + statuses + Figma refs. | Entity |
| P3-UD-127 | UD s23, p.12 | Entity ColorOption: palette/tokens + theme link + status. | Entity |
| P3-UD-128 | UD s23, p.12 | Entity DesignTokenSet: typography/color/spacing/surface primitives + version. | Entity |
| P3-UD-129 | UD s23, p.12 | Entity RepresentativeScreen: screenDefinition link, theme link, Figma node, preview. | Entity |
| P3-UD-130 | UD s23, p.12 | Entity DesignRevision: source/target version, origin, requested changes, result, cost/usage. | Entity |
| P3-UD-131 | UD s23, p.12 | Entity DesignReviewLink: review IDs/statuses tied to exact artifact/version. | Entity |
| P3-UD-132 | UD s23, p.12 | Entity DesignAsset: source/generated/reused type, storage/Figma refs, rights/source metadata if applicable. | Entity |
| P3-UD-133 | UD s23, p.12 | Entity DesignHandoff: selected theme/color/token/Figma refs + approval evidence. | Entity |
| P3-UD-134 | UD s23, p.12 | Entity UsageRecord: project/phase/agent/task/provider/model/tool/tokens/calls/cost if available. | Entity |
| P3-UD-135 | UD s23, p.12 | Entity AuditEvent: actor/agent, action, entity/version, before/after, timestamp. | Entity |
| P3-UD-136 | UD s24, p.13 | Figma integration: inspect existing Figma/provider integration before implementing a new one; use official/supported APIs or configured mechanisms. | - |
| P3-UD-137 | UD s24, p.13 | Support secure Figma credentials/service tokens where applicable; create/update artifacts under the correct project/workspace; persist file/page/node identifiers. | - |
| P3-UD-138 | UD s24, p.13 | Generate preview assets without losing linkage to canonical nodes. | - |
| P3-UD-139 | UD s24, p.13 | Use idempotency to prevent duplicate option creation on retry. | - |
| P3-UD-140 | UD s24, p.13 | Detect/handle permission errors and revoked tokens. | - |
| P3-UD-141 | UD s24, p.13 | Do not claim automated editing if the integration only supports assisted/manual steps; expose the exact manual step in the Admin Panel when automation cannot complete it. | - |
| P3-UD-142 | UD s25, p.13 | Designer has project-scoped access only; can read approved requirements/brand assets needed for design; can write design artifacts/revisions, not Admin/client approval state. | RBAC |
| P3-UD-143 | UD s25, p.13 | Figma/provider credentials never appear in client-facing output; generated previews and attachments use access-controlled storage. | - |
| P3-UD-144 | UD s25, p.13 | Server-side authorization protects design APIs; tenant/project isolation is tested; every material design mutation is auditable. | - |
| P3-UD-145 | UD s26, p.13 | Failure: incomplete design context -> BLOCKED_REQUIREMENT; request structured clarification. | Failure table |
| P3-UD-146 | UD s26, p.13 | Failure: Figma API/provider timeout -> retry safely using same job/idempotency key. | Failure table |
| P3-UD-147 | UD s26, p.13 | Failure: Figma permission failure -> surface manual/config blocker; do not fake completion. | Failure table |
| P3-UD-148 | UD s26, p.13 | Failure: generation tool/model failure -> retry/fallback by policy; preserve context/version. | Failure table |
| P3-UD-149 | UD s26, p.13 | Failure: duplicate job/event -> return existing artifact if same input/version. | Failure table |
| P3-UD-150 | UD s26, p.13 | Failure: internal review rejects -> create revision; preserve prior version. | Failure table |
| P3-UD-151 | UD s26, p.13 | Failure: Admin edit -> create new version; run internal review again. | Failure table |
| P3-UD-152 | UD s26, p.13 | Failure: client new feature request -> flag scope escalation. | Failure table |
| P3-UD-153 | UD s26, p.13 | Failure: client revision limit reached -> stop auto-generation; escalation. | Failure table |
| P3-UD-154 | UD s26, p.13 | Failure: preview rendering fails -> retry preview only; do not regenerate design unnecessarily. | Failure table |
| P3-UD-155 | UD s26, p.13 | Failure: cost threshold breached -> alert/policy action; avoid runaway regeneration. | Failure table; threshold unspecified |
| P3-UD-156 | UD s27 UI3-I01, p.14 | Existing system discovery: inspect Phase 3 domain, Project Planning context, screen definitions, Figma integration, asset storage, design system, approval engine, event/jobs, Admin Panel, audit and usage tracking; create PDF-requirement-to-code traceability matrix. | Plan item |
| P3-UD-157 | UD s27 UI3-I02, p.14 | Designer Agent contract: define input schema, output schema, supported actions, permission boundary, state transitions and failure codes; require structured outputs for workflow-changing actions. | Plan item |
| P3-UD-158 | UD s27 UI3-I03, p.14 | Design context builder: normalize approved scope, screen/content baseline, brand assets, client references and reusable design assets into a versioned design brief; hash/version context to support artifact reuse. | Plan item |
| P3-UD-159 | UD s27 UI3-I04, p.14 | Theme generation workflow: implement approx. 2-3 meaningful directions; generate/store canonical Figma artifacts, preview refs and metadata; prevent duplicate generation. | Plan item |
| P3-UD-160 | UD s27 UI3-I05, p.14 | Color/token workflow: implement appropriate color combinations and reusable tokens; link tokens to theme/version; preserve confirmed brand constraints. | Plan item |
| P3-UD-161 | UD s27 UI3-I06, p.14 | Representative screen workflow: select/create representative sample screens from screen definitions; link samples to exact screen requirements. | Plan item |
| P3-UD-162 | UD s27 UI3-I07, p.14 | Internal review integration: create review submission payload; consume structured changes/pass; implement versioned revision/resubmission. | Plan item |
| P3-UD-163 | UD s27 UI3-I08, p.14 | Admin review integration: consume Admin EDIT/APPROVED; on EDIT revise -> internal review -> Admin; never mark Admin approval internally. | Plan item |
| P3-UD-164 | UD s27 UI3-I09, p.14 | Client revision integration: consume PM-routed design feedback; classify visual revision vs possible scope change; implement client-origin revision and revision-limit guard. | Plan item |
| P3-UD-165 | UD s27 UI3-I10, p.14 | Final lock/handoff: prepare stable selected Figma/token/theme/color references; prevent silent overwrite; create the Phase 4 design-handoff artifact. | Plan item |
| P3-UD-166 | UD s27 UI3-I11, p.14-15 | Admin history and cost telemetry: expose all options/versions/reviews/revisions/final selection; track generation/tool/model calls and cost where available. | Plan item |
| P3-UD-167 | UD s27 UI3-I12, p.15 | Security, reliability and QA: implement RBAC, project isolation, secret handling, idempotency, retries, logs and full test suite. | Plan item |
| P3-UD-168 | UD s28, p.16 | Suggested Designer service signatures (reuse equivalent existing services): buildPhase3DesignBrief(projectId, contextVersion); generateThemeOptions(projectId, briefVersion, idempotencyKey); generateColorOptions(themeOptionId, constraints); syncThemeToFigma(themeOptionId, version); renderThemePreviews(themeOptionId, version); submitDesignForInternalReview(themeOptionId, version); reviseFromInternalReview(themeOptionId, sourceVersion, reviewId); reviseFromAdminFeedback(themeOptionId, sourceVersion, decisionId); reviseFromClientFeedback(themeOptionId, sourceVersion, revisionId); flagPossibleDesignScopeChange(projectId, revisionId); preparePhase3DesignHandoff(projectId, selectedThemeId, colorId, figmaVersion). | 11 signatures |
| P3-UD-169 | UD s29, p.16 | QA: Context (approved inputs loaded; missing/ambiguous blocked; cross-project isolation). | QA matrix |
| P3-UD-170 | UD s29, p.16 | QA: Theme count (2-3 meaningful options; duplicate retry does not create more). | QA matrix |
| P3-UD-171 | UD s29, p.16 | QA: Theme quality (distinct direction metadata; representative screens). | QA matrix |
| P3-UD-172 | UD s29, p.16 | QA: Color options (correct theme link; brand constraints; token persistence). | QA matrix |
| P3-UD-173 | UD s29, p.16 | QA: Figma (create/update refs; preview link; permission failure; retry idempotency). | QA matrix |
| P3-UD-174 | UD s29, p.16 | QA: Image generation (optional only; traceable; no fake canonical artifact). | QA matrix |
| P3-UD-175 | UD s29, p.16 | QA: Internal review (reject/revise/pass loop). | QA matrix |
| P3-UD-176 | UD s29, p.16 | QA: Admin (edit/revise/re-review/approve; Designer cannot self-approve). | QA matrix |
| P3-UD-177 | UD s29, p.16 | QA: Client revision (PM-routed only; origin/version/count preserved). | QA matrix |
| P3-UD-178 | UD s29, p.16 | QA: Scope protection (new feature flagged, not silently implemented). | QA matrix |
| P3-UD-179 | UD s29, p.16 | QA: Revision cap (stop/escalate after configured limit). | QA matrix |
| P3-UD-180 | UD s29, p.16 | QA: History (prior versions retained and visible). | QA matrix |
| P3-UD-181 | UD s29, p.16 | QA: Cost (same input reused; no unnecessary duplicate provider calls). | QA matrix |
| P3-UD-182 | UD s29, p.16 | QA: Handoff (selected theme/color/Figma version stable and Phase 4 reusable). | QA matrix |
| P3-UD-183 | UD s29, p.16 | QA: Security (RBAC, project isolation, secret handling). | QA matrix |
| P3-UD-184 | UD s29, p.16 | QA: Recovery (provider timeout, job retry, duplicate event, preview failure). | QA matrix |
| P3-UD-185 | UD s30, p.17 | Mandatory E2E designer scenario (16 steps): receive valid design context; build versioned brief from approved scope/screens/project plan; generate exactly 3 meaningful theme directions in the test scenario; create linked color options/tokens; create representative Figma samples and previews; submit all to internal review; reviewer rejects one direction, Designer revises, review passes; Admin edits a different detail, Designer creates new version, internal review passes, Admin approves; PM shares approved options, client asks for visual change; Designer receives PM-routed client revision; applies revision without adding new scope; internal review passes, Admin approves; client selects final theme/color through PM; Designer prepares final locked Figma/token handoff; all prior versions/reviews remain visible; duplicate event replay creates no duplicate design option; usage/cost records reflect actual generations only. | exactly 3 themes (test); 1 reject, 1 admin edit, 1 client change |
| P3-UD-186 | UD s31, p.17 | Definition of Done (16 items): consumes locked design context; Figma canonical; approx. 2-3 theme directions; appropriate color combos/tokens; representative screens mapped to approved ScreenDefinitions; internal review loop; Admin edit/approval loop; client-origin revision loop through PM; scope-change detection prevents silent feature addition; revision-limit behavior; final theme/color/Figma version lockable for Phase 4; Admin Panel shows options, reviews, revisions, final selection; historical versions preserved; duplicate generation prevented; cost/usage telemetry where infrastructure supports; security/permissions/isolation/retries/recovery tests pass; no unresolved P0/P1 UI Designer defects. | P0/P1 undefined |
| P3-UD-187 | UD s32 A, p.17-18 | Checklist A Context: approved scope; screen list; screen content; project plan; brand assets; client references; platform; constraints; context version. | Checklist A |
| P3-UD-188 | UD s32 B, p.18 | Checklist B Theme Work: 2-3 directions; meaningful distinction; representative screens; Figma refs; previews; metadata; reusable primitives. | Checklist B |
| P3-UD-189 | UD s32 C, p.18 | Checklist C Colors: 2-3 combinations as applicable; brand constraints; tokens; contrast note; theme link; version. | Checklist C |
| P3-UD-190 | UD s32 D, p.18 | Checklist D Figma: canonical artifact; file/page/node refs; secure auth; idempotent sync; preview refs; error handling. | Checklist D |
| P3-UD-191 | UD s32 E, p.18 | Checklist E Reviews: internal submission; changes required; revision; internal pass; Admin review; Admin edit loop; Admin approval. | Checklist E |
| P3-UD-192 | UD s32 F, p.18 | Checklist F Client Revision: PM-routed feedback; visual vs scope classification; revision origin; version; count; re-review; escalation. | Checklist F |
| P3-UD-193 | UD s32 G, p.18-19 | Checklist G Final Handoff: theme ID; color ID; Figma version; tokens; representative screens; approval refs; Phase 4 package. | Checklist G |
| P3-UD-194 | UD s32 H, p.19 | Checklist H Admin Panel: theme history; colors; reviews; Admin decisions; client revision; final selection; project plan; cost/usage. | Checklist H |
| P3-UD-195 | UD s32 I, p.19 | Checklist I Cost: reuse context; reuse assets; no duplicate provider calls; limited variants; no retry regeneration; usage tracking. | Checklist I |
| P3-UD-196 | UD s32 J, p.19 | Checklist J Quality: unit; integration; Figma/provider; review loops; negative; security; isolation; idempotency; recovery; E2E. | Checklist J |
| P3-UD-197 | UD s33, p.20 | Execution protocol order: DISCOVER EXISTING DESIGN/Figma INFRASTRUCTURE -> MAP THIS PDF -> REUSE WORKING COMPONENTS -> IMPLEMENT DESIGNER DOMAIN/CONTRACT -> BUILD CONTEXT REUSE -> IMPLEMENT THEME/COLOR/FIGMA FLOW -> INTERNAL REVIEW -> ADMIN LOOP -> CLIENT-REVISION INTEGRATION -> COST/IDEMPOTENCY -> FULL E2E -> SECURITY/RECOVERY -> PRODUCTION READINESS. | Protocol |
| P3-UD-198 | UD s33, p.20 | Prohibitions: do not create duplicate design systems if reusable infrastructure exists; do not merge UI Designer responsibilities into PM; do not let Designer self-approve internal/Admin/client gates; do not substitute image generation for Figma; do not generate more variants than required without explicit reason; do not silently add scope; do not overwrite version history; do not rerun expensive generation on ordinary retry when the same artifact can be reused; do not mark a requirement complete until implementation + integration + test + evidence exists. | 9 prohibitions |
| P3-UD-199 | UD s33, p.20 | Final report must include changed files, migrations, Figma/provider setup, events/APIs, tests, usage/cost controls, manual steps, limitations and Phase 4 readiness. | Final report contents |
| P3-UD-200 | UD s34, p.20 | Final locked Designer flow: PHASE 3 DESIGN CONTEXT READY -> LOAD APPROVED SCOPE + SCREEN BASELINE + PROJECT PLAN + BRAND/REFERENCE CONTEXT -> CREATE 2-3 MEANINGFUL FIGMA THEME DIRECTIONS -> CREATE APPROPRIATE COLOR COMBINATIONS/TOKENS -> REPRESENTATIVE SCREEN SAMPLES -> INTERNAL REVIEW -> CHANGES IF REQUIRED -> INTERNAL PASS -> ADMIN REVIEW -> ADMIN EDIT OR APPROVE -> IF EDIT: DESIGNER REVISION -> INTERNAL REVIEW -> ADMIN AGAIN -> ADMIN APPROVED -> PM SHARES TO CLIENT -> CLIENT FEEDBACK VIA PM -> DESIGNER REVISION -> INTERNAL REVIEW -> ADMIN REVIEW -> PM RE-SHARE -> LIMITED CLIENT REVISION LOOP -> CLIENT SELECTS FINAL DIRECTION -> PREPARE LOCKED THEME + COLOR + FIGMA VERSION -> PHASE 4 HANDOFF. | Flow |
| P3-UD-201 | UD s34, p.20 | Locked Designer principle: create the minimum high-quality design work needed for a confident visual decision, preserve Figma as canonical, reuse everything useful, never bypass review/approval/scope controls. | Principle |

---

## Counts

| PDF | Pages | Rows |
|---|---|---|
| Master (P3-M) | 18 | 260 |
| PM Agent (P3-PM) | 18 | 198 |
| UI Designer Agent (P3-UD) | 20 | 201 |
| Total | 56 | 659 |

---

## (a) Open questions / decisions the PDFs leave unanswered

No PDF contains an explicit "open" or "to be confirmed" marker. Every item below is a gap, an "approximately", or a "configured/as applicable" value that the PDFs do not resolve.

| ID | Question | Where it arises |
|---|---|---|
| OQ-01 | Exact client revision limit: 2 or 3? The PDFs say "approx. 2-3" and "configured"; no default value is given. | M 7.10, 16, 29G; PM 4.7, 9, I09; UD 4.8, 16 |
| OQ-02 | Does reaching the limit stop revision (UD 16, PM 4.8 "reached/exceeded") or only exceeding it (M 7.10 "beyond the limit")? What counts as the Nth round? | M 7.10, 16; PM 4.8; UD 16 |
| OQ-03 | Which rounds increment the revision counter? PM 9 says client-requested rounds only (Admin EDIT not counted), but M s16 and M s10 speak of one "revision count" without saying so. Do CLIENT_REFERENCE submissions count? Do ambiguity clarifications? | M 16, 19; PM 9, 12; UD 16 |
| OQ-04 | Theme option count: "2-3" and "approx. 2-3". Is 2 a valid result, is 4 ever allowed, and who decides when a project has 2 vs 3? UD's test scenario says "exactly 3". | M 6, 7.5, 18; UD 4.2, 30 |
| OQ-05 | Color-option count: is "2-3 per direction" (UD 4.3) the rule, or 2-3 overall (M 7.6 and M 26 are ambiguous)? Does "as applicable" allow a single palette? | M 7.6, 26; UD 4.3 |
| OQ-06 | Can the client mix a theme from one option with a palette linked to another theme? Color options are linked to a theme (M s12), but the client "selects theme and color combination". | M 7.11, 12; PM 4.5, 4.9 |
| OQ-07 | Does Admin approve a set of options or each option individually? Can PM share a subset (e.g. 2 of 3 approved, 1 sent back for EDIT)? | M 7.8, 7.9; PM 4.4 |
| OQ-08 | Who/what is the Internal Design Reviewer: an AI review agent (M s18 "review agents only"), a human, or either? What are the PASS/CHANGES_REQUIRED criteria thresholds? | M s4, s18, 7.7; UD 14 |
| OQ-09 | Which communication channel is used to share options with the client? M s10 names WhatsApp evidence; PM says "official project communication channel" and has a `channel` field. Can client see Figma links, or only previews? | M 10; PM 4.4, 14, PM3-05 |
| OQ-10 | Client no-response policy: follow-up cadence, number of reminders, timeout, and what happens after (PM 20 says only "policy-based follow-up"). | PM 20 |
| OQ-11 | Cost threshold values and the "policy action" when exceeded (alert only, block, pause?). Who is alerted? | M 22; UD 26; PM 17 |
| OQ-12 | Retry policy for provider/Figma/communication failures: counts, backoff, when to fall back to a manual/assisted step. | M 22; UD 26; PM 20 |
| OQ-13 | Whether the chosen Figma integration supports automated creation at all; the PDFs require inspection first and a manual/assisted fallback, but do not say which. | M 20, P3-05; UD 24 |
| OQ-14 | M 7.10 "Accepted design request goes to Figma Designer": who accepts, and by what criteria (PM classification only, or Admin too)? | M 7.10; PM 12 |
| OQ-15 | What is the escalation target and the allowed outcomes when the revision limit is hit (more rounds, paid change, scope change, stop)? Who owns the "governed decision"? | M 7.10, 16; PM 4.8; UD 16 |
| OQ-16 | The scope/change workflow that POSSIBLE_SCOPE_CHANGE routes into is referenced everywhere but never defined (owner, states, how Phase 3 resumes). | M 17; PM 4.6, 18; UD 17 |
| OQ-17 | The "new version/change process" for changing a locked final selection after lock is not defined. | M 16; PM 5; UD 4.9 |
| OQ-18 | "Version" semantics: what the duplicate-start guard keys on ("same project/version"), what `phase3_version` increments on, and how it relates to `design_context_version` and per-artifact versions (V1/V2/V3). | M 3, 11, 8; PM 2; UD 11, 12 |
| OQ-19 | How many representative screens per theme (UD 7 gives only minimums: at least one primary/home/dashboard, at least one content/detail/form/list). | UD 7 |
| OQ-20 | Accessibility standard and contrast threshold (UD 4.3 and 18 say "basic" contrast, "if included in requirements"). | UD 4.3, 18; M 7.7 |
| OQ-21 | Design-token format/export (Figma variables, JSON, other) for Phase 4 reuse; no schema is given. | M 7.6; UD 4.5, 13, 19 |
| OQ-22 | Model/provider routing rules ("lower-cost for simple, stronger for complex"): which tasks, which models, and who configures them. | M 6, 18; UD 10 |
| OQ-23 | Definition of P0/P1 severity for the Definition-of-Done gate. | M 28; PM 24; UD 31 |
| OQ-24 | Who sends Phase3Completed and Phase4Ready: Master says Workflow and Coordination respectively; PM says "produce/consume per policy/architecture". The completion trigger (automatic on confirmation or an explicit PM/Admin step?) is not fixed. | M 7.12, 15; PM 4.10, 16, PM3-10 |
| OQ-25 | Message templates in Hinglish: PM says "Hinglish-ready" but gives only English examples; language selection rule per client is not defined. | PM 10, 11 |
| OQ-26 | Image-generation usage-rights metadata fields are named but not specified. | UD 9, 23 |
| OQ-27 | Whether Phase 3 has any time SLA/target duration; none is stated anywhere. | all |
| OQ-28 | Whether the client's own reference (CLIENT_REFERENCE) may produce a new option, or only informs a revision; "Attach reference -> Designer review" does not say whether this triggers a full internal + Admin cycle and whether it counts as a revision. | PM 12; M 7.9 |
| OQ-29 | Reviewer/Admin SLAs, and what happens if Admin is unavailable (no escalation path described for waiting at WAITING_ADMIN). | PM 15; M 7.8 |
| OQ-30 | Which existing Phase 1/2 data counts as "confirmed preferences" and the conflict-resolution rule when brand assets and client references disagree ("missing/conflicting design-context resolver" has no rules). | M 7.2, P3-03; UD 3 |

---

## (b) Contradictions and inconsistencies between the three PDFs

| ID | Contradiction | Sources |
|---|---|---|
| C-01 | Ordering of announcement vs workflow start. M 7.1 says the announcement event starts the backend Phase 3 workflow. M s15 and PM3-01/PM 16 show Orchestrator emits Phase3Started first and PM then announces. | M 7.1 (p.4) vs M 15 (p.8), PM 6 PM3-01/02 (p.5), PM 16 (p.10) |
| C-02 | Three non-aligned state machines. Master Phase 3 states (e.g. COMPLETED, LOCKED, REVISION); PM states (PHASE3_COMPLETE, WAITING_*, CLIENT_REVIEW / WAITING_CLIENT / REVISION_COORDINATION); Designer Work Item states (CLIENT_FEEDBACK_WAIT, CLIENT_REVISION, FINAL_LOCK_READY). Completion is `COMPLETED` in M but `PHASE3_COMPLETE` in PM. No mapping is given; M has no BLOCKED/ESCALATED phase state while UD has five failure states. | M 14 (p.8), PM 15 (p.10), UD 21 (p.11) |
| C-03 | Theme Option state machine differs. M includes CHANGES_REQUIRED and ADMIN_EDIT branches inside the machine; UD's Theme Option machine omits CHANGES_REQUIRED and ADMIN_EDIT (they appear only in the Work Item machine). | M 14 (p.8) vs UD 21 (p.11) |
| C-04 | When the selection is locked. M s15: ClientDesignSelected -> "Lock selection" and the Theme Option machine goes CLIENT_SELECTED -> LOCKED with no confirmation step. M 7.11, PM 4.9 and PM 16 separate selection from explicit final confirmation (ClientFinalDesignConfirmed locks). UD: ClientDesignSelected -> "prepare final lock/handoff". | M 14/15 (p.8), M 7.11 (p.5), PM 16 (p.10), UD 22 (p.12) |
| C-05 | Event catalogue is not identical. In PM only: ScreenClarificationRequired, ClientReferenceReceived, ClientFinalDesignConfirmed. In UD only: DesignContextReady, ThemeGenerationRequested, InternalDesignChangesRequired, PossibleScopeChangeDetected. In M only: Phase2Completed (PM names it too), ScreenListDrafted. Producers also differ for Phase3Started (Orchestrator in M, Workflow in UD) and ClientDesignChangeRequested (PM/client in M, PM/workflow in UD). | M 15, PM 16, UD 22 |
| C-06 | Theme Option / Color Option field names and sets differ: M `name/title`, `description`, `design_direction_metadata`, `figma_file_reference`, `generation/revision origin`; UD `option_name`, `visual_direction_summary`, `figma_file_ref`, `design_token_refs`, `representative_screen_refs`, `generation/job id`, cost ref (no revision-origin field). Color: M `name` and token groups; UD `palette_name` plus semantic success/warning/error tokens and contrast notes (absent in M); M has review/admin/client status (UD has "version/status"). | M 11/12 (p.7) vs UD 12/13 (p.7-8) |
| C-07 | Designer start precondition. M orders "finalize screen list -> finalize screen content -> Figma Designer creates themes" and ScreenListFinalized opens generation. UD accepts "sufficiently defined" baseline and "finalized/working" screen list; PM input also "finalized/working". Whether theme work may begin on a non-finalized baseline is inconsistent. | M 2, 15 vs UD 2, 3; PM 3 |
| C-08 | Data model entities differ. UD adds DesignJob, DesignTokenSet, RepresentativeScreen, DesignAsset, DesignReviewLink, DesignHandoff; M has Phase3Workspace, DesignReview, AdminDesignDecision, ClientDesignDecision, Phase3Handoff (UD calls the handoff DesignHandoff). PM defines a separate communication/evidence contract (communication_id, channel, template version, delivery status...) with no matching M entity (M ClientDesignDecision holds only shared options/selection/feedback/evidence). | M 19 (p.10), UD 23 (p.12), PM 14 (p.9) |
| C-09 | Service/API signature names differ for the same capability: share (M `recordClientDesignShare` vs PM `recordDesignShare`), client response (M `recordClientDesignDecision` vs PM `recordClientDesignResponse`), revision (M `createDesignRevision` vs PM `createClientDesignRevision`), lock (M `lockPhase3Direction` vs PM `recordFinalDesignConfirmation` vs UD `preparePhase3DesignHandoff`), completion (M `completePhase3` vs PM `completePhase3PMHandoff`/`evaluatePhase3PMReadiness`). All three say "reuse existing conventions". | M 24 (p.13), PM 22 (p.14), UD 28 (p.16) |
| C-10 | Client-decision type names differ: PM 12 uses CLIENT_SELECTED, DESIGN_CHANGE_REQUEST, CLIENT_REFERENCE, POSSIBLE_SCOPE_CHANGE, CLARIFICATION_REQUIRED, FINAL_CONFIRMED; PM3-06 uses SELECT / CHANGE REQUEST / CLIENT REFERENCE; PM3-I07 omits CLARIFICATION_REQUIRED. UD flags "POSSIBLE_SCOPE_CHANGE" and the event is "PossibleScopeChangeDetected" produced by the Designer, while PM also detects scope change; who owns first detection is not stated (PM classifies first, Designer re-flags). | PM 12/6/21, UD 17/22 |
| C-11 | Option-count wording: M 7.5 "2-3 distinct" (no "approx."), M 18 "hard/default policy", UD/PM "approx. 2-3", UD test scenario "exactly 3". Whether 2-3 is a hard cap or a default is inconsistent. | M 7.5, 18; UD 4.2, 30; PM 17 |
| C-12 | Revision-limit trigger point: M "Beyond the limit, escalate" (exceeded) vs PM 4.8 "reached/exceeded" vs UD 16 "when the limit is reached" stop. Off-by-one is unresolved. | M 7.10 (p.5), PM 4.8 (p.3), UD 16 (p.9) |
| C-13 | Revision counting scope. PM 9 counts only client-requested rounds; M 16 requires "revision counter and origin" visible and M Phase3Workspace holds one "revision count"; M Admin Overview shows "revision count"; Admin EDIT revisions are versions with origin ADMIN, so it is unclear if the single counter excludes them. | PM 9 vs M 16, 19 |
| C-14 | Which roles are separate agents. M s4/s30 treat the Internal Design Reviewer as a distinct actor and ban "separate agents for work already owned by PM/Designer/Reviewer"; M s18 refers to "review agents only"; PM 26 bans a separate client Communication Agent; UD 33 bans merging Designer into PM. Whether the reviewer is an agent, human, or role of the Designer-side tooling is unstated (see OQ-08). | M 4, 18, 30; PM 26; UD 33 |
| C-15 | M s10 binds client evidence to WhatsApp ("WhatsApp evidence") while PM s14 only has a generic `channel` field and "official project communication channel". | M 10 vs PM 4.4, 14 |
| C-16 | Client reference flow: PM 12 sends CLIENT_REFERENCE to "Designer review" (no Internal Review/Admin stated), whereas M 7.10/16 require any client-originated design change to pass Designer, internal review, Admin review before re-share. | PM 12 vs M 16, UD 16 |
| C-17 | Admin Panel inventory differs by document: M s8 lists 13 areas (no separate Client Share Status/Representative Screens/Design Tokens); UD s20 lists 12 views including Screen Definitions, Internal Reviews, Admin Reviews, Client Share Status; PM s13 lists 10 surfaces including Client Share History with `channel`; M s10 suggests 11 UI views incl. Theme Studio/Color Studio not in the others. No consolidated list is given. Representative screens and design tokens are required entities (UD) but not in any Admin Panel list. | M 8/10, PM 13, UD 20 |
| C-18 | "Locked direction" mutability. M 16 says a later change creates a new version/change process, UD 19 says Phase 4 must not redo theme selection unless a governed change is introduced, PM 4.10 says the client should not need to reselect; none says who may start such a governed change. (Consistent in intent, but the three differ in naming: "new version/change process" vs "governed change".) | M 16, UD 19, PM 4.10 |
| C-19 | Clipped/overlapped PDF cells. M s4 (PM row Owns/Must-not-own text overlaps), M s8 (Cost/Usage row), PM s13 (Phase 4 Handoff row), PM s16 (Phase4Ready row), UD s20 (Cost/Usage row) render truncated; the content recorded above is the best legible reading and should be confirmed against the source documents. | M 4, 8; PM 13, 16; UD 20 |
