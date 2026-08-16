import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
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
}

export default function LineSeriesChart({ x, series, xLabel, yLabel }: Props) {
  const data = x.map((xv, i) => {
    const row: Record<string, number> = { x: xv }
    series.forEach((s) => { row[s.id] = s.values[i] })
    return row
  })

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 6, right: 12, bottom: 6, left: 0 }}>
        <CartesianGrid stroke="#e8e5de" strokeDasharray="3 3" />
        <XAxis dataKey="x" tick={{ fontSize: 10.5, fontFamily: 'IBM Plex Mono' }} stroke="#a39c8c"
               label={{ value: xLabel, position: 'insideBottom', offset: -4, fontSize: 10.5, fill: '#756f63' }} />
        <YAxis tick={{ fontSize: 10.5, fontFamily: 'IBM Plex Mono' }} stroke="#a39c8c"
               label={{ value: yLabel, angle: -90, position: 'insideLeft', fontSize: 10.5, fill: '#756f63' }} />
        <Tooltip contentStyle={{ fontSize: 11.5, fontFamily: 'IBM Plex Mono', border: '1px solid #ddd9d0', borderRadius: 5 }} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {series.map((s) => (
          <Line key={s.id} type="monotone" dataKey={s.id} name={s.label} stroke={s.color}
                dot={false} strokeWidth={1.8} isAnimationActive={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}
