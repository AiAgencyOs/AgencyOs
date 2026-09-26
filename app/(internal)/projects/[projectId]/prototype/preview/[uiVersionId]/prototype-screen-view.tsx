'use client';

import { useState } from 'react';

import type { PrototypeArtifactScreen } from '@/modules/projects/queries';
import { Badge, Card } from '@/ui';

/**
 * Renders one Prototype Agent build — PROTO §5, §12; `docs/phase-4-gap-
 * analysis.md` step 4.
 *
 * **Never `dangerouslySetInnerHTML`.** Every element the model produced is a
 * `{ type, label, navigatesTo? }` triple from a closed vocabulary
 * (`prototypeBuildSchema`); this component switches on `type` and renders
 * ordinary React elements with the label as plain TEXT CHILDREN, which React
 * escapes automatically. There is no code path here through which a model
 * output could become markup, a script, or an event handler — the safety
 * boundary is the element vocabulary itself, not a sanitizer that has to keep
 * up with what the model might try next.
 *
 * A `button`/`link` element with `navigatesTo` switches the visible screen by
 * updating component state — real, working client-side navigation between
 * mock screens, not a decorative control (PROTO/QAP's repeated rule).
 */
export function PrototypeScreenView({ screens }: { screens: PrototypeArtifactScreen[] }) {
  const [activeKey, setActiveKey] = useState(screens[0]?.screenKey ?? '');
  const active = screens.find((s) => s.screenKey === activeKey) ?? screens[0];

  if (!active) {
    return <p className="text-sm text-muted">This build has no screens.</p>;
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row">
      <nav className="flex shrink-0 flex-row gap-2 overflow-x-auto sm:w-48 sm:flex-col">
        {screens.map((screen) => (
          <button
            key={screen.screenKey}
            type="button"
            onClick={() => setActiveKey(screen.screenKey)}
            className={`rounded-md border px-3 py-2 text-left text-sm ${
              screen.screenKey === active.screenKey
                ? 'border-primary bg-primary/10 font-medium text-foreground'
                : 'border-border text-muted hover:text-foreground'
            }`}
          >
            {screen.screenKey}
          </button>
        ))}
      </nav>

      <Card className="flex-1 p-5">
        <div className="flex flex-col gap-3">
          {active.elements.map((element, index) => (
            <PrototypeElement
              key={`${active.screenKey}-${index}`}
              element={element}
              onNavigate={setActiveKey}
              screenKeys={screens.map((s) => s.screenKey)}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

function PrototypeElement({
  element,
  onNavigate,
  screenKeys,
}: {
  element: PrototypeArtifactScreen['elements'][number];
  onNavigate: (key: string) => void;
  screenKeys: string[];
}) {
  const target = element.navigatesTo && screenKeys.includes(element.navigatesTo) ? element.navigatesTo : null;

  switch (element.type) {
    case 'heading':
      return <h3 className="text-lg font-semibold text-foreground">{element.label}</h3>;
    case 'text':
      return <p className="text-sm text-muted">{element.label}</p>;
    case 'list':
      return (
        <ul className="list-disc pl-5 text-sm text-muted">
          {element.label.split(/\n+/).map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      );
    case 'input':
      return (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{element.label}</span>
          <input
            type="text"
            disabled
            placeholder="Mock data — not a working form"
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-faint"
          />
        </label>
      );
    case 'image_placeholder':
      return (
        <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-border text-xs text-faint">
          {element.label}
        </div>
      );
    case 'button':
    case 'link':
      return (
        <button
          type="button"
          disabled={!target}
          onClick={() => target && onNavigate(target)}
          title={target ? undefined : 'Not wired to another screen in this build'}
          className={`inline-flex w-fit items-center gap-2 rounded-md border px-3 py-2 text-sm ${
            target
              ? 'border-primary bg-primary text-primary-foreground hover:opacity-90'
              : 'border-border text-faint'
          }`}
        >
          {element.label}
          {!target ? <Badge tone="neutral">not wired</Badge> : null}
        </button>
      );
    default:
      return null;
  }
}
