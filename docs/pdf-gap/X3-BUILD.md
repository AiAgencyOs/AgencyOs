# X3 — Search by meaning (owner decision 14: AI / semantic search over everything searchable)

Migration: `supabase/migrations/20261007300000_search_by_meaning.sql` (additive, applied twice locally, idempotent).
Verifier: `scripts/verify-semantic-search.mjs` (`npm run db:verify:semantic`, step in `.github/workflows/verify.yml`). Tests: `tests/search-by-meaning.test.ts` (16, fake deterministic embedding).

## What was built

| Requirement | Status | Where / how verified |
|---|---|---|
| Embeddings as `real[]`, no pgvector dependency | BUILT | `core.search_embeddings` (org, entity_type, entity_id, content_hash, embedding real[], norm, model, updated_at), RLS forced, no policy and no grant for authenticated; 512 dimensions |
| Cosine in a security-definer function over a bounded set, org + role scoped | BUILT | `core.semantic_search` (cap 20,000 most recently indexed rows, limit 40, min score 0.25) and `core.semantic_visible_types()` (mirrors lead.read / project.read / invoice.read / audit.read through `core.holds_role`, so granted roles count). Verified live: finance sees Invoice only, member no Invoice/Audit/Agent, contractor no Lead, owner all 11 |
| A result a role cannot open is never returned | BUILT | Three layers: `can()` filters types in the app, the SQL function filters again, then every hit is re-read through the caller's own RLS (soft-deleted rows dropped) in `src/lib/search/semantic-search.ts`. The vectors table stores no text, so there is nothing to leak. Hydration under RLS is exercised by the page screenshot, not by the verifier (a contractor's per-project RLS is therefore not asserted live) |
| Embeddings table per organisation, no direct write grant | BUILT | Writes only via service-role doors `core.upsert_search_embeddings` / `core.delete_search_embeddings`; verifier proves a session cannot read, insert, or call the door (403) |
| Indexing job on the existing runner, batches, content-hash skip | BUILT | `src/lib/search/semantic-indexer.ts`, called from `app/api/jobs/run/route.ts`. One page of 100 per type per tick, at most 300 embeds per tick, batches of 50. Verified: 3 further passes over unchanged records embed 0; a changed record embeds exactly once |
| Provider key resolver | BUILT | `src/lib/search/embedding-provider.ts`: `resolveSecret('OPENAI_API_KEY')`, else `OPENROUTER_API_KEY`. None = off with an explanatory state (page card and notice; unit-covered message map); keyword search unchanged |
| Spend through the AI cost ledger and budget gates | BUILT | `ai.record_embedding_usage` writes `ai.cost_ledger` under the new infrastructure key `semantic_indexer` (new nullable `provider` column; an `ai.agents` row is inserted for the FK). `ai.provider_spend_this_month` / `ai.model_spend_this_month` now include that spend. The job calls `refuseIfOverBudget` before each batch; a refusal parks the job `blocked` with the reason and retries every 30 minutes. Query embeddings are recorded by `ai.record_query_embedding_usage` (clamped) and gated by `ai.semantic_budget_allows`. Verified live (cap reached: blocked, 0 embeds after; lifted: resumes) |
| Never embed secrets / credentials / vault values | BUILT | Columns are listed per source (no gstin, pan, billing address, file url, storage path, vault); `embeddable-text.ts` withholds any field matching `SECRET_PATTERNS`, password lines, secret query strings or URL passwords; a record with nothing safe left has its vector removed. A query that looks like a credential is not sent to the vendor. Verified live (a name containing an Anthropic-shaped key never reached the vendor) and in unit tests |
| Search-mode toggle on /search; palette stays keyword-only | BUILT | Keyword / Meaning / Both chips (`?mode=`; default keyword). The palette (`global-search.ts`) is untouched |
| Results show which mode matched | BUILT | Badge per row: Keyword match / Meaning match · 82% / Keyword and meaning · 82%. Both ordering: both, meaning by score, keyword newest first (unit-tested) |
| Owner backfill with cost estimate first, confirm step, progress | BUILT | "Index everything…" -> `?backfill=confirm` shows records, tokens (4 chars/token), per-type counts, withheld-field count and cost; Confirm calls the audited owner door `core.request_semantic_backfill`. Progress bar reads `core.semantic_search_state` (done / total, status, note). "Turn off" via `core.stop_semantic_indexing` (owner, audited) |
| Honest scaling limit | BUILT | Card help text on /search and the notes below |
| Tests: ranking, role scoping, hash-skip, budget refusal, secret exclusion | BUILT | Ranking, scoping, hash-skip, budget, secret exclusion in the live verifier; hash-skip, budget refusal, secret exclusion, merge/ordering, role-to-type mapping in unit tests with a fake embed function |

## Honest limits and decisions

- **Scaling.** The scan is `real[]` arithmetic in SQL over at most 20,000 recent vectors per query. Fine for tens of thousands of rows; it slows linearly beyond. Production upgrade: a pgvector column with an HNSW index behind the same `core.semantic_search` signature (pgvector is not available locally, so it was not built or tested).
- **Cost shown only when a price exists.** The estimate multiplies tokens by `ai.models.input_cost_minor_per_mtok` for the embedding model; if the owner has not entered a price the screen shows tokens and says the cost cannot be shown, and the ledger records tokens with cost 0 (never guessed). Budget gates therefore bite only once a price is set or other spend accrues.
- **Estimate** reads up to 50,000 rows per type (flagged "At least" if truncated) and counts rows already indexed again.
- **Audit events** are indexed for the last 90 days only. Agents are embedded from the code registry.
- **Orphans.** A hard-deleted record's vector is not pruned, but it is never shown (the RLS re-read drops it); soft-deleted records are pruned on the next scan.
- Meaning results are capped at 40 and require cosine >= 0.25 (tune with a real model).
- Changing the embedding model/provider re-embeds everything (hash includes model and size); search says "being rebuilt" meanwhile.
- Local stack has a (fake) OPENAI key and base URL, so the card shows "Off" with the Index button; no key = "Off — no embedding key".

## Owner questions

1. Enter a price per million tokens for `text-embedding-3-small` (and the OpenRouter id) under Settings > Models so cost estimates and budget caps include embedding spend. Which figure should be used?
2. Is 90 days of audit events enough, or should the whole audit log be searchable by meaning?

## Known unrelated failure

`tests/read-failure-semantics.test.ts` currently fails to load (env validation thrown while importing `src/modules/finance/queries.ts`); finance files are being edited by another stream and nothing here is imported by them.
