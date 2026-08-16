import { useState } from 'react'
import type { BetaSweepResult } from '../types'
import { colorForStation } from '../utils/colors'
import LineSeriesChart from './LineSeriesChart'
import { downloadCsv } from '../utils/export'

interface Props {
  result: BetaSweepResult | null
  running: boolean
  onRun: (betaMin: number, betaMax: number, betaStep: number) => void
}

export default function EVAdoption({ result, running, onRun }: Props) {
  const [betaMin, setBetaMin] = useState(0.2)
  const [betaMax, setBetaMax] = useState(0.8)
  const [betaStep, setBetaStep] = useState(0.1)

  const exportCsv = () => {
    if (!result) return
    const headers = ['beta', ...result.stations.flatMap((s) => [`${s}_price`, `${s}_throughput`, `${s}_occupancy`, `${s}_profit`]), 'total_profit', 'total_user_cost']
    const rows = result.beta.map((b, i) => [
      b, ...result.stations.flatMap((s) => [result.prices[s][i], result.throughputs[s][i], result.occupancies[s][i], result.profits[s][i]]),
      result.total_profit[i], result.total_user_cost[i],
    ])
    downloadCsv('ev_adoption_sweep.csv', headers, rows)
  }

  return (
    <div>
      <p className="muted" style={{ marginBottom: 12 }}>
        Reproduces the paper-style sensitivity sweep: re-solves the full strategic-pricing equilibrium at each
        EV demand fraction β, holding total per-OD inflow fixed. This is a separate, independent solve from
        "Run simulation" above — it re-optimizes prices from scratch at every β.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap' }}>
        <label className="mono muted" style={{ fontSize: 11 }}>β min
          <input type="number" min={0} max={1} step={0.05} value={betaMin} onChange={(e) => setBetaMin(Number(e.target.value))}
                 style={{ display: 'block', marginTop: 4, width: 90, padding: 6, border: '1px solid var(--border)', borderRadius: 4 }} />
        </label>
        <label className="mono muted" style={{ fontSize: 11 }}>β max
          <input type="number" min={0} max={1} step={0.05} value={betaMax} onChange={(e) => setBetaMax(Number(e.target.value))}
                 style={{ display: 'block', marginTop: 4, width: 90, padding: 6, border: '1px solid var(--border)', borderRadius: 4 }} />
        </label>
        <label className="mono muted" style={{ fontSize: 11 }}>β step
          <input type="number" min={0.02} max={0.5} step={0.01} value={betaStep} onChange={(e) => setBetaStep(Number(e.target.value))}
                 style={{ display: 'block', marginTop: 4, width: 90, padding: 6, border: '1px solid var(--border)', borderRadius: 4 }} />
        </label>
        <button className="primary-button" onClick={() => onRun(betaMin, betaMax, betaStep)} disabled={running}>
          {running ? 'Sweeping…' : 'Run β sweep'}
        </button>
        {result && <button className="link-button" onClick={exportCsv}>Export CSV</button>}
      </div>

      {!result ? (
        <div className="empty-state">No sweep run yet.</div>
      ) : (
        <div className="charts-grid">
          <div className="chart-card">
            <div className="chart-title-row"><h3>Equilibrium price</h3><span className="mono muted">ψ*_s(β)</span></div>
            <div className="chart-area">
              <LineSeriesChart x={result.beta} xLabel="EV demand fraction β" yLabel="ψ*"
                series={result.stations.map((s) => ({ id: s, label: s, color: colorForStation(result.stations, s), values: result.prices[s] }))} />
            </div>
          </div>
          <div className="chart-card">
            <div className="chart-title-row"><h3>Equilibrium throughput</h3><span className="mono muted">ρ*_s(β)</span></div>
            <div className="chart-area">
              <LineSeriesChart x={result.beta} xLabel="β" yLabel="ρ*"
                series={result.stations.map((s) => ({ id: s, label: s, color: colorForStation(result.stations, s), values: result.throughputs[s] }))} />
            </div>
          </div>
          <div className="chart-card">
            <div className="chart-title-row"><h3>Equilibrium occupancy</h3><span className="mono muted">x*_s(β)</span></div>
            <div className="chart-area">
              <LineSeriesChart x={result.beta} xLabel="β" yLabel="x*"
                series={result.stations.map((s) => ({ id: s, label: s, color: colorForStation(result.stations, s), values: result.occupancies[s] }))} />
            </div>
          </div>
          <div className="chart-card">
            <div className="chart-title-row"><h3>Total profit &amp; user cost</h3><span className="mono muted">Σπ, total cost</span></div>
            <div className="chart-area">
              <LineSeriesChart x={result.beta} xLabel="β" yLabel="value"
                series={[
                  { id: 'profit', label: 'total station profit', color: '#2a5f5b', values: result.total_profit },
                  { id: 'cost', label: 'total user cost', color: '#c15b3f', values: result.total_user_cost },
                ]} />
            </div>
          </div>
        </div>
      )}
      {result?.warnings.length ? (
        <div className="warning-banner" style={{ marginTop: 12 }}>
          {result.warnings.length} equilibrium solve(s) in this sweep didn't fully converge to the practical tolerance; values are still typically accurate to 3-4 significant figures.
        </div>
      ) : null}
    </div>
  )
}
