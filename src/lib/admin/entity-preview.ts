import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';
import { verifiedOn } from '@/lib/finance/verified-basis';

import { agencyClock } from './agency-clock';
import type { EntityPreview, PreviewFact, PreviewGroup } from './entity-preview-types';

/**
 * The quick-preview reader — SCR-002 "Quick preview drawer" (bucket F,
 * stream F-A). Reads the entity's header — what its own 360 page puts at
 * the top: name, status, a subtitle, the facts — under the same capability
 * and the same RLS as that page, so a preview can never show a row its
 * page would refuse. Money is `Intl.NumberFormat('en-IN')` over minor/100
 * and every instant goes through the agency clock, as everywhere else.
 */

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
}

const CAPABILITY: Record<PreviewGroup, Parameters<typeof can>[1]> = {
  Lead: 'lead.read',
  Client: 'project.read',
  Project: 'project.read',
  Invoice: 'invoice.read',
  Quotation: 'lead.read',
  Meeting: 'lead.read',
  Task: 'project.read',
  // SCR-037/043 (a build or prototype), SCR-046 (a run), SCR-047 (a bug): readable by whoever reads the project.
  Build: 'project.read',
  'Test Run': 'project.read',
  Bug: 'project.read',
  // SCR-053: money, behind the same capability as the invoice it settles.
  Payment: 'invoice.read',
};

export async function readEntityPreview(group: PreviewGroup, id: string): Promise<Result<EntityPreview>> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return err('VALIDATION', 'Not a record id.');
  const context = await requireInternal();
  if (!can(context, CAPABILITY[group])) return err('FORBIDDEN', 'You do not have permission to open this record.');
  const supabase = await createClient();
  const clock = await agencyClock();
  const notFound = () => err<EntityPreview>('NOT_FOUND', 'That record could not be read — it may have been removed.');
  const facts: PreviewFact[] = [];

  switch (group) {
    case 'Lead': {
      const { data, error } = await supabase
        .schema('crm')
        .from('leads')
        .select('id, title, status, source, service, next_follow_up_at, created_at, contact_id')
        .eq('id', id)
        .maybeSingle();
      if (error || !data) return notFound();
      let contact: { full_name: string; phone: string | null; company: string | null } | null = null;
      if (data.contact_id) {
        const { data: c } = await supabase.schema('crm').from('contacts').select('full_name, phone, company').eq('id', data.contact_id).maybeSingle();
        contact = c ?? null;
      }
      if (contact) facts.push({ label: 'Contact', value: contact.full_name });
      if (contact?.phone) facts.push({ label: 'Phone', value: contact.phone });
      facts.push({ label: 'Source', value: data.source });
      if (data.service) facts.push({ label: 'Service', value: data.service });
      if (data.next_follow_up_at) facts.push({ label: 'Next follow-up', value: clock.dateTime(data.next_follow_up_at) });
      facts.push({ label: 'Created', value: clock.date(data.created_at) });
      return ok({ group, id, name: data.title, status: data.status, subtitle: contact?.company ?? null, facts, href: `/leads/${id}` });
    }
    case 'Client': {
      const { data, error } = await supabase
        .schema('core')
        .from('client_accounts')
        .select('id, name, status, currency, billing_email, tags, created_at')
        .eq('id', id)
        .maybeSingle();
      if (error || !data) return notFound();
      facts.push({ label: 'Currency', value: data.currency });
      if (data.billing_email) facts.push({ label: 'Billing email', value: data.billing_email });
      if (data.tags.length > 0) facts.push({ label: 'Tags', value: data.tags.join(', ') });
      facts.push({ label: 'Client since', value: clock.date(data.created_at) });
      return ok({ group, id, name: data.name, status: data.status, subtitle: null, facts, href: `/clients/${id}` });
    }
    case 'Project': {
      const { data, error } = await supabase
        .schema('projects')
        .from('projects')
        .select('id, name, code, status, currency, budget_minor, starts_on, ends_on, client_account_id')
        .eq('id', id)
        .is('deleted_at', null)
        .maybeSingle();
      if (error || !data) return notFound();
      // The name only, through the door the finance role shares (decision 7, 2026-10-01).
      const { data: clientRows } = await supabase.schema('finance').rpc('client_names', { p_ids: [data.client_account_id] });
      const client = clientRows?.[0] ?? null;
      if (client) facts.push({ label: 'Client', value: client.name });
      if (data.budget_minor !== null) facts.push({ label: 'Budget', value: money(data.budget_minor, data.currency) });
      if (data.starts_on) facts.push({ label: 'Starts', value: clock.date(data.starts_on) });
      if (data.ends_on) facts.push({ label: 'Due', value: clock.date(data.ends_on) });
      return ok({ group, id, name: data.name, status: data.status, subtitle: data.code, facts, href: `/projects/${id}` });
    }
    case 'Invoice': {
      const { data, error } = await supabase
        .schema('finance')
        .from('invoices')
        .select('id, number, status, currency, total_minor, verified_minor, due_at, issued_at, client_account_id')
        .eq('id', id)
        .maybeSingle();
      if (error || !data) return notFound();
      const { data: client } = await supabase.schema('core').from('client_accounts').select('name').eq('id', data.client_account_id).maybeSingle();
      facts.push({ label: 'Total', value: money(data.total_minor, data.currency) });
      // Verified payments only: the one basis (verified-basis.ts).
      if (verifiedOn(data) > 0) facts.push({ label: 'Paid (verified)', value: money(verifiedOn(data), data.currency) });
      if (data.issued_at) facts.push({ label: 'Issued', value: clock.date(data.issued_at) });
      if (data.due_at) facts.push({ label: 'Due', value: clock.date(data.due_at) });
      return ok({ group, id, name: data.number, status: data.status, subtitle: client?.name ?? null, facts, href: `/invoices/${id}` });
    }
    case 'Quotation': {
      const { data, error } = await supabase
        .schema('sales')
        .from('proposals')
        .select('id, title, version, status, currency, total_minor, valid_until, sent_at, opportunity_id')
        .eq('id', id)
        .maybeSingle();
      if (error || !data) return notFound();
      const { data: opp } = await supabase.schema('sales').from('opportunities').select('name, lead_id').eq('id', data.opportunity_id).maybeSingle();
      facts.push({ label: 'Total', value: money(data.total_minor, data.currency) });
      if (data.valid_until) facts.push({ label: 'Valid until', value: clock.date(data.valid_until) });
      if (data.sent_at) facts.push({ label: 'Sent', value: clock.dateTime(data.sent_at) });
      return ok({
        group,
        id,
        name: `${data.title} (v${data.version})`,
        status: data.status,
        subtitle: opp?.name ?? null,
        facts,
        href: opp?.lead_id ? `/leads/${opp.lead_id}#quotations` : '/quotations',
      });
    }
    case 'Meeting': {
      const { data, error } = await supabase
        .schema('crm')
        .from('meetings')
        .select('id, purpose, status, requested_mode, confirmed_start_at, requested_start_at, duration_minutes, lead_id')
        .eq('id', id)
        .maybeSingle();
      if (error || !data) return notFound();
      const { data: lead } = await supabase.schema('crm').from('leads').select('title').eq('id', data.lead_id).maybeSingle();
      const at = data.confirmed_start_at ?? data.requested_start_at;
      facts.push({ label: 'Mode', value: data.requested_mode.replace(/_/g, ' ') });
      facts.push({ label: data.confirmed_start_at ? 'Confirmed for' : 'Requested for', value: at ? clock.dateTime(at) : 'time not yet agreed' });
      if (data.duration_minutes) facts.push({ label: 'Duration', value: `${data.duration_minutes} min` });
      return ok({ group, id, name: lead?.title ?? data.purpose ?? 'Meeting', status: data.status, subtitle: data.purpose, facts, href: `/meetings/${id}` });
    }
    case 'Task': {
      const { data, error } = await supabase
        .schema('projects')
        .from('tasks')
        .select('id, title, status, priority, due_on, project_id, assignee_id')
        .eq('id', id)
        .maybeSingle();
      if (error || !data) return notFound();
      const [{ data: project }, { data: assignee }] = await Promise.all([
        supabase.schema('projects').from('projects').select('name').eq('id', data.project_id).maybeSingle(),
        data.assignee_id
          ? supabase.schema('core').from('users').select('full_name, email').eq('id', data.assignee_id).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);
      facts.push({ label: 'Priority', value: data.priority });
      if (data.due_on) facts.push({ label: 'Due', value: clock.date(data.due_on) });
      if (assignee) facts.push({ label: 'Assignee', value: assignee.full_name || assignee.email });
      return ok({ group, id, name: data.title, status: data.status, subtitle: project?.name ?? null, facts, href: `/projects/${data.project_id}/development/tasks/${id}` });
    }
    case 'Build': {
      const { data, error } = await supabase
        .schema('projects')
        .from('deliverables')
        .select('id, kind, version, title, status, project_id, created_at')
        .eq('id', id)
        .maybeSingle();
      if (error || !data) return notFound();
      const [{ data: project }, { data: details }] = await Promise.all([
        supabase.schema('projects').from('projects').select('name').eq('id', data.project_id).maybeSingle(),
        supabase.schema('projects').from('deliverable_details').select('platform, admin_status, qa_status, commit_ref, build_number').eq('deliverable_id', id).maybeSingle(),
      ]);
      facts.push({ label: 'Kind', value: data.kind });
      facts.push({ label: 'Version', value: `v${data.version}` });
      if (details?.platform) facts.push({ label: 'Platform', value: details.platform.replace(/_/g, ' ') });
      if (details?.admin_status) facts.push({ label: 'Admin', value: details.admin_status.replace(/_/g, ' ') });
      if (details?.qa_status) facts.push({ label: 'QA', value: details.qa_status.replace(/_/g, ' ') });
      if (details?.build_number) facts.push({ label: 'Build number', value: details.build_number });
      if (details?.commit_ref) facts.push({ label: 'Built from', value: details.commit_ref });
      facts.push({ label: 'Added', value: clock.date(data.created_at) });
      const href = data.kind === 'prototype' ? `/projects/${data.project_id}/prototype/builds/${id}` : data.kind === 'build' ? `/projects/${data.project_id}/builds` : `/projects/${data.project_id}/design`;
      return ok({ group, id, name: data.title, status: data.status, subtitle: project?.name ?? null, facts, href });
    }
    case 'Test Run': {
      const { data, error } = await supabase
        .schema('qa')
        .from('test_runs')
        .select('id, project_id, deliverable_id, suite, status, total, passed, failed, skipped, blocked, environment, device, browser, started_at, ended_at, executed_at')
        .eq('id', id)
        .maybeSingle();
      if (error || !data) return notFound();
      const [{ data: project }, { data: build }] = await Promise.all([
        supabase.schema('projects').from('projects').select('name').eq('id', data.project_id).maybeSingle(),
        data.deliverable_id ? supabase.schema('projects').from('deliverables').select('title, version').eq('id', data.deliverable_id).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      facts.push({ label: 'Result', value: `${data.passed} passed · ${data.failed} failed · ${data.blocked} blocked · ${data.skipped} skipped of ${data.total}` });
      if (build) facts.push({ label: 'Build', value: `${build.title} v${build.version}` });
      if (data.environment) facts.push({ label: 'Environment', value: data.environment });
      if (data.device || data.browser) facts.push({ label: 'Device', value: [data.device, data.browser].filter(Boolean).join(' · ') });
      facts.push({ label: 'Executed', value: clock.dateTime(data.executed_at) });
      return ok({ group, id, name: `${data.suite.replace(/_/g, ' ')} run`, status: data.status, subtitle: project?.name ?? null, facts, href: `/projects/${data.project_id}/qa/runs/${id}` });
    }
    case 'Bug': {
      const { data, error } = await supabase
        .schema('qa')
        .from('defects')
        .select('id, title, severity, status, project_id, environment, assignee_id, task_id, created_at')
        .eq('id', id)
        .maybeSingle();
      if (error || !data) return notFound();
      const [{ data: project }, { data: assignee }] = await Promise.all([
        supabase.schema('projects').from('projects').select('name').eq('id', data.project_id).maybeSingle(),
        data.assignee_id ? supabase.schema('core').from('users').select('full_name, email').eq('id', data.assignee_id).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      facts.push({ label: 'Severity', value: data.severity });
      if (data.environment) facts.push({ label: 'Environment', value: data.environment });
      facts.push({ label: 'Assigned developer', value: assignee ? assignee.full_name || assignee.email : 'Unassigned' });
      facts.push({ label: 'Raised', value: clock.date(data.created_at) });
      return ok({ group, id, name: data.title, status: data.status, subtitle: project?.name ?? null, facts, href: `/projects/${data.project_id}/qa/bugs/${id}` });
    }
    case 'Payment': {
      const { data, error } = await supabase
        .schema('finance')
        .from('payments')
        .select('id, invoice_id, provider, provider_payment_id, amount_minor, currency, status, captured_at, verified_at')
        .eq('id', id)
        .maybeSingle();
      if (error || !data) return notFound();
      const { data: invoice } = await supabase.schema('finance').from('invoices').select('number').eq('id', data.invoice_id).maybeSingle();
      facts.push({ label: 'Amount', value: money(data.amount_minor, data.currency) });
      facts.push({ label: 'Source', value: data.provider === 'manual' ? 'recorded by hand' : data.provider });
      if (data.captured_at) facts.push({ label: 'Captured', value: clock.dateTime(data.captured_at) });
      facts.push({ label: 'Verified', value: data.verified_at ? clock.dateTime(data.verified_at) : 'Not verified' });
      return ok({ group, id, name: `Payment ${data.provider_payment_id}`, status: data.verified_at ? 'verified' : data.status, subtitle: invoice?.number ?? null, facts, href: `/finance/payments/${id}` });
    }
  }
}
