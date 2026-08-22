import {
  CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'

export interface Series {
  id: string
  label: string
  color: string
  values: number[]
}

interface Props {
  x: number[]
  series: Series[]
  xLabel: string
  yLabel: string
  thresholdY?: number
  thresholdLabel?: string
  referenceX?: number
  referenceLabel?: string
}

function formatTick(value: number) {
  const magnitude = Math.abs(value)
  if (magnitude >= 1000 || (magnitude > 0 && magnitude < 0.01)) return value.toExponential(1)
  return Number(value.toFixed(magnitude < 1 ? 3 : 2)).toString()
}

export default function LineSeriesChart({
  x, series, xLabel, yLabel, thresholdY, thresholdLabel, referenceX, referenceLabel,
}: Props) {
  const data = x.map((xv, i) => {
    const row: Record<string, number> = { x: xv }
    series.forEach((s) => { row[s.id] = s.values[i] })
    return row
  })

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 12, right: 18, bottom: 12, left: 8 }}>
        <CartesianGrid stroke="#e8e5de" strokeDasharray="3 4" vertical={false} />
        <XAxis dataKey="x" tickFormatter={formatTick} tick={{ fontSize: 10.5, fontFamily: 'IBM Plex Mono' }} stroke="#a39c8c"
               tickLine={false} axisLine={{ stroke: '#c9c2b3' }}
               label={{ value: xLabel, position: 'insideBottom', offset: -8, fontSize: 10.5, fill: '#756f63' }} />
        <YAxis tickFormatter={formatTick} tick={{ fontSize: 10.5, fontFamily: 'IBM Plex Mono' }} stroke="#a39c8c"
               tickLine={false} axisLine={false} width={48}
               label={{ value: yLabel, angle: -90, position: 'insideLeft', offset: 4, fontSize: 10.5, fill: '#756f63' }} />
        <Tooltip formatter={(value: number) => formatTick(value)}
          labelFormatter={(value) => `${xLabel}: ${formatTick(Number(value))}`}
          contentStyle={{ fontSize: 11.5, fontFamily: 'IBM Plex Mono', border: '1px solid #c9c2b3', borderRadius: 5, boxShadow: '0 5px 16px rgba(38,35,29,.12)' }} />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 5 }} />
        {thresholdY !== undefined && <ReferenceLine y={thresholdY} stroke="#c15b3f" strokeDasharray="5 4"
          label={{ value: thresholdLabel ?? 'threshold', position: 'insideTopRight', fontSize: 10, fill: '#a44430' }} />}
        {referenceX !== undefined && <ReferenceLine x={referenceX} stroke="#565047" strokeDasharray="3 4"
          label={{ value: referenceLabel ?? '', position: 'insideTopRight', fontSize: 10, fill: '#565047' }} />}
        {series.map((s) => (
          <Line key={s.id} type="linear" dataKey={s.id} name={s.label} stroke={s.color}
                dot={false} activeDot={{ r: 4, strokeWidth: 2 }} strokeWidth={2}
                connectNulls isAnimationActive={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}
