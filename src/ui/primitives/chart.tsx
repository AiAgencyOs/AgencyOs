'use client';

import {
  Bar,
  BarChart as ReBarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart as ReLineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { cx } from '../tokens';

/**
 * Shared chart primitives.
 *
 * Every chart in the product draws its colors from the app's own CSS custom
 * properties (`var(--brand)`, `var(--success)`, …) rather than a separate
 * chart palette — they already carry the contrast and dark-mode work the rest
 * of the product relies on, and reusing them keeps a chart segment meaning the
 * same color as the equivalent status badge elsewhere in the app. A caller
 * that needs a specific mapping (e.g. status → color) passes `colors`
 * explicitly; otherwise these cycle through the app's own semantic tones.
 */

const DEFAULT_SERIES_COLORS = [
  'var(--brand)',
  'var(--accent)',
  'var(--success)',
  'var(--warning)',
  'var(--danger)',
  'var(--info)',
];

/**
 * Every chart here takes a `currency` code rather than a `valueFormatter`
 * function: these are `'use client'` components rendered from Server
 * Component pages, and a plain callback function is not a value Next.js can
 * pass across that boundary ("Functions cannot be passed directly to Client
 * Components"). A currency code is serializable and covers every caller this
 * file actually has — plain counts fall back to a locale number format.
 */
function formatValue(value: number, currency?: string): string {
  return new Intl.NumberFormat('en-IN', currency ? { style: 'currency', currency, maximumFractionDigits: 0 } : undefined).format(
    value,
  );
}

/** One reusable bar chart for every "count by category" report. */
export function BarChart({
  data,
  colors,
  height = 220,
  currency,
}: {
  data: { label: string; value: number }[];
  /** One color per bar, same order as `data`. Falls back to var(--brand) for every bar. */
  colors?: string[];
  height?: number;
  /** Formats the tooltip value as this currency (e.g. "INR") — omit for a plain number. */
  currency?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ReBarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fill: 'var(--muted)', fontSize: 11 }}
          axisLine={{ stroke: 'var(--line)' }}
          tickLine={false}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fill: 'var(--muted)', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={32}
        />
        <Tooltip
          cursor={{ fill: 'var(--surface-hover)' }}
          formatter={(value) => [typeof value === 'number' ? formatValue(value, currency) : value, undefined]}
          contentStyle={{
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            fontSize: 12,
            color: 'var(--foreground)',
          }}
        />
        <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={48}>
          {data.map((d, i) => (
            <Cell key={d.label} fill={colors?.[i] ?? 'var(--brand)'} />
          ))}
        </Bar>
      </ReBarChart>
    </ResponsiveContainer>
  );
}

/**
 * A distribution donut — "leads by source", "task distribution", "agent
 * status" in the reference screenshots. The legend is hand-built rather than
 * Recharts' own `<Legend>`, because the built-in one cannot be styled to the
 * app's chip vocabulary (dot + label + right-aligned value) without fighting
 * its layout engine.
 */
export function DonutChart({
  data,
  colors,
  height = 220,
  currency,
  totalLabel,
}: {
  data: { label: string; value: number }[];
  /** One color per slice, same order as `data`. Cycles the app's semantic tones otherwise. */
  colors?: string[];
  height?: number;
  /** Formats every value as this currency (e.g. "INR") — omit for a plain number. */
  currency?: string;
  /** Centre caption, e.g. "Total leads" — omit to show no centre text. */
  totalLabel?: string;
}) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const palette = (i: number) => colors?.[i] ?? DEFAULT_SERIES_COLORS[i % DEFAULT_SERIES_COLORS.length];

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="relative shrink-0" style={{ width: height, height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius="62%"
              outerRadius="100%"
              paddingAngle={data.length > 1 ? 2 : 0}
              stroke="var(--surface)"
              strokeWidth={2}
            >
              {data.map((d, i) => (
                <Cell key={d.label} fill={palette(i)} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value, label) => [
                formatValue(typeof value === 'number' ? value : Number(value), currency),
                label,
              ]}
              contentStyle={{
                background: 'var(--surface)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                fontSize: 12,
                color: 'var(--foreground)',
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        {totalLabel ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="tabular text-xl font-semibold text-foreground">{formatValue(total, currency)}</span>
            <span className="text-[11px] text-muted">{totalLabel}</span>
          </div>
        ) : null}
      </div>

      <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
        {data.map((d, i) => (
          <li key={d.label} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[13px]">
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: palette(i) }}
              />
              <span className="text-foreground">{d.label}</span>
            </span>
            <span className="tabular shrink-0 text-muted">
              {formatValue(d.value, currency)}
              {total > 0 ? <span className="ml-1 text-[11px] text-faint">({Math.round((d.value / total) * 100)}%)</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A trend line — "pipeline value over time", "income vs. expenses" — one or
 * more named series sharing an x-axis. `series` keys index into each row of
 * `data`, so a two-series chart is just two entries in `series`, not a
 * different component.
 */
export function TrendChart({
  data,
  series,
  xKey,
  height = 220,
  currency,
  className,
}: {
  data: Record<string, string | number>[];
  series: { key: string; label: string; color?: string }[];
  xKey: string;
  height?: number;
  /** Formats every value as this currency (e.g. "INR") — omit for a plain number. */
  currency?: string;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col gap-2', className)}>
      <ResponsiveContainer width="100%" height={height}>
        <ReLineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
          <XAxis
            dataKey={xKey}
            tick={{ fill: 'var(--muted)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--line)' }}
            tickLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fill: 'var(--muted)', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <Tooltip
            formatter={(value) => (typeof value === 'number' ? formatValue(value, currency) : value)}
            contentStyle={{
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: 12,
              color: 'var(--foreground)',
            }}
          />
          {series.map((s, i) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={s.color ?? DEFAULT_SERIES_COLORS[i % DEFAULT_SERIES_COLORS.length]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          ))}
        </ReLineChart>
      </ResponsiveContainer>
      {series.length > 1 ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {series.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1.5 text-[11px] text-muted">
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: s.color ?? DEFAULT_SERIES_COLORS[i % DEFAULT_SERIES_COLORS.length] }}
              />
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
