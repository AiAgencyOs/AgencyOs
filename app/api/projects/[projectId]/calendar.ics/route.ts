import { NextResponse } from 'next/server';

import { createAdminClient } from '@/lib/db/admin';
import { clientEnv } from '@/lib/env';
import { renderCalendarFeed, type CalendarFeedEntry } from '@/modules/projects/calendar-feed-schema';

/**
 * SCR-022 "Sync supported calendars" — the project's ICS feed
 * (migration 20261001120000). Public: whoever holds the token holds the
 * feed until the row is revoked, which is how every calendar app
 * subscribes to a URL. The service-role client is used here on purpose,
 * the share-link route's reasoning: there is no session, the token IS
 * the authorization — `projects.resolve_calendar_feed` (SECURITY DEFINER,
 * service_role only) answers nothing for an unknown or revoked token —
 * and every read below is scoped by the project id the token resolved
 * to, never by anything the request claims. 404 for an unknown, revoked
 * or malformed token alike, so a probe learns nothing.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

function notFound() {
  return NextResponse.json({ error: 'This feed is not valid. It may have been revoked.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const token = new URL(request.url).searchParams.get('token') ?? '';
  if (!TOKEN.test(token)) return notFound();

  const admin = createAdminClient();
  const { data, error } = await admin.schema('projects').rpc('resolve_calendar_feed', { p_token: token });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'calendar.feed.resolve', detail: error.message }));
    return NextResponse.json({ error: 'The feed could not be checked right now.' }, { status: 503 });
  }
  const feed = data?.[0];
  if (!feed || feed.project_id !== projectId) return notFound();

  const [tasks, milestones, project] = await Promise.all([
    admin.schema('projects').from('tasks').select('id, title, status, due_on').eq('project_id', feed.project_id).not('due_on', 'is', null).neq('status', 'done').neq('status', 'cancelled').is('archived_at', null),
    admin.schema('projects').from('milestones').select('id, name, status, due_on, met_at').eq('project_id', feed.project_id).not('due_on', 'is', null),
    admin.schema('projects').from('projects').select('opportunity_id').eq('id', feed.project_id).maybeSingle(),
  ]);
  if (tasks.error || milestones.error || project.error) {
    console.error(JSON.stringify({ level: 'error', scope: 'calendar.feed.read', detail: tasks.error?.message ?? milestones.error?.message ?? project.error?.message }));
    return NextResponse.json({ error: 'The project calendar could not be read right now.' }, { status: 503 });
  }

  const meetings = project.data?.opportunity_id
    ? await admin
        .schema('crm')
        .from('meetings')
        .select('id, status, booked_mode, requested_mode, confirmed_start_at, requested_start_at, meeting_url')
        .eq('opportunity_id', project.data.opportunity_id)
        .neq('status', 'cancelled')
    : { data: [], error: null };
  if (meetings.error) {
    console.error(JSON.stringify({ level: 'error', scope: 'calendar.feed.meetings', detail: meetings.error.message }));
    return NextResponse.json({ error: 'The project calendar could not be read right now.' }, { status: 503 });
  }

  const base = `${clientEnv.NEXT_PUBLIC_APP_URL}/projects/${feed.project_id}`;
  const entries: CalendarFeedEntry[] = [
    ...(tasks.data ?? []).map((t) => ({ uid: `task-${t.id}@agencyos`, summary: `Task: ${t.title}`, date: t.due_on as string, startAt: null, description: `Status: ${t.status}`, url: `${base}/board` })),
    ...(milestones.data ?? []).map((m) => ({ uid: `milestone-${m.id}@agencyos`, summary: `Milestone: ${m.name}`, date: m.due_on as string, startAt: null, description: m.met_at ? `Met ${m.met_at.slice(0, 10)}` : `Status: ${m.status}`, url: `${base}/plan` })),
    ...(meetings.data ?? [])
      .filter((m) => m.confirmed_start_at ?? m.requested_start_at)
      .map((m) => {
        const startAt = (m.confirmed_start_at ?? m.requested_start_at) as string;
        return { uid: `meeting-${m.id}@agencyos`, summary: `Meeting: ${(m.booked_mode ?? m.requested_mode ?? 'meeting').replace(/_/g, ' ')}`, date: startAt.slice(0, 10), startAt, description: `Status: ${m.status}`, url: `${clientEnv.NEXT_PUBLIC_APP_URL}/meetings/${m.id}` };
      }),
  ];
  entries.sort((a, b) => a.date.localeCompare(b.date));

  // Stamped to the newest fact rather than the wall clock, so an unchanged
  // feed renders the same bytes twice.
  const stamp = entries.length > 0 ? new Date().toISOString().slice(0, 13) + ':00:00.000Z' : '1970-01-01T00:00:00.000Z';
  const body = renderCalendarFeed({ calendarName: `${feed.project_name} — AgencyOS`, entries, stamp });
  return new NextResponse(body, {
    status: 200,
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="calendar.ics"', 'Cache-Control': 'no-store' },
  });
}
