/**
 * The ONE basis for every finance total (PDF SCR-050 "Financial totals use
 * verified records") lives in `src/lib/finance/verified-basis.ts`, so that `src/lib/`
 * (the clients, dashboard and entity-preview readers) can use it without
 * depending on a module (ARCHITECTURE.md §3.2). This file keeps the path the
 * finance screens, the CSV routes and the tests have always imported.
 */
export * from '@/lib/finance/verified-basis';
