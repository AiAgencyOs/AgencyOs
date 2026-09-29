'use client';

import { useEffect, useState } from 'react';

import { generateMilestoneInvoiceAction } from '@/modules/finance/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import {
  createProjectManuallyAction,
  listClientAccountOptionsAction,
  listMilestoneOptionsAction,
  listProjectOptionsAction,
} from '@/modules/projects/project-create-actions';
import type { ClientAccountOption, MilestoneOption, ProjectOption } from '@/modules/projects/project-create-queries';
import { Button, Field, FormMessage, inputClass, selectClass } from '@/ui';

/**
 * Quick Create's two further forms — SCR-004 — inline in the ⌘K dialog like
 * the lead and client forms in command-palette.tsx.
 *
 * "Create project" is the by-hand door (`createProjectManually`): until it
 * existed the only project origin was a won deal. "Invoice from milestone"
 * is a picker over the same `generateMilestoneInvoiceAction` the project's
 * billing panel uses — project, then milestone, then the door — so every
 * refusal (no billing mode, no payment share, already invoiced) is the
 * service's own sentence, shown verbatim.
 */

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
}

export function CreateProjectForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (href: string) => void }) {
  const [clients, setClients] = useState<ClientAccountOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState({ clientAccountId: '', name: '', currency: 'INR', startsOn: '', endsOn: '', budget: '' });

  useEffect(() => {
    listClientAccountOptionsAction()
      .then((r) => (r.ok ? setClients(r.data) : setLoadError(r.error.message)))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Client accounts could not be read.'));
  }, []);

  const set = (key: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = e.target.value;
    setFields((f) => {
      const next = { ...f, [key]: value };
      // A client's own currency is the sensible default; the field stays editable.
      if (key === 'clientAccountId') {
        const chosen = clients?.find((c) => c.id === value);
        if (chosen) next.currency = chosen.currency;
      }
      return next;
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const budget = fields.budget.trim() ? Math.round(Number(fields.budget) * 100) : undefined;
    const result = await createProjectManuallyAction({
      clientAccountId: fields.clientAccountId,
      name: fields.name,
      currency: fields.currency,
      startsOn: fields.startsOn || undefined,
      endsOn: fields.endsOn || undefined,
      ...(budget !== undefined && Number.isFinite(budget) ? { budgetMinor: budget } : {}),
    });
    setSubmitting(false);
    if (!result.ok) return setError(result.error.message);
    onCreated(`/projects/${result.data.projectId}`);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 p-4">
      <h2 className="text-sm font-semibold text-foreground">New project</h2>

      <Field label="Client" htmlFor="qc-project-client" required hint={loadError ?? (clients === null ? 'Loading client accounts…' : clients.length === 0 ? 'No active client accounts. Create the client first.' : undefined)}>
        <select id="qc-project-client" required value={fields.clientAccountId} onChange={set('clientAccountId')} className={selectClass} disabled={clients === null || Boolean(loadError)}>
          <option value="">Choose a client…</option>
          {(clients ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Project name" htmlFor="qc-project-name" required>
        <input id="qc-project-name" required maxLength={200} value={fields.name} onChange={set('name')} className={inputClass} placeholder="e.g. Acme storefront rebuild" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Currency" htmlFor="qc-project-currency">
          <input id="qc-project-currency" value={fields.currency} onChange={set('currency')} maxLength={3} className={inputClass} />
        </Field>
        <Field label="Budget" htmlFor="qc-project-budget" hint="Optional, in major units.">
          <input id="qc-project-budget" type="number" min="0" step="0.01" value={fields.budget} onChange={set('budget')} className={inputClass} />
        </Field>
        <Field label="Starts on" htmlFor="qc-project-start">
          <input id="qc-project-start" type="date" value={fields.startsOn} onChange={set('startsOn')} className={inputClass} />
        </Field>
        <Field label="Ends on" htmlFor="qc-project-end">
          <input id="qc-project-end" type="date" value={fields.endsOn} onChange={set('endsOn')} className={inputClass} />
        </Field>
      </div>

      <FormMessage status={error ? 'error' : 'idle'} message={error} />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={submitting || !fields.clientAccountId}>
          {submitting ? 'Creating…' : 'Create project'}
        </Button>
      </div>
    </form>
  );
}

export function MilestoneInvoiceForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (href: string) => void }) {
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [milestones, setMilestones] = useState<MilestoneOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState('');
  const [milestoneId, setMilestoneId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ status: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    listProjectOptionsAction()
      .then((r) => (r.ok ? setProjects(r.data) : setLoadError(r.error.message)))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Projects could not be read.'));
  }, []);

  useEffect(() => {
    setMilestones(null);
    setMilestoneId('');
    if (!projectId) return;
    listMilestoneOptionsAction(projectId)
      .then((r) => (r.ok ? setMilestones(r.data) : setLoadError(r.error.message)))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Milestones could not be read.'));
  }, [projectId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setMessage(null);
    const formData = new FormData();
    formData.set('projectId', projectId);
    formData.set('milestoneId', milestoneId);
    const state = await generateMilestoneInvoiceAction(IDLE_STATE, formData);
    setSubmitting(false);
    if (state.status === 'error') return setMessage({ status: 'error', text: state.message ?? 'Refused.' });
    setMessage({ status: 'success', text: state.message ?? 'Draft created.' });
    onCreated(`/projects/${projectId}`);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 p-4">
      <h2 className="text-sm font-semibold text-foreground">Invoice from a milestone</h2>
      <p className="text-[13px] text-muted">
        Drafts the invoice for one milestone of the payment plan — the same door as the project&rsquo;s billing
        panel. Nothing is issued or sent from here.
      </p>

      <Field label="Project" htmlFor="qc-invoice-project" required hint={loadError ?? (projects === null ? 'Loading projects…' : undefined)}>
        <select id="qc-invoice-project" required value={projectId} onChange={(e) => setProjectId(e.target.value)} className={selectClass} disabled={projects === null}>
          <option value="">Choose a project…</option>
          {(projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.status.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Milestone"
        htmlFor="qc-invoice-milestone"
        required
        hint={
          !projectId
            ? 'Pick a project first.'
            : milestones === null
              ? 'Loading milestones…'
              : milestones.length === 0
                ? 'This project has no payment plan yet.'
                : undefined
        }
      >
        <select id="qc-invoice-milestone" required value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)} className={selectClass} disabled={!projectId || milestones === null}>
          <option value="">Choose a milestone…</option>
          {(milestones ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.position}. {m.name} · {m.status.replace(/_/g, ' ')}
              {m.paymentPercent === null ? ' · no payment share' : ` · ${money(m.amountMinor, m.currency)}`}
            </option>
          ))}
        </select>
      </Field>

      <FormMessage status={message?.status ?? 'idle'} message={message?.text} />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={submitting || !milestoneId}>
          {submitting ? 'Drafting…' : 'Generate draft'}
        </Button>
      </div>
    </form>
  );
}
