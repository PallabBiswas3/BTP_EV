import { useEffect, useMemo, useRef, useState } from 'react'
import ControlsPanel from './components/ControlsPanel'
import EVAdoption from './components/EVAdoption'
import ModelExplanation from './components/ModelExplanation'
import NetworkGraph, { type ViewMode } from './components/NetworkGraph'
import PaperReproduction from './components/PaperReproduction'
import PricingDynamics from './components/PricingDynamics'
import ProgressOverlay from './components/ProgressOverlay'
import RouteChoice from './components/RouteChoice'
import StationAnalysis from './components/StationAnalysis'
import StationCards from './components/StationCards'
import StrategicVsFixed from './components/StrategicVsFixed'
import {
  fetchScenarioNetwork, fetchScenarios, runBetaSweep, runComparePricing,
  runPaperExperiment1, runPaperExperiment2, runPaperExperiment3, runSimulate, validateNetwork,
} from './api'
import type {
  BetaSweepResult, ComparePricingResult, NetworkConfig, PaperExperiment1Result,
  PaperExperiment2Result, PaperExperiment3Result, ScenarioMeta, SimulateResult, SimulationOptions,
} from './types'
import { DEFAULT_SIMULATION_OPTIONS } from './types'

type Tab = 'network' | 'pricing' | 'routes' | 'stations' | 'adoption' | 'compare' | 'paper' | 'explain' | 'data'

const TABS: { id: Tab; label: string }[] = [
  { id: 'network', label: 'Network Dynamics' },
  { id: 'pricing', label: 'Pricing Dynamics' },
  { id: 'routes', label: 'Route Choice' },
  { id: 'stations', label: 'Station Analysis' },
  { id: 'adoption', label: 'EV Adoption' },
  { id: 'compare', label: 'Strategic vs Fixed' },
  { id: 'paper', label: 'Paper Reproduction' },
  { id: 'explain', label: 'Model Explanation' },
  { id: 'data', label: 'Raw Data' },
]

type ActiveJob = 'simulate' | 'equilibrium' | 'beta' | 'compare' | 'exp1' | 'exp2' | 'exp3' | null

export default function App() {
  const [scenarios, setScenarios] = useState<ScenarioMeta[]>([])
  const [scenarioId, setScenarioId] = useState('i')
  const [network, setNetwork] = useState<NetworkConfig | null>(null)
  const [options, setOptions] = useState<SimulationOptions>(DEFAULT_SIMULATION_OPTIONS)

  const [result, setResult] = useState<SimulateResult | null>(null)
  const [activeJob, setActiveJob] = useState<ActiveJob>(null)
  const [progress, setProgress] = useState({ phase: '', step: 0, nSteps: 0 })
  const [error, setError] = useState('')
  const [validationMsg, setValidationMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const [tab, setTab] = useState<Tab>('network')
  const [timeIndex, setTimeIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [viewMode, setViewMode] = useState<ViewMode>('total')
  const [selectedStation, setSelectedStation] = useState<string | null>(null)

  const [betaResult, setBetaResult] = useState<BetaSweepResult | null>(null)
  const [compareResult, setCompareResult] = useState<ComparePricingResult | null>(null)
  const [exp1, setExp1] = useState<PaperExperiment1Result | null>(null)
  const [exp2, setExp2] = useState<PaperExperiment2Result | null>(null)
  const [exp3, setExp3] = useState<PaperExperiment3Result | null>(null)

  const playTimer = useRef<number | null>(null)

  // Load scenario list once, then the initial network.
  useEffect(() => {
    fetchScenarios()
      .then((list) => {
        setScenarios(list)
        return fetchScenarioNetwork(list[0]?.id ?? 'i')
      })
      .then(setNetwork)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not reach the backend.'))
  }, [])

  const selectScenario = (id: string) => {
    setScenarioId(id)
    setError('')
    fetchScenarioNetwork(id)
      .then((cfg) => {
        setNetwork(cfg)
        setResult(null)
        setTimeIndex(0)
        setSelectedStation(null)
        setBetaResult(null); setCompareResult(null)
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load scenario.'))
  }

  const importNetwork = (config: NetworkConfig) => {
    setScenarioId('custom-csv')
    setNetwork(config)
    setResult(null)
    setTimeIndex(0)
    setPlaying(false)
    setSelectedStation(null)
    setBetaResult(null)
    setCompareResult(null)
    setValidationMsg({ ok: true, text: 'CSV network validated and loaded.' })
    setError('')
  }

  const onProgress = (phase: string, step: number, nSteps: number) => setProgress({ phase, step, nSteps })

  const simulate = async () => {
    if (!network) return
    setActiveJob('simulate'); setError(''); setValidationMsg(null)
    try {
      const r = await runSimulate(network, options, onProgress)
      setResult(r)
      setTimeIndex(0)
      setPlaying(r.trajectory.time.length > 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Simulation failed.')
    } finally {
      setActiveJob(null)
    }
  }

  const validate = async () => {
    if (!network) return
    setError('')
    try {
      const v = await validateNetwork(network)
      if (v.valid) {
        setValidationMsg({ ok: true, text: v.warnings.length ? `Valid, with warnings: ${v.warnings.join(' ')}` : 'Network is valid.' })
      } else {
        setValidationMsg({ ok: false, text: v.errors.join(' ') })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Validation request failed.')
    }
  }

  const runBeta = async (betaMin: number, betaMax: number, betaStep: number) => {
    if (!network) return
    setActiveJob('beta'); setError('')
    try {
      setBetaResult(await runBetaSweep(network, options, betaMin, betaMax, betaStep, onProgress))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Beta sweep failed.')
    } finally {
      setActiveJob(null)
    }
  }

  const runCompare = async () => {
    if (!network) return
    setActiveJob('compare'); setError('')
    try {
      setCompareResult(await runComparePricing(network, options, onProgress))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Comparison failed.')
    } finally {
      setActiveJob(null)
    }
  }

  const runExp = async (which: 1 | 2 | 3, nSteps: number) => {
    setActiveJob(which === 1 ? 'exp1' : which === 2 ? 'exp2' : 'exp3'); setError('')
    try {
      if (which === 1) setExp1(await runPaperExperiment1(nSteps, onProgress))
      else if (which === 2) setExp2(await runPaperExperiment2(nSteps, onProgress))
      else setExp3(await runPaperExperiment3(nSteps, onProgress))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Paper experiment failed.')
    } finally {
      setActiveJob(null)
    }
  }

  // Playback loop for the network-dynamics time slider.
  useEffect(() => {
    if (playing && result) {
      playTimer.current = window.setInterval(() => {
        setTimeIndex((prev) => {
          const next = prev + 1
          if (next >= result.trajectory.time.length) { setPlaying(false); return prev }
          return next
        })
      }, 500 / playbackSpeed)
    }
    return () => { if (playTimer.current) window.clearInterval(playTimer.current) }
  }, [playing, playbackSpeed, result])

  const totalEV = useMemo(
    () => (network ? network.ods.reduce((sum, od) => sum + od.lam * (od.shares.EV ?? 0), 0) : 0),
    [network],
  )
  const totalNEV = useMemo(
    () => (network ? network.ods.reduce((sum, od) => sum + od.lam * (od.shares.NEV ?? 0), 0) : 0),
    [network],
  )
  const maxCongestion = useMemo(() => {
    if (!result) return null
    const idx = Math.min(timeIndex, result.trajectory.time.length - 1)
    let max = 0
    Object.values(result.trajectory.roads).forEach((r) => { max = Math.max(max, r.capacity_ratio[idx] ?? 0) })
    return max
  }, [result, timeIndex])
  const busiestStation = useMemo(() => {
    if (!result) return null
    type Best = { name: string; util: number }
    let best: Best | null = null
    Object.entries(result.trajectory.stations).forEach(([name, s]) => {
      const util = s.occupancy[s.occupancy.length - 1] / s.saturation_K
      if (best === null || util > (best as Best).util) best = { name, util }
    })
    return best as Best | null
  }, [result])

  if (!network) {
    return (
      <div className="app-shell">
        <div style={{ padding: 40 }}>
          {error ? <div className="error-banner">{error}</div> : <p className="muted">Loading network…</p>}
        </div>
      </div>
    )
  }

  const running = activeJob !== null

  const togglePlayback = () => {
    if (!result) return
    const lastIndex = Math.max(0, result.trajectory.time.length - 1)
    if (!playing && timeIndex >= lastIndex) setTimeIndex(0)
    setPlaying((current) => !current)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <span className="brand-mark">EVCS</span>
          <div>
            <p className="eyebrow">Research simulator</p>
            <h1>EV Dynamic Pricing Lab</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <span className={`status ${activeJob === 'simulate' ? 'busy' : result ? 'ready' : ''}`}>
            {activeJob === 'simulate' ? 'Solving…' : result ? 'Equilibrium ready' : 'Awaiting run'}
          </span>
        </div>
      </header>

      <main className="main-layout">
        <ControlsPanel
          scenarios={scenarios}
          scenario={scenarioId}
          network={network}
          options={options}
          running={running}
          onScenarioChange={selectScenario}
          onImportNetwork={importNetwork}
          onNetworkChange={setNetwork}
          onOptionsChange={setOptions}
          onRun={simulate}
          onValidate={validate}
        />

        <section className="workspace">
          <div className="metric-grid">
            <div className="metric-card"><span>Total EV demand</span><strong>{totalEV.toFixed(2)}</strong><small>veh/time</small></div>
            <div className="metric-card"><span>Total NEV demand</span><strong>{totalNEV.toFixed(2)}</strong><small>veh/time</small></div>
            <div className="metric-card"><span>Station throughput</span><strong>{result ? result.equilibrium.total_profit && Object.values(result.equilibrium.throughputs).reduce((a, b) => a + b, 0).toFixed(2) : '—'}</strong><small>veh/time</small></div>
            <div className="metric-card"><span>Total station profit</span><strong>{result ? result.equilibrium.total_profit.toFixed(3) : '—'}</strong><small>$/time</small></div>
            <div className="metric-card"><span>Total user cost</span><strong>{result ? result.equilibrium.total_user_cost.toFixed(3) : '—'}</strong><small>at equilibrium</small></div>
            <div className="metric-card"><span>Max congestion x/L</span><strong>{maxCongestion !== null ? maxCongestion.toFixed(2) : '—'}</strong><small>{busiestStation ? `busiest: ${busiestStation.name}` : ''}</small></div>
          </div>

          {error && <div className="error-banner"><b>Error:</b> {error}</div>}
          {validationMsg && (
            <div className={validationMsg.ok ? 'warning-banner' : 'error-banner'} style={validationMsg.ok ? { borderColor: '#bcdac9', background: 'var(--ok-soft)', color: '#2c5c40' } : undefined}>
              <b>{validationMsg.ok ? 'Validation passed:' : 'Validation failed:'}</b> {validationMsg.text}
            </div>
          )}
          {result && !result.equilibrium.converged && (
            <div className="warning-banner">
              One or more equilibrium solves did not meet the residual tolerance. Treat this run as an
              estimate and use the Research profile or more pricing steps before reporting its values.
            </div>
          )}
          {result && (
            <div className={result.equilibrium.quality.certified ? 'quality-banner certified' : 'quality-banner estimated'}>
              <div><span>Quality</span><strong>{result.equilibrium.quality.certified ? 'Numerically certified' : 'Estimate only'}</strong></div>
              <div><span>Profile</span><strong>{result.equilibrium.quality.accuracy_mode}</strong></div>
              <div><span>Routes / states</span><strong>{result.equilibrium.quality.path_count} / {result.equilibrium.quality.state_count}</strong></div>
              <div><span>Final residual</span><strong>{result.equilibrium.quality.final_residual.toExponential(2)}</strong></div>
              <div><span>Conservation error</span><strong>{result.equilibrium.quality.conservation_error.toExponential(2)}</strong></div>
              <div><span>Gradient</span><strong>{result.equilibrium.quality.gradient_method}</strong></div>
              <div><span>Pricing iterations</span><strong>{result.equilibrium.quality.completed_steps} · {result.equilibrium.quality.stop_reason}</strong></div>
              {!result.equilibrium.quality.outer_converged && (
                <div className="quality-detail">The projected price update did not remain below {result.equilibrium.quality.outer_tolerance.toExponential(1)} for {result.equilibrium.quality.stable_steps_required} consecutive iterations. Final projected change: {result.equilibrium.quality.last_projected_price_change.toExponential(2)}.</div>
              )}
              {result.equilibrium.quality.route_limit_hits.length > 0 && (
                <div className="quality-detail">Route cap reached for {result.equilibrium.quality.route_limit_hits.join(', ')}.</div>
              )}
            </div>
          )}

          <nav className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </nav>

          {tab === 'network' && (
            <div className="network-grid">
              <div className="panel network-panel">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Dynamic topology</p>
                    <h2>Traffic and charging network</h2>
                  </div>
                  <div className="legend">
                    <span><i className="legend-road" /> Road (EV &amp; NEV)</span>
                    <span><i className="legend-nev" /> NEV-only road</span>
                    <span><i className="legend-station" /> Charging access link</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                  {(['total', 'ev', 'nev', 'latency'] as ViewMode[]).map((m) => (
                    <button key={m} className={`chip${viewMode === m ? ' active' : ''}`} onClick={() => setViewMode(m)}>
                      {m === 'total' ? 'Total congestion' : m === 'ev' ? 'EV density' : m === 'nev' ? 'NEV density' : 'Latency'}
                    </button>
                  ))}
                </div>
                <NetworkGraph
                  network={network}
                  trajectory={result?.trajectory ?? null}
                  timeIndex={timeIndex}
                  mode={viewMode}
                  selectedStation={selectedStation}
                  onSelectStation={setSelectedStation}
                />
                <div className="timeline-row">
                  <span>Equilibrium step</span>
                  <input type="range" min="0" max={Math.max(0, (result?.trajectory.time.length ?? 1) - 1)}
                         value={Math.min(timeIndex, (result?.trajectory.time.length ?? 1) - 1)}
                         onChange={(e) => setTimeIndex(Number(e.target.value))} disabled={!result} />
                  <strong>{result ? result.trajectory.time[Math.min(timeIndex, result.trajectory.time.length - 1)].toFixed(1) : '—'}</strong>
                </div>
                <div className="playback-row">
                  <button onClick={togglePlayback} disabled={!result}>{playing ? 'Pause' : 'Play'}</button>
                  <button onClick={() => { setPlaying(false); setTimeIndex(0) }} disabled={!result}>Restart</button>
                  <select value={playbackSpeed} onChange={(e) => setPlaybackSpeed(Number(e.target.value))}>
                    <option value={0.5}>0.5×</option>
                    <option value={1}>1×</option>
                    <option value={2}>2×</option>
                    <option value={4}>4×</option>
                  </select>
                </div>
              </div>

              <div className="panel station-panel">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Equilibrium state</p>
                    <h2>Charging stations</h2>
                  </div>
                </div>
                <StationCards network={network} equilibrium={result?.equilibrium ?? null}
                              selectedStation={selectedStation} onSelectStation={setSelectedStation} />
              </div>
            </div>
          )}

          {tab === 'pricing' && <div className="panel network-panel"><PricingDynamics history={result?.outer_history ?? null} /></div>}
          {tab === 'routes' && <div className="panel network-panel"><RouteChoice trajectory={result?.trajectory ?? null} timeIndex={timeIndex} /></div>}
          {tab === 'stations' && <div className="panel network-panel"><StationAnalysis trajectory={result?.trajectory ?? null} timeIndex={timeIndex} selectedStation={selectedStation} onSelectStation={setSelectedStation} /></div>}
          {tab === 'adoption' && <div className="panel network-panel"><EVAdoption result={betaResult} running={activeJob === 'beta'} onRun={runBeta} /></div>}
          {tab === 'compare' && <div className="panel network-panel"><StrategicVsFixed result={compareResult} running={activeJob === 'compare'} onRun={runCompare} /></div>}
          {tab === 'paper' && (
            <div className="panel network-panel">
              <PaperReproduction
                exp1={exp1} exp2={exp2} exp3={exp3}
                running={activeJob === 'exp1' ? 1 : activeJob === 'exp2' ? 2 : activeJob === 'exp3' ? 3 : null}
                onRun1={(n) => runExp(1, n)} onRun2={(n) => runExp(2, n)} onRun3={(n) => runExp(3, n)}
              />
            </div>
          )}
          {tab === 'explain' && <div className="panel network-panel"><ModelExplanation /></div>}
          {tab === 'data' && (
            <div className="panel json-panel">
              <div className="section-heading">
                <div><p className="eyebrow">Backend payload</p><h2>Simulation response</h2></div>
              </div>
              <pre>{JSON.stringify(result ?? { message: 'Run a simulation to inspect the backend response.' }, null, 2)}</pre>
            </div>
          )}
        </section>
      </main>

      {running && <ProgressOverlay phase={progress.phase || 'Working…'} step={progress.step} nSteps={progress.nSteps} />}
    </div>
  )
}
