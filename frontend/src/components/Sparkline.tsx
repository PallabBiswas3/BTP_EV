interface SparkSeries {
  label: string
  color: string
  values: number[]
}

interface Props {
  series: SparkSeries[]
  /** Index into the values to mark as "now". */
  marker?: number
  width?: number
  height?: number
  format?: (value: number) => string
}

/** Small trend lines sharing one y-scale, each labelled at its right end. */
export default function Sparkline({ series, marker, width = 284, height = 58, format }: Props) {
  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v))
  if (all.length === 0) return null
  const labelWidth = 86
  const plot = width - labelWidth
  const min = Math.min(...all)
  const max = Math.max(...all)
  const span = max - min || 1
  const n = Math.max(...series.map((s) => s.values.length))
  const x = (i: number) => (n > 1 ? 4 + (i / (n - 1)) * (plot - 8) : plot / 2)
  const y = (v: number) => 6 + (1 - (v - min) / span) * (height - 12)
  const show = format ?? ((v: number) => v.toFixed(0))

  // Keep end labels from overlapping when two series finish close together.
  const ends = series.map((s, i) => ({ i, y: y(s.values[s.values.length - 1] ?? min) }))
    .sort((a, b) => a.y - b.y)
  for (let k = 1; k < ends.length; k += 1) {
    if (ends[k].y - ends[k - 1].y < 12) ends[k].y = ends[k - 1].y + 12
  }
  const labelY = new Map(ends.map((e) => [e.i, e.y]))

  return (
    <svg width={width} height={height + 6} role="img" aria-label={series.map((s) => s.label).join(', ')}>
      {series.map((s, i) => (
        <g key={s.label}>
          <polyline fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
                    points={s.values.map((v, k) => `${x(k).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />
          {marker !== undefined && s.values[marker] !== undefined && (
            <circle cx={x(marker)} cy={y(s.values[marker])} r={4} fill={s.color} stroke="#fff" strokeWidth={2} />
          )}
          <rect x={plot + 6} y={(labelY.get(i) ?? 0) - 4} width={8} height={8} rx={2} fill={s.color} />
          <text x={plot + 18} y={(labelY.get(i) ?? 0) + 3.5} fontSize={10.5} fill="#24221d" fontFamily="IBM Plex Mono, monospace">
            {s.label} {show(s.values[marker ?? s.values.length - 1] ?? s.values[s.values.length - 1])}
          </text>
        </g>
      ))}
    </svg>
  )
}
