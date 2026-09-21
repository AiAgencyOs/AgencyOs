'use client';

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

/**
 * One reusable bar chart for every "count by category" report on this page —
 * dataviz skill's form heuristic: a single series across categories is a
 * magnitude comparison, so one hue (or the app's own status hues, when the
 * categories ARE the app's status vocabulary) is correct; a multi-hue
 * categorical palette would be solving a problem this chart doesn't have.
 *
 * Colors are the app's own CSS custom properties (var(--brand) etc, from
 * app/globals.css) rather than a new palette — they already carry the
 * contrast/dark-mode work the rest of the product relies on, and reusing
 * them keeps a report bar meaning the same color as the equivalent status
 * badge elsewhere in the app.
 */
export function SimpleBarChart({
  data,
  colors,
  height = 220,
  valueFormatter,
}: {
  data: { label: string; value: number }[];
  /** One color per bar, same order as `data`. Falls back to var(--brand) for every bar. */
  colors?: string[];
  height?: number;
  /** How the tooltip and nothing else renders the raw value — e.g. money formatting. */
  valueFormatter?: (value: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
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
          formatter={(value) => [valueFormatter && typeof value === 'number' ? valueFormatter(value) : value, undefined]}
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
      </BarChart>
    </ResponsiveContainer>
  );
}
