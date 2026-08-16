import { useState } from 'react'
import type { PaperExperiment1Result, PaperExperiment2Result, PaperExperiment3Result } from '../types'
import { colorForIndex, colorForStation } from '../utils/colors'
import LineSeriesChart from './LineSeriesChart'

interface Props {
  exp1: PaperExperiment1Result | null
  exp2: PaperExperiment2Result | null
  exp3: PaperExperiment3Result | null
  running: 1 | 2 | 3 | null
  onRun1: (nSteps: number) => void
  onRun2: (nSteps: number) => void
  onRun3: (nSteps: number) => void
}

export default function PaperReproduction({ exp1, exp2, exp3, running, onRun1, onRun2, onRun3 }: Props) {
  const [n1, setN1] = useState(40)
  const [n2, setN2] = useState(25)
  const [n3, setN3] = useState(25)

  return (
    <div className="explain-section" style={{ maxWidth: 'none' }}>
      <p className="muted" style={{ marginBottom: 18 }}>
        These reproduce the three numerical experiments from the paper directly, on the paper's own fixed
        two-OD / three-station network (Fig. 2), independent of whichever scenario is loaded on the left.
        Reported paper values: ψ* ≈ (0.377, 0.377, 0.408), throughputs ρ* ≈ (0.276, 0.276, 0.648).
      </p>

      <div className="route-group">
        <div className="route-group-head">
          <h3>Experiment 1 — closed-loop convergence</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="number" min={5} max={150} value={n1} onChange={(e) => setN1(Number(e.target.value))}
                   className="mono" style={{ width: 64, padding: 6, border: '1px solid var(--border)', borderRadius: 4 }} />
            <button className="secondary-button" onClick={() => onRun1(n1)} disabled={running !== null}>
              {running === 1 ? 'Running…' : 'Run'}
            </button>
          </div>
        </div>
        <p className="muted" style={{ marginBottom: 10 }}>Three initial price profiles (uniform low, uniform high, asymmetric) should converge to the same Nash equilibrium.</p>
        {exp1 && (
          <>
            <table className="compare-table" style={{ marginBottom: 14 }}>
              <thead><tr><th>Initial condition</th>{exp1.stations.map((s) => <th key={s}>{s}</th>)}</tr></thead>
              <tbody>
                {Object.entries(exp1.runs).map(([label, run]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    {exp1.stations.map((s) => <td key={s}>{run.equilibrium_prices[s].toFixed(4)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="charts-grid">
              {Object.entries(exp1.runs).map(([label, run]) => (
                <div className="chart-card" key={label}>
                  <div className="chart-title-row"><h3>{label}</h3><span className="mono muted">ψ_s(k)</span></div>
                  <div className="chart-area">
                    <LineSeriesChart x={run.history.step} xLabel="outer step k" yLabel="ψ_s"
                      series={exp1.stations.map((s, i) => ({ id: s, label: s, color: colorForIndex(i), values: run.history.stations[s].price }))} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="route-group">
        <div className="route-group-head">
          <h3>Experiment 2 — sensitivity to EV demand fraction β</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="number" min={5} max={100} value={n2} onChange={(e) => setN2(Number(e.target.value))}
                   className="mono" style={{ width: 64, padding: 6, border: '1px solid var(--border)', borderRadius: 4 }} />
            <button className="secondary-button" onClick={() => onRun2(n2)} disabled={running !== null}>
              {running === 2 ? 'Running…' : 'Run'}
            </button>
          </div>
        </div>
        <p className="muted" style={{ marginBottom: 10 }}>The paper reports a non-monotone reversal: the shared station commands a price premium at low β, which private stations overtake past β ≈ 0.75.</p>
        {exp2 && (
          <div className="charts-grid">
            <div className="chart-card">
              <div className="chart-title-row"><h3>Equilibrium price</h3><span className="mono muted">ψ*_s(β)</span></div>
              <div className="chart-area">
                <LineSeriesChart x={exp2.beta} xLabel="β" yLabel="ψ*"
                  series={exp2.stations.map((s) => ({ id: s, label: s, color: colorForStation(exp2.stations, s), values: exp2.prices[s] }))} />
              </div>
            </div>
            <div className="chart-card">
              <div className="chart-title-row"><h3>Equilibrium throughput</h3><span className="mono muted">ρ*_s(β)</span></div>
              <div className="chart-area">
                <LineSeriesChart x={exp2.beta} xLabel="β" yLabel="ρ*"
                  series={exp2.stations.map((s) => ({ id: s, label: s, color: colorForStation(exp2.stations, s), values: exp2.throughputs[s] }))} />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="route-group">
        <div className="route-group-head">
          <h3>Experiment 3 — strategic vs. uniform fixed pricing</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="number" min={5} max={100} value={n3} onChange={(e) => setN3(Number(e.target.value))}
                   className="mono" style={{ width: 64, padding: 6, border: '1px solid var(--border)', borderRadius: 4 }} />
            <button className="secondary-button" onClick={() => onRun3(n3)} disabled={running !== null}>
              {running === 3 ? 'Running…' : 'Run'}
            </button>
          </div>
        </div>
        <p className="muted" style={{ marginBottom: 10 }}>Paper finding: strategic differentiation extracts slightly higher total profit but also slightly higher aggregate user cost than uniform pricing at the same average.</p>
        {exp3 && (
          <div className="chart-card">
            <div className="chart-title-row"><h3>Aggregate profit &amp; user cost vs. β</h3></div>
            <div className="chart-area">
              <LineSeriesChart x={exp3.beta} xLabel="β" yLabel="value"
                series={[
                  { id: 'profit_s', label: 'profit (strategic)', color: '#2a5f5b', values: exp3.strategic.profit },
                  { id: 'profit_f', label: 'profit (fixed)', color: '#9c8256', values: exp3.fixed.profit },
                  { id: 'cost_s', label: 'user cost (strategic)', color: '#c15b3f', values: exp3.strategic.user_cost },
                  { id: 'cost_f', label: 'user cost (fixed)', color: '#b0743a', values: exp3.fixed.user_cost },
                ]} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
