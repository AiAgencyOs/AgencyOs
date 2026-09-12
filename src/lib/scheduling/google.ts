import 'server-only';

import { createSign } from 'node:crypto';

import { serverEnv } from '@/lib/env';

import type { AvailabilityAnswer, Slot } from './availability';

/**
 * Google Calendar + Meet — the calendar adapter ADM-102 chose (G-242).
 *
 * Behind the ports G-226 and G-227 built: `readAvailability` answers `read`
 * with what the calendar said or `unreadable` with why, never a plausible
 * invention; `createEvent` returns the provider's event id and the Meet link
 * it generated, or a named refusal — §6.3 "verify provider response before
 * reporting success", §14 "provider outage must never produce a false
 * booking success".
 *
 * ── the credential ────────────────────────────────────────────────────────
 *
 * A service account with domain-wide delegation, acting as the mailbox the
 * agency books against: the server-to-server shape a Workspace admin can
 * create without a browser consent screen, and the one under which Google
 * will attach a Meet link. Four values, all placed by the owner in the
 * deployment environment, none read anywhere but serverEnv():
 *
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL     the account's client_email
 *   GOOGLE_SERVICE_ACCOUNT_KEY       its private_key (PEM; \n escapes accepted)
 *   GOOGLE_CALENDAR_ID               the calendar booked against, e.g. meetings@…
 *   GOOGLE_IMPERSONATE               the Workspace user the account acts as
 *                                    (defaults to the calendar id)
 *
 * Unset, and the adapter does not register: availability keeps answering
 * `unconfigured`, exactly as before this file existed (BLK-005).
 *
 * ── what it does not do ───────────────────────────────────────────────────
 *
 * It does not choose slots, rank them or decide working hours: §5's filters
 * and ranking are the pure functions beside this file, applied to what was
 * READ. It stores nothing: the row (`crm.meetings`) is the only record, and
 * the provider's event id is mapped onto it by `crm.book_meeting`. It signs
 * one JWT per call rather than caching a token across a process's life —
 * a bounded, stateless adapter is one a serverless runner can trust.
 */

const PROVIDER = 'google';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_URL = 'https://www.googleapis.com/calendar/v3';
const SCOPES = 'https://www.googleapis.com/auth/calendar';
const REQUEST_TIMEOUT_MS = 20_000;

export type GoogleCalendarConfig = {
  serviceAccountEmail: string;
  privateKeyPem: string;
  calendarId: string;
  impersonate: string;
  tokenUrl: string;
  calendarUrl: string;
};

export type CreateEventRequest = {
  summary: string;
  description?: string;
  startAt: string;
  endAt: string;
  timezone: string;
  /** Idempotency key for the Meet conference request; the booking key is the natural one. */
  requestId: string;
  attendees?: readonly { email: string }[];
  withMeet: boolean;
};

/**
 * A created event, with the Meet request's own state said separately: Google
 * can accept the event and answer that the conference is still `pending`
 * or `failed` (the impersonated user is not a Workspace user with Meet, say).
 * `ok` is the EVENT; a caller that needs a link checks `meet` before telling
 * a client one exists — review found the first draft folding both into ok.
 */
export type MeetState = 'created' | 'pending' | 'failed' | 'not_requested';
export type CreateEventResult =
  | { ok: true; eventId: string; meetUrl: string | null; meet: MeetState; htmlLink: string | null }
  | { ok: false; permanent: boolean; message: string };

export type CalendarAdapter = {
  readonly id: string;
  readonly calendarId: string;
  readAvailability(window: { from: string; to: string }): Promise<AvailabilityAnswer>;
  createEvent(request: CreateEventRequest): Promise<CreateEventResult>;
  cancelEvent(eventId: string): Promise<{ ok: true; outcome: 'cancelled' | 'already_gone' } | { ok: false; permanent: boolean; message: string }>;
};

function trimmed(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

/** The configuration from the environment, or null when the owner has not placed it. */
export function googleCalendarConfig(): GoogleCalendarConfig | null {
  const env = serverEnv();
  const serviceAccountEmail = trimmed(env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  const key = trimmed(env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const calendarId = trimmed(env.GOOGLE_CALENDAR_ID);
  if (!serviceAccountEmail || !key || !calendarId) return null;
  return {
    serviceAccountEmail,
    // A PEM pasted into an environment variable arrives with literal "\n",
    // sometimes CRLF, sometimes wrapped in the quotes the JSON file had.
    privateKeyPem: key.replace(/^"|"$/g, '').replace(/\\r\\n|\\n/g, '\n').replace(/\r\n/g, '\n'),
    calendarId,
    impersonate: trimmed(env.GOOGLE_IMPERSONATE) ?? calendarId,
    tokenUrl: env.GOOGLE_OAUTH_BASE_URL ? `${env.GOOGLE_OAUTH_BASE_URL.replace(/\/$/, '')}/token` : TOKEN_URL,
    calendarUrl: env.GOOGLE_CALENDAR_BASE_URL ? env.GOOGLE_CALENDAR_BASE_URL.replace(/\/$/, '') : CALENDAR_URL,
  };
}

export function createGoogleCalendar(config: GoogleCalendarConfig | null = googleCalendarConfig()): CalendarAdapter | null {
  if (!config) return null;
  const source = { provider: PROVIDER, calendarId: config.calendarId };

  return {
    id: PROVIDER,
    calendarId: config.calendarId,

    async readAvailability(window) {
      const token = await accessToken(config);
      if (!token.ok) return { state: 'unreadable', source, reason: token.message };
      const answer = await call(config, token.value, 'POST', '/freeBusy', {
        timeMin: window.from,
        timeMax: window.to,
        items: [{ id: config.calendarId }],
      });
      if (!answer.ok) return { state: 'unreadable', source, reason: answer.message };
      const calendars = (answer.json as { calendars?: Record<string, { busy?: { start?: string; end?: string }[]; errors?: unknown[] }> }).calendars ?? {};
      const entry = calendars[config.calendarId];
      if (!entry) return { state: 'unreadable', source, reason: 'Google answered, but not about the calendar asked for.' };
      if (entry.errors && entry.errors.length > 0) return { state: 'unreadable', source, reason: 'Google reported an error for this calendar (is the account allowed to read it?).' };
      const busy = (entry.busy ?? [])
        .map((b) => ({ startAt: String(b.start ?? ''), endAt: String(b.end ?? '') }))
        .filter((b) => Number.isFinite(Date.parse(b.startAt)) && Number.isFinite(Date.parse(b.endAt)));
      return { state: 'read', source, readAt: new Date().toISOString(), slots: freeWindows(window, busy) };
    },

    async createEvent(request) {
      const token = await accessToken(config);
      if (!token.ok) return { ok: false, permanent: token.permanent, message: token.message };
      const body: Record<string, unknown> = {
        summary: request.summary,
        ...(request.description ? { description: request.description } : {}),
        start: { dateTime: request.startAt, timeZone: request.timezone },
        end: { dateTime: request.endAt, timeZone: request.timezone },
        ...(request.attendees?.length ? { attendees: request.attendees } : {}),
        ...(request.withMeet
          ? { conferenceData: { createRequest: { requestId: request.requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } } }
          : {}),
      };
      // sendUpdates=none, explicitly: Google does not email the attendees.
      // The client is told by AgencyOS itself (§6.4's confirmation message,
      // on the channel they wrote on), so the link reaches them once, from
      // one sender, in their language — not twice, once in Google's.
      const answer = await call(
        config,
        token.value,
        'POST',
        `/calendars/${encodeURIComponent(config.calendarId)}/events?conferenceDataVersion=1&sendUpdates=none`,
        body,
      );
      if (!answer.ok) return { ok: false, permanent: answer.permanent, message: answer.message };
      const event = answer.json as {
        id?: unknown; hangoutLink?: unknown; htmlLink?: unknown;
        conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[]; createRequest?: { status?: { statusCode?: unknown } } };
      };
      // §6.3: the provider's response is VERIFIED before success is reported.
      // An answer without an id is not an event, whatever the status code.
      if (typeof event.id !== 'string' || event.id === '') {
        return { ok: false, permanent: false, message: 'Google answered without an event id; the booking is not confirmed.' };
      }
      const meetUrl =
        typeof event.hangoutLink === 'string'
          ? event.hangoutLink
          : (event.conferenceData?.entryPoints ?? []).find((e) => e.entryPointType === 'video')?.uri ?? null;
      const requested = event.conferenceData?.createRequest?.status?.statusCode;
      const meet: MeetState =
        !request.withMeet ? 'not_requested'
        : meetUrl ? 'created'
        : requested === 'failure' ? 'failed'
        : requested === 'pending' ? 'pending'
        : 'failed';
      return { ok: true, eventId: event.id, meetUrl, meet, htmlLink: typeof event.htmlLink === 'string' ? event.htmlLink : null };
    },

    async cancelEvent(eventId) {
      const token = await accessToken(config);
      if (!token.ok) return { ok: false, permanent: token.permanent, message: token.message };
      const answer = await call(config, token.value, 'DELETE', `/calendars/${encodeURIComponent(config.calendarId)}/events/${encodeURIComponent(eventId)}`);
      if (answer.ok) return { ok: true, outcome: 'cancelled' };
      if (answer.status === 404 || answer.status === 410) return { ok: true, outcome: 'already_gone' };
      return { ok: false, permanent: answer.permanent, message: answer.message };
    },
  };
}

/**
 * Free windows inside `window` once the busy blocks are taken out. Busy
 * blocks are merged first (Google returns them unsorted and may overlap), and
 * a window shorter than a minute is not offered. The result is what §5.1's
 * filters narrow further; nothing here invents.
 */
export function freeWindows(window: { from: string; to: string }, busy: readonly Slot[]): Slot[] {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const blocks = busy
    .map((b) => ({ s: Math.max(Date.parse(b.startAt), from), e: Math.min(Date.parse(b.endAt), to) }))
    .filter((b) => b.e > b.s)
    .sort((a, b) => a.s - b.s);
  const merged: { s: number; e: number }[] = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && b.s <= last.e) last.e = Math.max(last.e, b.e);
    else merged.push({ ...b });
  }
  const free: Slot[] = [];
  let cursor = from;
  for (const b of merged) {
    if (b.s - cursor >= 60_000) free.push({ startAt: new Date(cursor).toISOString(), endAt: new Date(b.s).toISOString() });
    cursor = Math.max(cursor, b.e);
  }
  if (to - cursor >= 60_000) free.push({ startAt: new Date(cursor).toISOString(), endAt: new Date(to).toISOString() });
  return free;
}

/** The service-account JWT exchanged for a bearer token (RFC 7523), signed with node:crypto — no SDK. */
export function serviceAccountAssertion(config: GoogleCalendarConfig, nowSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'RS256', typ: 'JWT' });
  const claims = b64({
    iss: config.serviceAccountEmail,
    sub: config.impersonate,
    scope: SCOPES,
    aud: config.tokenUrl,
    iat: nowSeconds,
    exp: nowSeconds + 300,
  });
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).end().sign(config.privateKeyPem).toString('base64url');
  return `${header}.${claims}.${signature}`;
}

type TokenResult = { ok: true; value: string } | { ok: false; permanent: boolean; message: string };

async function accessToken(config: GoogleCalendarConfig): Promise<TokenResult> {
  let assertion: string;
  try {
    assertion = serviceAccountAssertion(config, Math.floor(Date.now() / 1000));
  } catch {
    return { ok: false, permanent: true, message: 'The Google service-account key could not be used to sign a request (is GOOGLE_SERVICE_ACCOUNT_KEY a PEM private key?).' };
  }
  let response: Response;
  let raw: string;
  try {
    response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    raw = await response.text();
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
    return { ok: false, permanent: false, message: timedOut ? 'Google did not answer the token request in time.' : 'Could not reach Google to sign in.' };
  }
  if (!response.ok) {
    console.error(JSON.stringify({ level: 'error', scope: 'google.token', status: response.status, detail: redact(config, raw).slice(0, 300) }));
    return {
      ok: false,
      permanent: response.status >= 400 && response.status < 500 && response.status !== 429,
      message: response.status === 400 || response.status === 401
        ? 'Google rejected the service-account credential (check the email, the key, and that the account may act as the calendar’s user).'
        : `Google answered ${response.status} to the token request.`,
    };
  }
  let token: unknown;
  try { token = (JSON.parse(raw) as { access_token?: unknown }).access_token; } catch { token = undefined; }
  if (typeof token !== 'string' || token === '') return { ok: false, permanent: false, message: 'Google answered the token request without a token.' };
  return { ok: true, value: token };
}

type CallResult = { ok: true; status: number; json: unknown } | { ok: false; status: number; permanent: boolean; message: string };

async function call(config: GoogleCalendarConfig, token: string, method: string, path: string, body?: unknown): Promise<CallResult> {
  let response: Response;
  let raw: string;
  try {
    response = await fetch(`${config.calendarUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    raw = await response.text();
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
    return { ok: false, status: 0, permanent: false, message: timedOut ? 'Google Calendar did not answer in time.' : 'Could not reach Google Calendar.' };
  }
  if (!response.ok) {
    console.error(JSON.stringify({ level: 'error', scope: 'google.calendar', status: response.status, path, detail: redact(config, raw).slice(0, 300) }));
    const detail = (() => { try { return (JSON.parse(raw) as { error?: { message?: unknown } }).error?.message; } catch { return undefined; } })();
    return {
      ok: false,
      status: response.status,
      // The token is minted per call, so a 401 here is a moment (revocation
      // propagating, clock skew), not a configuration: transient, like 429.
      permanent: response.status >= 400 && response.status < 500 && response.status !== 429 && response.status !== 401,
      message:
        response.status === 401 ? 'Google did not accept the token for this request. The job will be retried.'
        : response.status === 403 ? 'Google refused: the account may not use this calendar.'
        : response.status === 404 ? 'Google has no such calendar or event.'
        : response.status === 429 ? 'Rate limited by Google.'
        : typeof detail === 'string' ? `Google answered ${response.status}: ${redact(config, detail).slice(0, 200)}`
        : `Google answered ${response.status}.`,
    };
  }
  if (raw.trim() === '') return { ok: true, status: response.status, json: null };
  try { return { ok: true, status: response.status, json: JSON.parse(raw) }; } catch { return { ok: false, status: response.status, permanent: false, message: 'Google answered with something that was not JSON.' }; }
}

/** The private key and any bearer token, out of anything that reaches a log. */
function redact(config: GoogleCalendarConfig, text: string): string {
  return text.split(config.privateKeyPem).join('[redacted]').replace(/ya29\.[A-Za-z0-9_-]+/g, '[redacted]');
}
