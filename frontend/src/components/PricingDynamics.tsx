import { useMemo, useState } from 'react'
import type { OuterHistoryBlock } from '../types'
import { colorForStation } from '../utils/colors'
import LineSeriesChart from './LineSeriesChart'
import { downloadCsv } from '../utils/export'

interface Props {
  history: OuterHistoryBlock | null
}

const METRICS: { key: 'price' | 'occupancy' | 'throughput' | 'profit'; label: string; symbol: string }[] = [
  { key: 'price', label: 'Station price', symbol: 'ψ_s(k)' },
  { key: 'throughput', label: 'Station throughput', symbol: 'ρ_s(k)' },
  { key: 'occupancy', label: 'Station occupancy', symbol: 'x_s(k)' },
  { key: 'profit', label: 'Station profit', symbol: 'π_s(k)' },
]

export default function PricingDynamics({ history }: Props) {
  const stations = useMemo(() => (history ? Object.keys(history.stations) : []), [history])
  const [visible, setVisible] = useState<Set<string>>(new Set(stations))

  useMemo(() => { if (stations.length && visible.size === 0) setVisible(new Set(stations)) }, [stations]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!history) {
    return <div className="empty-state">Run a simulation to see how prices, throughput, occupancy and profit evolve across outer pricing iterations.</div>
  }

  const toggle = (s: string) => {
    setVisible((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s); else next.add(s)
      return next
    })
  }

  const exportCsv = () => {
    const headers = ['step', ...stations.flatMap((s) => [`${s}_price`, `${s}_occupancy`, `${s}_throughput`, `${s}_profit`])]
    const rows = history.step.map((k, i) => [
      k, ...stations.flatMap((s) => [
        history.stations[s].price[i], history.stations[s].occupancy[i],
        history.stations[s].throughput[i], history.stations[s].profit[i],
      ]),
    ])
    downloadCsv('pricing_dynamics.csv', headers, rows)
  }

  return (
    <div>
      <p className="muted" style={{ marginBottom: 12 }}>
        The outer pricing process performs gradient ascent on each station's profit while the inner
        transportation system is allowed to reach traffic-routing equilibrium. Toggle stations below to
        focus on specific players in the pricing game.
      </p>
      <div className="chip-row" style={{ marginBottom: 14 }}>
        {stations.map((s) => (
          <button key={s} className={`chip${visible.has(s) ? ' active' : ''}`} onClick={() => toggle(s)}>
            <span className="dot" style={{ background: colorForStation(stations, s) }} />{s}
          </button>
        ))}
        <button className="link-button" style={{ marginLeft: 'auto' }} onClick={exportCsv}>Export CSV</button>
      </div>
      <div className="charts-grid">
        {METRICS.map((m) => (
          <div key={m.key} className="chart-card">
            <div className="chart-title-row">
              <h3>{m.label}</h3>
              <span className="mono muted">{m.symbol}</span>
            </div>
            <div className="chart-area">
              <LineSeriesChart
                x={history.step}
                xLabel="outer step k"
                yLabel={m.symbol}
                series={stations.filter((s) => visible.has(s)).map((s) => ({
                  id: s, label: s, color: colorForStation(stations, s),
                  values: history.stations[s][m.key],
                }))}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
