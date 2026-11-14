import { useEffect, useMemo, useState } from 'react'
import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow,
  type Edge, type Node, type NodeProps,
} from '@xyflow/react'

import type { EnergyResult, NetworkConfig } from '../types'
import { computeLayout, stationNodePositions } from '../utils/layout'
import Sparkline from './Sparkline'

// Validated as a categorical set on the white card surface (colour-blind separation included).
export const SOURCE_COLORS = { solar: '#eda100', battery: '#1baf7a', grid: '#2a78d6' }
const MODE_COLORS = ['#2a78d6', '#eb6834', '#6250d6', '#008300']

interface ScenarioSite {
  name: string
  u: string
  v: string
  strategic?: boolean
  solar?: { peak_kw?: number }
  battery?: { capacity_kwh?: number; soc_min?: number; soc_max?: number }
}

interface ScenarioShape {
  roads: { u: string; v: string; classes?: string[] }[]
  sites: ScenarioSite[]
  ods: { name: string; origin: string; dest: string }[]
}

interface Props {
  result: EnergyResult
  selectedSite: string
  onSelectSite: (name: string) => void
  index: number
  onIndexChange: (index: number) => void
}

interface SiteNodeData extends Record<string, unknown> {
  label: string
  kind: 'junction' | 'site'
  utilisation?: number
  queued?: boolean
  solar?: boolean
  storage?: boolean
}

const HANDLES: [Position, string][] = [
  [Position.Top, 'top'], [Position.Right, 'right'], [Position.Bottom, 'bottom'], [Position.Left, 'left'],
]

function GraphNode({ data }: NodeProps) {
  const d = data as SiteNodeData
  return (
    <>
      {d.kind === 'site' ? (
        <>
          <span className="station-node-name">{d.label}</span>
          <div className={`station-node-meter${d.queued ? ' queued' : ''}`}>
            <span style={{ width: `${Math.round(100 * (d.utilisation ?? 0))}%` }} />
          </div>
          <div className="station-node-badges">
            {d.solar && <i style={{ background: SOURCE_COLORS.solar }} title="Solar">S</i>}
            {d.storage && <i style={{ background: SOURCE_COLORS.battery }} title="Battery">B</i>}
          </div>
        </>
      ) : <span>{d.label}</span>}
      {HANDLES.map(([position, id]) => (
        <span key={id}>
          <Handle type="source" position={position} id={`source-${id}`} />
          <Handle type="target" position={position} id={`target-${id}`} />
        </span>
      ))}
    </>
  )
}

const nodeTypes = { graph: GraphNode }

export function formatClock(t: number, dayLength = 24) {
  const day = Math.floor(t / dayLength + 1e-9) + 1
  const hours = t - (day - 1) * dayLength
  const hh = Math.floor(hours + 1e-9)
  const mm = Math.round((hours - hh) * 60)
  return `Day ${day}, ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function SiteCard({ result, name, index, config }: { result: EnergyResult; name: string; index: number; config?: ScenarioSite }) {
  const site = result.sites[name]
  const currency = result.units.currency
  const stepsPerDay = Number(result.settings.steps_per_day) || 48
  const from = Math.max(0, index - stepsPerDay + 1)
  const load = site.load_kw[index]
  const sources = [
    { key: 'solar', label: 'Solar', value: site.solar_to_load_kw[index], color: SOURCE_COLORS.solar },
    { key: 'battery', label: 'Battery', value: site.battery_to_load_kw[index], color: SOURCE_COLORS.battery },
    { key: 'grid', label: 'Grid', value: site.grid_to_load_kw[index], color: SOURCE_COLORS.grid },
  ]
  const charging = site.solar_to_battery_kw[index] + site.grid_to_battery_kw[index]
  const discharging = site.battery_to_load_kw[index]
  const batteryStatus = discharging > 0.05
    ? `Discharging ${discharging.toFixed(0)} kW to chargers`
    : charging > 0.05
      ? `Charging ${charging.toFixed(0)} kW (${site.solar_to_battery_kw[index].toFixed(0)} solar, ${site.grid_to_battery_kw[index].toFixed(0)} grid)`
      : 'Idle'
  const socMin = config?.battery?.soc_min ?? 0.1
  const socMax = config?.battery?.soc_max ?? 0.9

  return (
    <>
      <div className="scp-head"><h3>{name}</h3><span>{formatClock(result.time[index])}</span></div>
      <div className="scp-tags">
        {site.has_solar && <span>Solar {site.solar_peak_kw.toFixed(0)} kW</span>}
        {site.has_storage && <span>Battery {site.battery_capacity_kwh.toFixed(0)} kWh</span>}
        {!site.has_solar && !site.has_storage && <span>Grid only</span>}
        <span>{site.strategic ? 'Sets its own prices' : 'Fixed price'}</span>
      </div>

      <div className="scp-section">
        <div className="scp-label">Chargers</div>
        {site.chargers.map((edge) => {
          const c = result.chargers[edge]
          const occupancy = c.occupancy[index]
          const waiting = c.queue[index]
          const free = Math.max(c.count - occupancy, 0)
          return (
            <div className="scp-charger" key={edge}>
              <div>
                <b style={{ textTransform: 'capitalize' }}>{c.mode}</b>{' '}
                <small>{c.count} × {c.power_kw.toFixed(0)} kW · {c.arrivals[index].toFixed(1)} arrivals/h</small>
              </div>
              <div className="scp-price">{c.price[index].toFixed(0)}<small>{currency}/vehicle</small></div>
              <div className="scp-slots">
                {Array.from({ length: c.count }, (_, i) => (
                  <div className="scp-slot" key={i}>
                    <span style={{ width: `${100 * Math.min(Math.max(occupancy - i, 0), 1)}%` }} />
                  </div>
                ))}
                {waiting > 0.05
                  ? <span className="scp-wait">+{waiting.toFixed(1)} waiting</span>
                  : <span className="scp-free">{free.toFixed(1)} free</span>}
              </div>
            </div>
          )
        })}
      </div>

      <div className="scp-section">
        <div className="scp-label">Power to vehicles now · {load.toFixed(0)} kW</div>
        {load > 0.05 ? (
          <div className="scp-stack">
            {sources.filter((s) => s.value > 0.005 * load).map((s) => (
              <span key={s.key} style={{ flex: s.value, background: s.color }} />
            ))}
          </div>
        ) : <div className="scp-stack empty" />}
        <div className="scp-legend">
          {sources.map((s) => (
            <div key={s.key}>
              <small><i style={{ background: s.color }} />{s.label}</small>
              <b>{s.value.toFixed(0)} kW</b>
              <small>{load > 0.05 ? `${Math.round((100 * s.value) / load)}%` : '—'}</small>
            </div>
          ))}
        </div>
      </div>

      {site.has_storage && (
        <div className="scp-section">
          <div className="scp-label">Battery</div>
          <div className="scp-gauge">
            <span style={{ width: `${100 * site.soc[index]}%`, background: SOURCE_COLORS.battery }} />
            <em style={{ left: `${100 * socMin}%` }} /><em style={{ left: `${100 * socMax}%` }} />
          </div>
          <div className="scp-row">
            <b>{Math.round(100 * site.soc[index])}% · {site.stored_kwh[index].toFixed(0)} kWh</b>
            <span>allowed {Math.round(100 * socMin)}–{Math.round(100 * socMax)}%</span>
          </div>
          <div className="scp-row"><span>{batteryStatus}</span></div>
        </div>
      )}

      {site.has_solar && (
        <div className="scp-section">
          <div className="scp-label">Solar output</div>
          <div className="scp-gauge">
            <span style={{ width: `${(100 * site.solar_available_kw[index]) / (site.solar_peak_kw || 1)}%`, background: SOURCE_COLORS.solar }} />
          </div>
          <div className="scp-row">
            <b>{site.solar_available_kw[index].toFixed(0)} of {site.solar_peak_kw.toFixed(0)} kW</b>
            <span>{site.solar_to_battery_kw[index].toFixed(0)} to battery · {site.solar_curtailed_kw[index].toFixed(0)} unused</span>
          </div>
        </div>
      )}

      <div className="scp-section">
        <div className="scp-stats">
          <div><small>Grid tariff</small><b>{result.tariff[index].toFixed(1)}</b><small>{currency}/kWh</small></div>
          <div><small>Next kWh costs</small><b>{site.marginal_cost[index].toFixed(1)}</b><small>{currency}/kWh</small></div>
          <div><small>Profit rate</small><b>{Math.round(site.profit_rate[index]).toLocaleString()}</b><small>{currency}/h</small></div>
        </div>
      </div>

      <div className="scp-section">
        <div className="scp-label">Prices, last 24 h</div>
        <Sparkline marker={index - from} height={50}
          series={site.chargers.map((edge, i) => ({
            label: result.chargers[edge].mode, color: MODE_COLORS[i % MODE_COLORS.length],
            values: result.chargers[edge].price.slice(from, index + 1),
          }))} />
      </div>
    </>
  )
}

export default function EnergyNetwork({ result, selectedSite, onSelectSite, index, onIndexChange }: Props) {
  const scenario = result.scenario as unknown as ScenarioShape
  const last = result.time.length - 1
  const [playing, setPlaying] = useState(false)
  const [hover, setHover] = useState<{ name: string; x: number; y: number } | null>(null)

  useEffect(() => { setPlaying(false); setHover(null) }, [result])
  useEffect(() => {
    if (!playing) return undefined
    if (index >= last) { setPlaying(false); return undefined }
    const timer = window.setTimeout(() => onIndexChange(index + 1), 450)
    return () => window.clearTimeout(timer)
  }, [playing, index, last, onIndexChange])

  const positions = useMemo(() => {
    const stations = scenario.sites.map((s) => ({ name: s.name, u: s.u, v: s.v }))
    const layout = computeLayout({ roads: scenario.roads, stations, ods: scenario.ods } as unknown as NetworkConfig)
    return { layout, sites: stationNodePositions(layout, stations, scenario.roads, 78) }
  }, [scenario])

  const idx = Math.min(index, last)
  const nodes: Node[] = useMemo(() => {
    const out: Node[] = [...positions.layout.entries()].map(([id, pos]) => ({
      id, type: 'graph', position: { x: pos.x, y: pos.y }, draggable: false,
      data: { label: id, kind: 'junction' } satisfies SiteNodeData,
      className: scenario.ods.some((od) => od.origin === id) ? 'origin-node'
        : scenario.ods.some((od) => od.dest === id) ? 'destination-node' : 'junction-node',
    }))
    scenario.sites.forEach((config) => {
      const pos = positions.sites.get(config.name)
      const site = result.sites[config.name]
      if (!pos || !site) return
      const chargers = site.chargers.map((edge) => result.chargers[edge])
      const total = chargers.reduce((sum, c) => sum + c.count, 0)
      const busy = chargers.reduce((sum, c) => sum + Math.min(c.occupancy[idx], c.count), 0)
      out.push({
        id: `site::${config.name}`, type: 'graph', draggable: false,
        position: { x: pos.x - 10, y: pos.y - 4 },
        className: `station-node${site.strategic ? '' : ' fixed-price'}${selectedSite === config.name ? ' selected-station' : ''}`,
        data: {
          label: config.name, kind: 'site', utilisation: total > 0 ? busy / total : 0,
          queued: chargers.some((c) => c.queue[idx] > 0.05), solar: site.has_solar, storage: site.has_storage,
        } satisfies SiteNodeData,
      })
    })
    return out
  }, [positions, scenario, result, idx, selectedSite])

  const edges: Edge[] = useMemo(() => {
    const point = (id: string) => (id.startsWith('site::') ? positions.sites.get(id.slice(6)) : positions.layout.get(id))
    const handles = (u: string, v: string) => {
      const a = point(u)
      const b = point(v)
      if (!a || !b) return {}
      const dx = b.x - a.x
      const dy = b.y - a.y
      if (Math.abs(dx) >= Math.abs(dy)) {
        return dx >= 0 ? { sourceHandle: 'source-right', targetHandle: 'target-left' }
          : { sourceHandle: 'source-left', targetHandle: 'target-right' }
      }
      return dy >= 0 ? { sourceHandle: 'source-bottom', targetHandle: 'target-top' }
        : { sourceHandle: 'source-top', targetHandle: 'target-bottom' }
    }
    const out: Edge[] = scenario.roads.map((road, i) => {
      const nevOnly = Boolean(road.classes && !road.classes.includes('EV'))
      return {
        id: `road:${i}`, source: road.u, target: road.v, ...handles(road.u, road.v), type: 'straight',
        className: nevOnly ? 'nev-edge' : 'road-edge',
        style: { stroke: nevOnly ? '#eb6834' : '#6f6c66', strokeWidth: 1.8, opacity: 0.85 },
        markerEnd: { type: MarkerType.ArrowClosed, color: nevOnly ? '#eb6834' : '#55524c', width: 14, height: 14 },
      }
    })
    scenario.sites.forEach((config) => {
      const site = result.sites[config.name]
      if (!site) return
      const arrivals = site.chargers.reduce((sum, edge) => sum + result.chargers[edge].arrivals[idx], 0)
      const width = 1.6 + Math.min(arrivals, 12) * 0.3
      const id = `site::${config.name}`
      const style = { stroke: '#2a5f5b', strokeWidth: width, opacity: 0.9 }
      const marker = { type: MarkerType.ArrowClosed, color: '#2a5f5b', width: 13, height: 13 }
      out.push({ id: `${id}:in`, source: config.u, target: id, ...handles(config.u, id), type: 'straight', style, markerEnd: marker, animated: arrivals > 0.5 })
      out.push({ id: `${id}:out`, source: id, target: config.v, ...handles(id, config.v), type: 'straight', style, markerEnd: marker })
    })
    return out
  }, [positions, scenario, result, idx])

  const track = (event: React.MouseEvent, node: Node) => {
    if (!node.id.startsWith('site::')) { setHover(null); return }
    setHover({ name: node.id.slice(6), x: event.clientX, y: event.clientY })
  }

  const cardStyle = hover ? {
    position: 'fixed' as const,
    left: hover.x + 18 + 312 > window.innerWidth ? hover.x - 18 - 312 : hover.x + 18,
    top: Math.max(8, Math.min(hover.y - 60, window.innerHeight - 640)),
  } : undefined

  return (
    <div>
      <div className="network-shell energy-network-shell">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.14 }}
          minZoom={0.25} maxZoom={2} proOptions={{ hideAttribution: true }} nodesConnectable={false}
          onNodeMouseEnter={track} onNodeMouseMove={track} onNodeMouseLeave={() => setHover(null)}
          onNodeClick={(_, node) => { if (node.id.startsWith('site::')) onSelectSite(node.id.slice(6)) }}>
          <Background gap={24} size={0.7} color="#e7e4dc" />
          <Controls showInteractive={false} />
        </ReactFlow>
        <div className="network-hint">Hover a station for its details · Click to chart it below</div>
      </div>

      <div className="time-row">
        <button onClick={() => { if (idx >= last) onIndexChange(0); setPlaying((p) => !p) }}>{playing ? 'Pause' : 'Play'}</button>
        <input type="range" min={0} max={last} value={idx} aria-label="Time"
               onChange={(e) => { setPlaying(false); onIndexChange(Number(e.target.value)) }} />
        <strong>{formatClock(result.time[idx])}</strong>
      </div>

      <div className="legend" style={{ marginTop: 8 }}>
        <span><i className="legend-origin" /> Origin</span>
        <span><i className="legend-destination" /> Destination</span>
        <span><i className="legend-road" /> Road</span>
        <span><i className="legend-station" /> Station (bar: chargers in use)</span>
        <span><i className="legend-station fixed" /> Fixed-price station</span>
        <span><i className="legend-dot" style={{ background: SOURCE_COLORS.solar }} /> S: has solar</span>
        <span><i className="legend-dot" style={{ background: SOURCE_COLORS.battery }} /> B: has battery</span>
      </div>

      {hover && result.sites[hover.name] && (
        <div className="station-card-pop" style={cardStyle}>
          <SiteCard result={result} name={hover.name} index={idx}
                    config={scenario.sites.find((s) => s.name === hover.name)} />
        </div>
      )}
    </div>
  )
}
