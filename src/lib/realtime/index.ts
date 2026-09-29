/**
 * Live data for the admin panel.
 *
 *   topics.ts       — what a screen listens to, by business name
 *   connection.ts   — the status machine (pure, tested)
 *   use-live.ts     — the Supabase Realtime subscription (client)
 *   live-refresh.tsx — the control a page header carries (client)
 *
 * Pages import `LiveRefresh` from here and name their topics; nothing else
 * about a page changes. See docs/AGENCYOS_ADMIN_REALTIME_ARCHITECTURE.md.
 */
export { LiveRefresh } from './live-refresh';
export { useLive } from './use-live';
export { describeStatus, pollIntervalMs, reduceLive, initialLiveState, DEGRADED_AFTER_FAILURES } from './connection';
export type { LiveState, LiveStatus, LiveEvent } from './connection';
export { TOPICS, ALL_TOPICS, allPublishedTables, tablesFor, channelNameFor } from './topics';
export type { Topic, TableRef } from './topics';
