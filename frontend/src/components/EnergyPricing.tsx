import { useEffect, useState } from 'react'
import { fetchEnergyScenario, fetchEnergyScenarios } from '../api'
import type { EnergyOptions, EnergyResult, ScenarioMeta } from '../types'
import { DEFAULT_ENERGY_OPTIONS } from '../types'
import { REFERENCE_INK, colorForIndex } from '../utils/colors'
import ChargingScene from './ChargingScene'
import EnergyNetwork, { SOURCE_COLORS, formatClock } from './EnergyNetwork'
import LineSeriesChart from './LineSeriesChart'

interface Props {
  result: EnergyResult | null
  running: boolean
  onRun: (scenario: Record<string, unknown>, options: EnergyOptions) => void
}

const inputStyle = { width: 72, padding: 6, border: '1px solid var(--border)', borderRadius: 4 }
const percent = (value: number) => `${(100 * value).toFixed(0)}%`
const money = (value: number) => Math.round(value).toLocaleString()

export default function EnergyPricing({ result, running, onRun }: Props) {
  const [scenarios, setScenarios] = useState<ScenarioMeta[]>([])
  const [scenarioId, setScenarioId] = useState('')
  const [options, setOptions] = useState<EnergyOptions>(DEFAULT_ENERGY_OPTIONS)
  const [site, setSite] = useState('')
  const [timeIndex, setTimeIndex] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchEnergyScenarios()
      .then((list) => { setScenarios(list); setScenarioId(list[0]?.id ?? '') })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load energy scenarios.'))
  }, [])

  // Start each new result at its final step.
  useEffect(() => { if (result) setTimeIndex(result.time.length - 1) }, [result])

  const run = async () => {
    setError('')
    try {
      onRun(await fetchEnergyScenario(scenarioId), options)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the scenario.')
    }
  }

  const setNumber = (key: 'h' | 'horizon' | 'kappa' | 'delta', value: string) =>
    setOptions((prev) => ({ ...prev, [key]: Number(value) }))

  const description = scenarios.find((s) => s.id === scenarioId)?.description
  const chargerNames = result ? Object.keys(result.chargers) : []
  const siteNames = result ? Object.keys(result.sites) : []
  const activeSite = result ? (result.sites[site] ? site : siteNames[0]) : ''
  const selected = result && activeSite ? result.sites[activeSite] : null
  const modes = result ? Array.from(new Set(chargerNames.map((name) => result.chargers[name].mode))) : []
  const currency = result?.units.currency ?? ''
  const idx = result ? Math.min(timeIndex, result.time.length - 1) : 0

  return (
    <div className="explain-section" style={{ maxWidth: 'none' }}>
      <p className="muted" style={{ marginBottom: 14 }}>
        Each site owns fast and slow chargers and may have solar panels and a battery beside its grid
        connection. Every step it plans its energy for the next day, then adjusts each charger price by a
        profit gradient. Time is in hours, power in kW, energy in kWh and prices are per vehicle. This model
        is separate from the scenario and settings in the left panel.
      </p>

      <div className="route-group">
        <div className="route-group-head">
          <h3>Run</h3>
          <button className="secondary-button" onClick={run} disabled={running || !scenarioId}>
            {running ? 'Running…' : 'Run energy pricing'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
          <label>Scenario{' '}
            <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
              {scenarios.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <label>Days{' '}
            <input type="number" min={1} max={14} step={1} value={options.t_end / 24} className="mono" style={inputStyle}
                   onChange={(e) => setOptions((prev) => ({ ...prev, t_end: 24 * Number(e.target.value) }))} />
          </label>
          <label>Step (h){' '}
            <select value={options.h} onChange={(e) => setNumber('h', e.target.value)} style={inputStyle}>
              <option value={0.25}>0.25</option><option value={0.5}>0.5</option><option value={1}>1</option>
            </select>
          </label>
          <label>Look-ahead (steps){' '}
            <input type="number" min={1} max={12} value={options.horizon} className="mono" style={inputStyle}
                   onChange={(e) => setNumber('horizon', e.target.value)} />
          </label>
          <label>Gain κ{' '}
            <input type="number" min={0.1} step={0.5} value={options.kappa} className="mono" style={inputStyle}
                   onChange={(e) => setNumber('kappa', e.target.value)} />
          </label>
          <label>Perturbation δ{' '}
            <input type="number" min={0.5} step={0.5} value={options.delta} className="mono" style={inputStyle}
                   onChange={(e) => setNumber('delta', e.target.value)} />
          </label>
          <label>Price cap{' '}
            <input type="number" min={0} placeholder="none" value={options.price_cap ?? ''} className="mono" style={inputStyle}
                   onChange={(e) => setOptions((prev) => ({ ...prev, price_cap: Number(e.target.value) > 0 ? Number(e.target.value) : null }))} />
          </label>
          <label>
            <input type="checkbox" checked={options.parallel}
                   onChange={(e) => setOptions((prev) => ({ ...prev, parallel: e.target.checked }))} /> Parallel forecasts
          </label>
        </div>
        {description && <p className="muted" style={{ marginTop: 10 }}>{description}</p>}
        <p className="muted">A three-day run of the bundled scenario takes a few minutes. Run at least two days: the first day uses a guessed load forecast.</p>
        {error && <p style={{ color: '#a33d2c', fontSize: 12.5 }}>{error}</p>}
      </div>

      {result && (
        <>
          {result.warnings.map((warning) => <p key={warning} className="muted">Note: {warning}</p>)}

          <div className="route-group">
            <div className="route-group-head"><h3>Network</h3><span className="mono muted">move the slider to replay the run</span></div>
            <EnergyNetwork result={result} selectedSite={activeSite} onSelectSite={setSite}
                           index={idx} onIndexChange={setTimeIndex} />
          </div>

          <div className="route-group">
            <div className="route-group-head">
              <h3>Stations at {formatClock(result.time[idx])}</h3>
              <span className="mono muted">vehicles arrive, wait, charge and leave</span>
            </div>
            <div className="site-cards">
              {siteNames.map((name) => {
                const s = result.sites[name]
                const load = s.load_kw[idx]
                const sources = [
                  { key: 'solar', label: 'Solar', value: s.solar_to_load_kw[idx], color: SOURCE_COLORS.solar },
                  { key: 'battery', label: 'Battery', value: s.battery_to_load_kw[idx], color: SOURCE_COLORS.battery },
                  { key: 'grid', label: 'Grid', value: s.grid_to_load_kw[idx], color: SOURCE_COLORS.grid },
                ]
                return (
                  <div key={name} className={`site-card${activeSite === name ? ' selected' : ''}`} onClick={() => setSite(name)}>
                    <div className="scp-head"><h3>{name}</h3><span>{Math.round(s.profit_rate[idx]).toLocaleString()} {currency}/h profit</span></div>
                    <div className="scp-tags">
                      {s.has_solar && <span>Solar {s.solar_peak_kw.toFixed(0)} kW</span>}
                      {s.has_storage && <span>Battery {s.battery_capacity_kwh.toFixed(0)} kWh</span>}
                      {!s.has_solar && !s.has_storage && <span>Grid only</span>}
                      <span>{s.strategic ? 'Sets its own prices' : 'Fixed price'}</span>
                    </div>
                    {s.chargers.map((edge) => {
                      const c = result.chargers[edge]
                      return (
                        <div key={edge}>
                          <div className="site-card-mode">
                            <span><b style={{ textTransform: 'capitalize' }}>{c.mode}</b> <small>{c.count} × {c.power_kw.toFixed(0)} kW</small></span>
                            <span><b className="price">{c.price[idx].toFixed(0)}</b> <small>{currency}/vehicle</small></span>
                          </div>
                          <ChargingScene color={c.mode === 'slow' ? '#eb6834' : '#2a78d6'} bays={c.count} occupancy={c.occupancy[idx]} queue={c.queue[idx]}
                            arrivalRate={c.arrivals[idx]} departureRate={c.throughput[idx]}
                            capacity={(c.count * c.power_kw) / (Number(result.settings.energy_per_vehicle_kwh) || 20)}
                            chargeSeconds={Math.min(8, Math.max(2, 120 / c.power_kw))} />
                        </div>
                      )
                    })}
                    <div className="scp-section">
                      <div className="scp-label">Power to vehicles · {load.toFixed(0)} kW</div>
                      {load > 0.05 ? (
                        <div className="scp-stack">
                          {sources.filter((src) => src.value > 0.005 * load).map((src) => (
                            <span key={src.key} style={{ flex: src.value, background: src.color }} />
                          ))}
                        </div>
                      ) : <div className="scp-stack empty" />}
                      <div className="scp-legend">
                        {sources.map((src) => (
                          <div key={src.key}>
                            <small><i style={{ background: src.color }} />{src.label}</small>
                            <b>{src.value.toFixed(0)} kW</b>
                          </div>
                        ))}
                      </div>
                    </div>
                    {s.has_storage && (
                      <div className="scp-section">
                        <div className="scp-label">Battery · {Math.round(100 * s.soc[idx])}% · {s.stored_kwh[idx].toFixed(0)} kWh</div>
                        <div className="scp-gauge"><span style={{ width: `${100 * s.soc[idx]}%`, background: SOURCE_COLORS.battery }} /></div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="route-group">
            <div className="route-group-head"><h3>Last simulated day, per site</h3><span className="mono muted">{currency}</span></div>
            <table className="compare-table">
              <thead>
                <tr>
                  <th>Site</th><th>Profit</th><th>Revenue</th><th>Energy cost</th><th>Fixed cost</th><th>Vehicles</th>
                  {modes.map((mode) => <th key={mode}>Mean {mode} price</th>)}
                  <th>Solar</th><th>Battery</th><th>Grid</th>
                </tr>
              </thead>
              <tbody>
                {siteNames.map((name) => {
                  const s = result.sites[name]
                  const day = s.last_day
                  const kind = [s.has_solar && 'solar', s.has_storage && 'battery', !s.strategic && 'fixed price'].filter(Boolean).join(', ')
                  return (
                    <tr key={name}>
                      <td>{name}{kind && <span className="muted"> ({kind})</span>}</td>
                      <td>{money(day.profit)}</td><td>{money(day.revenue)}</td><td>{money(day.energy_cost)}</td>
                      <td>{money(day.fixed_cost)}</td><td>{day.vehicles_served.toFixed(1)}</td>
                      {modes.map((mode) => <td key={mode}>{day.average_price[mode] === undefined ? '—' : day.average_price[mode].toFixed(0)}</td>)}
                      <td>{percent(day.share_solar_direct)}</td><td>{percent(day.share_battery)}</td><td>{percent(day.share_grid_direct)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="muted" style={{ marginTop: 8 }}>Solar, Battery and Grid are the shares of the energy delivered to vehicles.</p>
          </div>

          <div className="charts-grid">
            <div className="chart-card">
              <div className="chart-title-row"><h3>Charger prices</h3><span className="mono muted">{result.units.price}</span></div>
              <div className="chart-area">
                <LineSeriesChart x={result.time} xLabel="time (h)" yLabel="price"
                  series={chargerNames.map((name, i) => ({ id: name, label: name, color: colorForIndex(i), values: result.chargers[name].price }))} />
              </div>
            </div>
            <div className="chart-card">
              <div className="chart-title-row"><h3>Arrivals per charger type</h3><span className="mono muted">vehicles/h</span></div>
              <div className="chart-area">
                <LineSeriesChart x={result.time} xLabel="time (h)" yLabel="arrivals"
                  series={chargerNames.map((name, i) => ({ id: name, label: name, color: colorForIndex(i), values: result.chargers[name].arrivals }))} />
              </div>
            </div>
            <div className="chart-card">
              <div className="chart-title-row"><h3>Grid tariff and marginal energy cost</h3><span className="mono muted">{currency}/kWh</span></div>
              <div className="chart-area">
                <LineSeriesChart x={result.time} xLabel="time (h)" yLabel="cost"
                  series={[
                    { id: 'tariff', label: 'grid tariff', color: REFERENCE_INK, values: result.tariff },
                    ...siteNames.filter((name) => result.sites[name].has_solar || result.sites[name].has_storage)
                      .map((name) => ({ id: name, label: `${name} marginal cost`, color: colorForIndex(siteNames.indexOf(name)), values: result.sites[name].marginal_cost })),
                  ]} />
              </div>
            </div>
            <div className="chart-card">
              <div className="chart-title-row"><h3>Operating profit rate</h3><span className="mono muted">{currency}/h</span></div>
              <div className="chart-area">
                <LineSeriesChart x={result.time} xLabel="time (h)" yLabel="profit rate"
                  series={siteNames.map((name, i) => ({ id: name, label: name, color: colorForIndex(i), values: result.sites[name].profit_rate }))} />
              </div>
            </div>
          </div>

          {selected && (
            <div className="route-group" style={{ marginTop: 12 }}>
              <div className="route-group-head">
                <h3>Energy at one site</h3>
                <select value={activeSite} onChange={(e) => setSite(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
                  {siteNames.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </div>
              <div className="charts-grid">
                <div className="chart-card">
                  <div className="chart-title-row"><h3>Where the chargers' power comes from</h3><span className="mono muted">kW</span></div>
                  <div className="chart-area">
                    <LineSeriesChart x={result.time} xLabel="time (h)" yLabel="power"
                      series={[
                        { id: 'load', label: 'charger load', color: REFERENCE_INK, values: selected.load_kw },
                        { id: 'solar', label: 'solar direct', color: SOURCE_COLORS.solar, values: selected.solar_to_load_kw },
                        { id: 'battery', label: 'battery', color: SOURCE_COLORS.battery, values: selected.battery_to_load_kw },
                        { id: 'grid', label: 'grid direct', color: SOURCE_COLORS.grid, values: selected.grid_to_load_kw },
                      ]} />
                  </div>
                </div>
                <div className="chart-card">
                  <div className="chart-title-row"><h3>Solar output and battery charging</h3><span className="mono muted">kW</span></div>
                  <div className="chart-area">
                    <LineSeriesChart x={result.time} xLabel="time (h)" yLabel="power"
                      series={[
                        { id: 'available', label: 'solar available', color: SOURCE_COLORS.solar, values: selected.solar_available_kw },
                        { id: 'to_battery', label: 'solar to battery', color: SOURCE_COLORS.battery, values: selected.solar_to_battery_kw },
                        { id: 'grid_charge', label: 'grid to battery', color: SOURCE_COLORS.grid, values: selected.grid_to_battery_kw },
                      ]} />
                  </div>
                </div>
                {selected.has_storage && (
                  <div className="chart-card">
                    <div className="chart-title-row"><h3>Battery level</h3><span className="mono muted">% of capacity</span></div>
                    <div className="chart-area">
                      <LineSeriesChart x={result.time} xLabel="time (h)" yLabel="level (%)"
                        series={[{ id: 'soc', label: 'battery level', color: SOURCE_COLORS.battery, values: selected.soc.map((v) => 100 * v) }]} />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
