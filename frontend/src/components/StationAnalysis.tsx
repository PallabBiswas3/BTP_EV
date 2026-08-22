import { useMemo } from 'react'
import type { TrajectoryBlock } from '../types'
import LineSeriesChart from './LineSeriesChart'

interface Props {
  trajectory: TrajectoryBlock | null
  timeIndex: number
  selectedStation: string | null
  onSelectStation: (name: string | null) => void
}

export default function StationAnalysis({
  trajectory, timeIndex, selectedStation, onSelectStation,
}: Props) {
  const stations = useMemo(() => (trajectory ? Object.keys(trajectory.stations) : []), [trajectory])
  const active = selectedStation && stations.includes(selectedStation) ? selectedStation : stations[0]

  if (!trajectory || !active) {
    return <div className="empty-state">Run a simulation, then pick a station to inspect its equilibrium process.</div>
  }

  const station = trajectory.stations[active]
  const index = Math.min(timeIndex, trajectory.time.length - 1)
  const selectedStep = trajectory.time[index]
  const marker = { referenceX: selectedStep, referenceLabel: 'selected' }

  return (
    <div>
      <div className="chip-row" style={{ marginBottom: 14 }}>
        {stations.map((name) => (
          <button key={name} className={`chip${name === active ? ' active' : ''}`}
            onClick={() => onSelectStation(name)}>{name}</button>
        ))}
      </div>

      <div className="charts-grid">
        <div className="chart-card">
          <div className="chart-title-row">
            <h3>Occupancy vs. saturation</h3>
            <span className="mono muted">K_s = {station.saturation_K.toFixed(2)}</span>
          </div>
          <div className="chart-area">
            <LineSeriesChart x={trajectory.time} xLabel="equilibrium step" yLabel="occupancy"
              thresholdY={station.saturation_K} thresholdLabel="saturation K_s" {...marker}
              series={[{ id: 'occupancy', label: 'occupancy x_s', color: '#2a5f5b', values: station.occupancy }]} />
          </div>
        </div>

        <div className="chart-card">
          <div className="chart-title-row"><h3>Price</h3><span className="mono muted">price per EV</span></div>
          <div className="chart-area">
            <LineSeriesChart x={trajectory.time} xLabel="equilibrium step" yLabel="price" {...marker}
              series={[{ id: 'price', label: active, color: '#2a5f5b', values: station.price }]} />
          </div>
        </div>

        <div className="chart-card">
          <div className="chart-title-row"><h3>Queue</h3><span className="mono muted">waiting vehicles</span></div>
          <div className="chart-area">
            <LineSeriesChart x={trajectory.time} xLabel="equilibrium step" yLabel="vehicles" {...marker}
              series={[{ id: 'queue', label: 'queue q_s', color: '#c15b3f', values: station.queue }]} />
          </div>
        </div>

        <div className="chart-card">
          <div className="chart-title-row"><h3>Waiting time</h3><span className="mono muted">delay per EV</span></div>
          <div className="chart-area">
            <LineSeriesChart x={trajectory.time} xLabel="equilibrium step" yLabel="time" {...marker}
              series={[{ id: 'wait', label: 'waiting time w_s', color: '#9c8256', values: station.waiting_time }]} />
          </div>
        </div>

        <div className="chart-card">
          <div className="chart-title-row"><h3>Throughput</h3><span className="mono muted">served EVs</span></div>
          <div className="chart-area">
            <LineSeriesChart x={trajectory.time} xLabel="equilibrium step" yLabel="vehicles / time" {...marker}
              series={[{ id: 'throughput', label: 'throughput rho_s', color: '#4b6f8c', values: station.throughput }]} />
          </div>
        </div>

        <div className="chart-card">
          <div className="chart-title-row"><h3>Profit</h3><span className="mono muted">station return</span></div>
          <div className="chart-area">
            <LineSeriesChart x={trajectory.time} xLabel="equilibrium step" yLabel="profit / time" {...marker}
              series={[{ id: 'profit', label: 'profit pi_s', color: '#6b5b8c', values: station.profit }]} />
          </div>
        </div>
      </div>
    </div>
  )
}
