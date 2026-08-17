/**
 * A failed outbound message, reduced to what the operations screen may show.
 *
 * Pure and dependency-free, like `backlog.ts` and `jobs/staleness.ts`: the
 * shaping — which fact is the reason, how long a preview is allowed to be — is
 * the only judgement here, and it is worth testing without a database.
 *
 * The delivery state lives in `crm.conversation_messages.metadata`, stamped by
 * `crm.mark_outbound_delivery`: `{delivery:'failed', error:'…', provider_ref:'…'}`.
 * Only OUTBOUND messages carry a `delivery` key at all, so a row reaching this
 * function is our own message that did not reach the customer — the body is our
 * outgoing text, not a client's words, and `error` is the provider's own
 * message, not a secret. `provider_ref` is Meta's public message id.
 */

/** The raw shape the query hands over — the message row, metadata unparsed. */
export type FailedDeliveryRow = {
  authorType: string;
  body: string;
  metadata: Record<string, unknown> | null;
  occurredAt: string;
};

export type FailedDeliveryView = {
  authorType: string;
  /** The provider's error as written, or a stated fallback when none was recorded. */
  reason: string;
  /** A bounded, single-line preview of what we tried to send — never the whole body. */
  preview: string;
  /** Meta's message id if present — a public reference, never a secret. */
  providerRef: string | null;
  occurredAt: string;
};

const PREVIEW_MAX = 140;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Collapse newlines and clip, so a multi-line message stays one readable line. */
function previewOf(body: string): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  return oneLine.length > PREVIEW_MAX ? `${oneLine.slice(0, PREVIEW_MAX - 1)}…` : oneLine;
}

/**
 * A message the provider rejected, as the operator should read it. The reason
 * is the provider's own error where one was recorded; where none was — a failure
 * stamped with no `error` — that absence is itself worth saying, not hidden
 * behind an empty string, because a failed send with no reason is a real gap.
 */
export function viewFailedDelivery(row: FailedDeliveryRow): FailedDeliveryView {
  const meta = row.metadata ?? {};
  return {
    authorType: row.authorType,
    reason: str(meta.error) ?? 'No provider error was recorded — worth investigating.',
    preview: previewOf(row.body),
    providerRef: str(meta.provider_ref),
    occurredAt: row.occurredAt,
  };
}
