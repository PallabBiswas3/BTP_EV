import type { EquilibriumBlock, NetworkConfig, TrajectoryBlock } from '../types'
import ChargingScene from './ChargingScene'

interface Props {
  network: NetworkConfig
  equilibrium: EquilibriumBlock | null
  trajectory: TrajectoryBlock | null
  timeIndex: number
  selectedStation: string | null
  onSelectStation: (name: string | null) => void
}

function stationSaturation(network: NetworkConfig, name: string): number {
  const cfg = network.stations.find((s) => s.name === name)
  const mu_s = cfg?.mu_s ?? network.defaults.mu_s
  const a_s = cfg?.a_s ?? network.defaults.a_s
  return mu_s / a_s
}

export default function StationCards({ network, equilibrium, trajectory, timeIndex, selectedStation, onSelectStation }: Props) {
  if (network.stations.length === 0) {
    return <div className="empty-state">This network has no charging stations.</div>
  }

  return (
    <div className="station-grid">
      {network.stations.map((station) => {
        const K = stationSaturation(network, station.name)
        const occ = equilibrium?.occupancies[station.name]
        const price = equilibrium?.prices[station.name]
        const rho = equilibrium?.throughputs[station.name]
        const profit = equilibrium?.profits[station.name]
        const util = occ !== undefined ? Math.min(1, occ / K) : 0
        const queueActive = occ !== undefined && occ > K
        const mu = station.mu_s ?? network.defaults.mu_s
        const st = trajectory?.stations[station.name]
        const idx = trajectory ? Math.min(timeIndex, trajectory.time.length - 1) : -1
        const live = st && idx >= 0
        const liveOcc = live ? (st.occupancy[idx] ?? 0) : 0
        const liveOut = live ? (st.throughput[idx] ?? 0) : 0
        // Arrivals are not stored; recover them from the vehicle balance over the last step.
        const dt = live && idx > 0 ? trajectory!.time[idx] - trajectory!.time[idx - 1] : 0
        const liveIn = live && dt > 0 ? Math.max(liveOut + (liveOcc - (st.occupancy[idx - 1] ?? 0)) / dt, 0) : liveOut

        return (
          <div
            key={station.name}
            className={`station-card${selectedStation === station.name ? ' selected' : ''}`}
            onClick={() => onSelectStation(station.name === selectedStation ? null : station.name)}
          >
            <div className="station-head">
              <div>
                <p className="station-kicker">{station.u} → {station.v}</p>
                <h3>{station.name}</h3>
              </div>
              <span className="price-pill">
                {price !== undefined ? `ψ = ${price.toFixed(3)}` : 'not run'}
                {queueActive && <span className="queue-pill">queue active</span>}
              </span>
            </div>

            <div className={`capacity-bar${util > 1 ? ' over' : ''}`}>
              <span style={{ width: `${Math.min(100, util * 100)}%` }} />
            </div>

            <ChargingScene bays={Math.max(1, Math.round(K))} occupancy={liveOcc} queue={live ? (st.queue[idx] ?? 0) : 0}
              arrivalRate={liveIn} departureRate={liveOut} capacity={mu} rateUnit="/time" />
            {live && <p className="station-kicker" style={{ marginTop: 6 }}>scene at t = {trajectory!.time[idx].toFixed(1)}, price ψ = {(st.price[idx] ?? 0).toFixed(3)}</p>}

            <div className="station-stats">
              <span>Occupancy x_s <b>{occ !== undefined ? occ.toFixed(3) : '—'}</b></span>
              <span>Saturation K_s <b>{K.toFixed(2)}</b></span>
              <span>Throughput ρ_s <b>{rho !== undefined ? rho.toFixed(3) : '—'}</b></span>
              <span>Utilization <b>{occ !== undefined ? `${Math.min(999, util * 100).toFixed(0)}%` : '—'}</b></span>
              <span>Profit π_s <b>{profit !== undefined ? profit.toFixed(3) : '—'}</b></span>
              <span>Marginal cost c_s <b>{(station.c_s ?? network.defaults.c_s).toFixed(2)}</b></span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
