import { useMemo, useState } from 'react'
import type { TrajectoryBlock } from '../types'
import { colorForIndex } from '../utils/colors'
import LineSeriesChart from './LineSeriesChart'

interface Props {
  trajectory: TrajectoryBlock | null
  timeIndex: number
}

export default function RouteChoice({ trajectory, timeIndex }: Props) {
  const groups = useMemo(() => {
    if (!trajectory) return new Map<string, string[]>()
    const g = new Map<string, string[]>()
    Object.entries(trajectory.paths).forEach(([pid, p]) => {
      const key = `${p.od} / ${p.vehicle_class}`
      if (!g.has(key)) g.set(key, [])
      g.get(key)!.push(pid)
    })
    return g
  }, [trajectory])

  const groupKeys = [...groups.keys()]
  const [activeGroup, setActiveGroup] = useState<string | null>(null)
  const active = activeGroup && groups.has(activeGroup) ? activeGroup : groupKeys[0]

  if (!trajectory || groupKeys.length === 0) {
    return <div className="empty-state">Run a simulation to see how demand splits across the feasible paths for each OD pair and vehicle class.</div>
  }

  const idx = Math.min(timeIndex, trajectory.time.length - 1)

  return (
    <div>
      {groupKeys.map((key) => {
        const pids = groups.get(key)!
        const totalFlow = pids.reduce((sum, pid) => sum + (trajectory.paths[pid].flow[idx] ?? 0), 0)
        const costs = pids.map((pid) => ({ pid, cost: trajectory.paths[pid].cost[idx] ?? 0, flow: trajectory.paths[pid].flow[idx] ?? 0 }))
        const usedCosts = costs.filter((c) => c.flow > 1e-4).map((c) => c.cost)
        const gap = usedCosts.length > 1 ? Math.max(...usedCosts) - Math.min(...usedCosts) : 0

        return (
          <div className="route-group" key={key}>
            <div className="route-group-head">
              <h3>{key}</h3>
              <span className="mono muted">total flow {totalFlow.toFixed(3)}</span>
            </div>
            {pids.map((pid, i) => {
              const p = trajectory.paths[pid]
              const flow = p.flow[idx] ?? 0
              const share = totalFlow > 1e-9 ? flow / totalFlow : 0
              return (
                <div className="route-path" key={pid}>
                  <div>
                    <div className="route-path-desc" style={{ color: colorForIndex(i) }}>{p.nodes.join(' → ')}</div>
                    {p.stations_used.length > 0 && (
                      <div className="muted" style={{ fontSize: 11 }}>via {p.stations_used.join(', ')}</div>
                    )}
                  </div>
                  <div className="route-path-stats">
                    <span>flow <b>{flow.toFixed(3)}</b></span>
                    <span>share <b>{(share * 100).toFixed(0)}%</b></span>
                    <span>cost <b>{p.cost[idx]?.toFixed(3) ?? '—'}</b></span>
                  </div>
                </div>
              )
            })}
            {pids.length > 1 && (
              <p className="wardrop-gap">
                Wardrop equilibrium gap (max − min cost among used paths): <b className="mono">{gap.toFixed(4)}</b>
                {gap < 0.01 ? ' — essentially equalized.' : ''}
              </p>
            )}
            <button className="link-button" style={{ marginTop: 6 }} onClick={() => setActiveGroup(key)}>
              {active === key ? 'Showing charts below ↓' : 'Show flow/cost over time ↓'}
            </button>
          </div>
        )
      })}

      {active && (
        <div className="charts-grid">
          <div className="chart-card">
            <div className="chart-title-row"><h3>Path flow</h3><span className="mono muted">{active}</span></div>
            <div className="chart-area">
              <LineSeriesChart x={trajectory.time} xLabel="time t" yLabel="flow"
                series={groups.get(active)!.map((pid, i) => ({
                  id: pid, label: trajectory.paths[pid].nodes.join('→'), color: colorForIndex(i),
                  values: trajectory.paths[pid].flow,
                }))} />
            </div>
          </div>
          <div className="chart-card">
            <div className="chart-title-row"><h3>Path cost</h3><span className="mono muted">{active}</span></div>
            <div className="chart-area">
              <LineSeriesChart x={trajectory.time} xLabel="time t" yLabel="cost"
                series={groups.get(active)!.map((pid, i) => ({
                  id: pid, label: trajectory.paths[pid].nodes.join('→'), color: colorForIndex(i),
                  values: trajectory.paths[pid].cost,
                }))} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
