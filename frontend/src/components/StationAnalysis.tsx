import { useMemo } from 'react'
import {
  CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { TrajectoryBlock } from '../types'
import LineSeriesChart from './LineSeriesChart'

interface Props {
  trajectory: TrajectoryBlock | null
  selectedStation: string | null
  onSelectStation: (name: string | null) => void
}

export default function StationAnalysis({ trajectory, selectedStation, onSelectStation }: Props) {
  const stations = useMemo(() => (trajectory ? Object.keys(trajectory.stations) : []), [trajectory])
  const active = selectedStation && stations.includes(selectedStation) ? selectedStation : stations[0]

  if (!trajectory || !active) {
    return <div className="empty-state">Run a simulation, then pick a station (click one on the network diagram or below) to inspect its occupancy, queueing and profit over time.</div>
  }

  const st = trajectory.stations[active]
  const occData = trajectory.time.map((t, i) => ({ t, occupancy: st.occupancy[i], K: st.saturation_K }))

  return (
    <div>
      <div className="chip-row" style={{ marginBottom: 14 }}>
        {stations.map((s) => (
          <button key={s} className={`chip${s === active ? ' active' : ''}`} onClick={() => onSelectStation(s)}>{s}</button>
        ))}
      </div>

      <div className="charts-grid">
        <div className="chart-card">
          <div className="chart-title-row">
            <h3>Occupancy vs. saturation</h3>
            <span className="mono muted">x_s(t), K_s = {st.saturation_K.toFixed(2)}</span>
          </div>
          <div className="chart-area">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={occData} margin={{ top: 6, right: 12, bottom: 6, left: 0 }}>
                <CartesianGrid stroke="#e8e5de" strokeDasharray="3 3" />
                <XAxis dataKey="t" tick={{ fontSize: 10.5, fontFamily: 'IBM Plex Mono' }} stroke="#a39c8c"
                       label={{ value: 'time t', position: 'insideBottom', offset: -4, fontSize: 10.5, fill: '#756f63' }} />
                <YAxis tick={{ fontSize: 10.5, fontFamily: 'IBM Plex Mono' }} stroke="#a39c8c" />
                <Tooltip contentStyle={{ fontSize: 11.5, fontFamily: 'IBM Plex Mono', border: '1px solid #ddd9d0', borderRadius: 5 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine y={st.saturation_K} stroke="#c15b3f" strokeDasharray="5 4" label={{ value: 'K_s', fontSize: 10.5, fill: '#c15b3f' }} />
                <Line type="monotone" dataKey="occupancy" name="x_s(t)" stroke="#2a5f5b" dot={false} strokeWidth={1.8} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="chart-card">
          <div className="chart-title-row"><h3>Price</h3><span className="mono muted">ψ_s(t)</span></div>
          <div className="chart-area">
            <LineSeriesChart x={trajectory.time} xLabel="time t" yLabel="ψ_s"
              series={[{ id: 'price', label: active, color: '#2a5f5b', values: st.price }]} />
          </div>
        </div>

        <div className="chart-card">
          <div className="chart-title-row"><h3>Queue &amp; waiting time</h3><span className="mono muted">q_s(t), w_s(t)</span></div>
          <div className="chart-area">
            <LineSeriesChart x={trajectory.time} xLabel="time t" yLabel="value"
              series={[
                { id: 'queue', label: 'queue q_s', color: '#c15b3f', values: st.queue },
                { id: 'wait', label: 'wait w_s', color: '#9c8256', values: st.waiting_time },
              ]} />
          </div>
        </div>

        <div className="chart-card">
          <div className="chart-title-row"><h3>Throughput &amp; profit</h3><span className="mono muted">ρ_s(t), π_s(t)</span></div>
          <div className="chart-area">
            <LineSeriesChart x={trajectory.time} xLabel="time t" yLabel="value"
              series={[
                { id: 'throughput', label: 'throughput ρ_s', color: '#4b6f8c', values: st.throughput },
                { id: 'profit', label: 'profit π_s', color: '#6b5b8c', values: st.profit },
              ]} />
          </div>
        </div>
      </div>
    </div>
  )
}
