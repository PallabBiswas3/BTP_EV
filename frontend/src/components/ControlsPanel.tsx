import { useState } from 'react'
import type { NetworkConfig, ScenarioMeta, SimulationOptions } from '../types'
import { DEFAULT_SIMULATION_OPTIONS } from '../types'

interface Props {
  scenarios: ScenarioMeta[]
  scenario: string
  network: NetworkConfig
  options: SimulationOptions
  running: boolean
  onScenarioChange: (scenario: string) => void
  onNetworkChange: (network: NetworkConfig) => void
  onOptionsChange: (options: SimulationOptions) => void
  onRun: () => void
  onValidate: () => void
}

const PAPER_DEFAULTS: NetworkConfig['defaults'] = {
  l0: 0.25, L: 2.0, a: 1.0, mu_s: 2.0, a_s: 0.5, c_s: 0.2,
  phi0: 0.1, alpha: 0.3, gamma: 1.0, eta: 0.05,
}

export default function ControlsPanel({
  scenarios, scenario, network, options, running,
  onScenarioChange, onNetworkChange, onOptionsChange, onRun, onValidate,
}: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [solverOpen, setSolverOpen] = useState(false)

  const setDefault = (key: keyof NetworkConfig['defaults'], value: number) => {
    onNetworkChange({ ...network, defaults: { ...network.defaults, [key]: value } })
  }

  const setOption = (key: keyof SimulationOptions, value: number) => {
    onOptionsChange({ ...options, [key]: value })
  }

  const setBeta = (beta: number) => {
    onNetworkChange({
      ...network,
      ods: network.ods.map((od) => {
        const currentlyMixed = (od.shares.EV ?? 0) > 0 && (od.shares.NEV ?? 0) > 0
        if (!currentlyMixed) return od
        return { ...od, shares: { ...od.shares, EV: beta, NEV: 1 - beta } }
      }),
    })
  }

  const setLambda = (lam: number) => {
    onNetworkChange({ ...network, ods: network.ods.map((od) => ({ ...od, lam })) })
  }

  const beta = network.ods.find((od) => (od.shares.NEV ?? 0) > 0)?.shares.EV ?? 0.6
  const lambda = network.ods[0]?.lam ?? 1.0

  const loadPaperDefaults = () => {
    onNetworkChange({ ...network, defaults: { ...PAPER_DEFAULTS } })
    onOptionsChange({ ...DEFAULT_SIMULATION_OPTIONS })
  }

  return (
    <aside className="panel controls-panel">
      <div>
        <p className="eyebrow">Simulation setup</p>
        <h2>Network controls</h2>
        <p className="muted">Values map directly onto the backend model — see Model Explanation for the formulas.</p>
      </div>

      <label>
        Scenario
        <select value={scenario} onChange={(e) => onScenarioChange(e.target.value)}>
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>{s.id}.json · {s.label}</option>
          ))}
        </select>
      </label>
      {scenarios.find((s) => s.id === scenario) && (
        <p className="muted" style={{ marginTop: -8 }}>
          {scenarios.find((s) => s.id === scenario)!.description}
        </p>
      )}

      <label>
        EV demand fraction β
        <div className="two-col-form" style={{ gridTemplateColumns: '1fr 46px', alignItems: 'center' }}>
          <input type="range" min="0.05" max="0.95" step="0.05" value={beta}
                 onChange={(e) => setBeta(Number(e.target.value))} />
          <strong className="mono">{beta.toFixed(2)}</strong>
        </div>
      </label>

      <label>
        Inflow per OD λ
        <div className="two-col-form" style={{ gridTemplateColumns: '1fr 46px', alignItems: 'center' }}>
          <input type="range" min="0.2" max="3" step="0.1" value={lambda}
                 onChange={(e) => setLambda(Number(e.target.value))} />
          <strong className="mono">{lambda.toFixed(1)}</strong>
        </div>
      </label>

      <div className="two-col-form">
        <label>Road capacity L
          <input type="number" value={network.defaults.L} step="0.1" onChange={(e) => setDefault('L', Number(e.target.value))} />
        </label>
        <label>Free-flow l0
          <input type="number" value={network.defaults.l0} step="0.05" onChange={(e) => setDefault('l0', Number(e.target.value))} />
        </label>
        <label>Station μs
          <input type="number" value={network.defaults.mu_s} step="0.1" onChange={(e) => setDefault('mu_s', Number(e.target.value))} />
        </label>
        <label>Station as
          <input type="number" value={network.defaults.a_s} step="0.1" onChange={(e) => setDefault('a_s', Number(e.target.value))} />
        </label>
      </div>

      <div className="section-divider">
        <div className="collapse-toggle" onClick={() => setAdvancedOpen((v) => !v)}>
          <h3>Advanced model parameters</h3>
          <span className="mono muted">{advancedOpen ? '−' : '+'}</span>
        </div>
        {advancedOpen && (
          <div className="two-col-form" style={{ marginTop: 12 }}>
            <label>Outflow rate a
              <input type="number" value={network.defaults.a} step="0.1" onChange={(e) => setDefault('a', Number(e.target.value))} />
            </label>
            <label>Marginal cost c_s
              <input type="number" value={network.defaults.c_s} step="0.05" onChange={(e) => setDefault('c_s', Number(e.target.value))} />
            </label>
            <label>Free-flow access φ0
              <input type="number" value={network.defaults.phi0} step="0.05" onChange={(e) => setDefault('phi0', Number(e.target.value))} />
            </label>
            <label>Wait weight α
              <input type="number" value={network.defaults.alpha} step="0.05" onChange={(e) => setDefault('alpha', Number(e.target.value))} />
            </label>
            <label>Price weight γ
              <input type="number" value={network.defaults.gamma} step="0.1" onChange={(e) => setDefault('gamma', Number(e.target.value))} />
            </label>
            <label>Replicator rate η
              <input type="number" value={network.defaults.eta} step="0.01" onChange={(e) => setDefault('eta', Number(e.target.value))} />
            </label>
          </div>
        )}
      </div>

      <div className="section-divider">
        <div className="collapse-toggle" onClick={() => setSolverOpen((v) => !v)}>
          <h3>Solver settings</h3>
          <span className="mono muted">{solverOpen ? '−' : '+'}</span>
        </div>
        {solverOpen && (
          <div className="two-col-form" style={{ marginTop: 12 }}>
            <label>Pricing steps
              <input type="number" min={1} max={200} value={options.n_steps} onChange={(e) => setOption('n_steps', Number(e.target.value))} />
            </label>
            <label>Sim. time t_end
              <input type="number" min={1} value={options.t_end} onChange={(e) => setOption('t_end', Number(e.target.value))} />
            </label>
            <label>Learning rate κ
              <input type="number" step="0.01" value={options.kappa} onChange={(e) => setOption('kappa', Number(e.target.value))} />
            </label>
            <label>Gradient step δ
              <input type="number" step="0.005" value={options.delta} onChange={(e) => setOption('delta', Number(e.target.value))} />
            </label>
            <label>Price cap ψ_max
              <input type="number" step="0.1" value={options.psi_max} onChange={(e) => setOption('psi_max', Number(e.target.value))} />
            </label>
            <label>Outer step dt
              <input type="number" step="0.1" value={options.dt_outer} onChange={(e) => setOption('dt_outer', Number(e.target.value))} />
            </label>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="primary-button" style={{ flex: 1 }} onClick={onRun} disabled={running}>
          {running ? 'Solving…' : 'Run simulation'}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="secondary-button" style={{ flex: 1 }} onClick={onValidate} disabled={running}>Validate network</button>
        <button className="secondary-button" style={{ flex: 1 }} onClick={loadPaperDefaults} disabled={running}>Paper defaults</button>
      </div>

      <div className="formula-box">
        <span>Inner loop</span>
        <strong>ẋ, ẏ → 0</strong>
        <span>Outer loop</span>
        <strong>ψ ← ψ + κ ∂π/∂ψ</strong>
      </div>
    </aside>
  )
}
