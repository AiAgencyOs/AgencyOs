/**
 * A monthly trend of one measure — SCR-055's expense trend.
 *
 * One series, so one hue (the brand token) and no legend: the caption names
 * the series. Thin bars with rounded tops anchored to the baseline, a 2px
 * surface gap between them, the first, last and highest values labelled
 * directly and every bar carrying its own `<title>` for hover. Text stays in
 * text tokens; the colour is on the mark alone. Inline SVG rather than a
 * chart library, because six numbers do not earn a dependency.
 */
export type TrendPoint = { key: string; label: string; value: number };

export function TrendChart({
  points,
  format,
  caption,
}: {
  points: readonly TrendPoint[];
  /** The value as a person reads it, e.g. money in the deployment's currency. */
  format: (value: number) => string;
  caption: string;
}) {
  if (points.length === 0) return null;

  const width = 640;
  const height = 180;
  const padTop = 22;
  const padBottom = 28;
  const padX = 8;
  const max = Math.max(...points.map((p) => p.value), 1);
  const plotH = height - padTop - padBottom;
  const slot = (width - padX * 2) / points.length;
  const barW = Math.max(6, Math.min(28, slot - 8));
  const peak = points.reduce((best, p, i) => (p.value > points[best]!.value ? i : best), 0);

  const bars = points.map((p, i) => {
    const h = Math.round((p.value / max) * plotH);
    const x = padX + i * slot + (slot - barW) / 2;
    const y = padTop + plotH - h;
    const labelled = i === 0 || i === points.length - 1 || i === peak;
    return { ...p, x, y, h, labelled };
  });

  return (
    <figure className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={caption}
        className="h-auto w-full max-w-3xl text-foreground"
      >
        <line x1={padX} x2={width - padX} y1={padTop + plotH} y2={padTop + plotH} className="stroke-line" strokeWidth={1} />
        {bars.map((b) => (
          <g key={b.key}>
            <title>{`${b.label}: ${format(b.value)}`}</title>
            {b.h > 0 ? (
              <rect
                x={b.x}
                y={b.y}
                width={barW}
                height={b.h}
                rx={4}
                className="fill-brand"
                stroke="var(--color-surface, #fff)"
                strokeWidth={2}
              />
            ) : null}
            {b.labelled && b.value > 0 ? (
              <text x={b.x + barW / 2} y={b.y - 6} textAnchor="middle" className="fill-current text-[10px] tabular" fontSize={10}>
                {format(b.value)}
              </text>
            ) : null}
            <text
              x={b.x + barW / 2}
              y={height - 8}
              textAnchor="middle"
              className="fill-current opacity-60"
              fontSize={10}
            >
              {b.label}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="text-xs text-muted">{caption}</figcaption>
    </figure>
  );
}
