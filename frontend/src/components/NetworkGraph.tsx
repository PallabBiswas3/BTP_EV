import { useEffect, useMemo, useState } from 'react'
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react'

import type { NetworkConfig, TrajectoryBlock } from '../types'
import { computeLayout, stationNodePositions } from '../utils/layout'
import Sparkline from './Sparkline'

export type ViewMode = 'total' | 'ev' | 'nev' | 'latency'

interface Props {
  network: NetworkConfig
  trajectory: TrajectoryBlock | null
  timeIndex: number
  mode: ViewMode
  selectedStation: string | null
  onSelectStation: (name: string | null) => void
}

interface TooltipState {
  x: number
  y: number
  lines: string[]
  title: string
}

interface CleanEdgeData extends Record<string, unknown> {
  kind: 'road' | 'station'
  parallelOffset: number
  displayLabel?: string
  labelTone?: 'road' | 'shared' | 'private'
  road?: NetworkConfig['roads'][number]
  station?: NetworkConfig['stations'][number]
  rt?: TrajectoryBlock['roads'][string]
  st?: TrajectoryBlock['stations'][string]
  label?: string
}

const PRIVATE_STATION_COLOR = '#0e7f97'
const SHARED_STATION_COLOR = '#6250d6'
const STATION_PREFIX = 'station::'

function isSharedStation(name: string) {
  const normalized = name.toLowerCase()
  return normalized.includes('shared') || normalized.startsWith('ssh')
}

function stationColor(name: string) {
  return isSharedStation(name) ? SHARED_STATION_COLOR : PRIVATE_STATION_COLOR
}

function pairKey(u: string, v: string) {
  return u < v ? `${u}|${v}` : `${v}|${u}`
}

function CleanEdge({
  id, sourceX, sourceY, targetX, targetY, style, data, markerEnd,
}: EdgeProps) {
  const edgeData = data as CleanEdgeData | undefined
  const dx = targetX - sourceX
  const dy = targetY - sourceY
  const length = Math.hypot(dx, dy) || 1
  const offset = edgeData?.parallelOffset ?? 0
  const ox = (-dy / length) * offset
  const oy = (dx / length) * offset
  const controlX = (sourceX + targetX) / 2 + ox * 2
  const controlY = (sourceY + targetY) / 2 + oy * 2
  const labelX = (sourceX + targetX) / 2 + ox
  const labelY = (sourceY + targetY) / 2 + oy
  const path = `M ${sourceX},${sourceY} Q ${controlX},${controlY} ${targetX},${targetY}`

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={style}
        markerEnd={markerEnd}
        interactionWidth={18}
      />
      {edgeData?.displayLabel && (
        <EdgeLabelRenderer>
          <div
            className={`clean-edge-label ${edgeData.labelTone ?? ''}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            }}
          >
            {edgeData.displayLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const edgeTypes = { clean: CleanEdge }

function CleanNode({ data }: NodeProps) {
  const d = data as { label?: unknown; kind?: string; utilisation?: number; queued?: boolean }
  const label = String(d.label ?? '')
  return (
    <>
      {d.kind === 'station' ? (
        <>
          <span className="station-node-name">{label}</span>
          <div className={`station-node-meter${d.queued ? ' queued' : ''}`}>
            <span style={{ width: `${Math.round(100 * Math.min(d.utilisation ?? 0, 1))}%` }} />
          </div>
        </>
      ) : <span>{label}</span>}
      <Handle type="source" position={Position.Top} id="source-top" />
      <Handle type="source" position={Position.Right} id="source-right" />
      <Handle type="source" position={Position.Bottom} id="source-bottom" />
      <Handle type="source" position={Position.Left} id="source-left" />
      <Handle type="target" position={Position.Top} id="target-top" />
      <Handle type="target" position={Position.Right} id="target-right" />
      <Handle type="target" position={Position.Bottom} id="target-bottom" />
      <Handle type="target" position={Position.Left} id="target-left" />
    </>
  )
}

const nodeTypes = { clean: CleanNode }

interface StationCardProps {
  network: NetworkConfig
  trajectory: TrajectoryBlock | null
  timeIndex: number
  name: string
  x: number
  y: number
}

function StationCard({ network, trajectory, timeIndex, name, x, y }: StationCardProps) {
  const station = network.stations.find((item) => item.name === name)
  if (!station) return null
  const st = trajectory?.stations[name]
  const idx = trajectory ? Math.min(timeIndex, trajectory.time.length - 1) : -1
  const mu = station.mu_s ?? network.defaults.mu_s
  const rate = station.a_s ?? network.defaults.a_s
  const cost = station.c_s ?? network.defaults.c_s
  const K = st?.saturation_K ?? mu / rate
  const style = {
    position: 'fixed' as const,
    left: x + 18 + 312 > window.innerWidth ? x - 18 - 312 : x + 18,
    top: Math.max(8, Math.min(y - 60, window.innerHeight - 400)),
  }
  const color = stationColor(name)

  if (!st || idx < 0) {
    return (
      <div className="station-card-pop" style={style}>
        <div className="scp-head"><h3>{name}</h3><span>{station.u} → {station.v}</span></div>
        <div className="scp-tags"><span>{isSharedStation(name) ? 'Shared station' : 'Private station'}</span></div>
        <div className="scp-section">
          <div className="scp-stats">
            <div><small>Max service rate</small><b>{mu.toFixed(2)}</b><small>μ_s</small></div>
            <div><small>Saturates at</small><b>{K.toFixed(2)}</b><small>vehicles K_s</small></div>
            <div><small>Unit cost</small><b>{cost.toFixed(2)}</b><small>c_s</small></div>
          </div>
        </div>
        <div className="scp-row"><span>Run a simulation to see price, occupancy and profit here.</span></div>
      </div>
    )
  }

  const occupancy = st.occupancy[idx] ?? 0
  const queue = st.queue[idx] ?? 0
  // Scale the bar so the saturation point stays visible even with a long queue.
  const scale = Math.max(occupancy, K) * 1.15 || 1
  return (
    <div className="station-card-pop" style={style}>
      <div className="scp-head"><h3>{name}</h3><span>t = {trajectory!.time[idx].toFixed(1)}</span></div>
      <div className="scp-tags">
        <span>{isSharedStation(name) ? 'Shared station' : 'Private station'}</span>
        <span>{station.u} → {station.v}</span>
      </div>

      <div className="scp-section">
        <div className="scp-stats">
          <div><small>Price ψ</small><b>{(st.price[idx] ?? 0).toFixed(3)}</b><small>cost c_s {cost.toFixed(2)}</small></div>
          <div><small>Throughput ρ</small><b>{(st.throughput[idx] ?? 0).toFixed(3)}</b><small>max {mu.toFixed(2)}</small></div>
          <div><small>Profit π</small><b>{(st.profit[idx] ?? 0).toFixed(3)}</b><small>per time</small></div>
        </div>
      </div>

      <div className="scp-section">
        <div className="scp-label">Vehicles at the station</div>
        <div className="scp-gauge">
          <span style={{ width: `${(100 * occupancy) / scale}%`, background: queue > 0.005 ? 'var(--cong-2)' : color }} />
          <em style={{ left: `${(100 * K) / scale}%` }} />
        </div>
        <div className="scp-row">
          <b>{occupancy.toFixed(3)} vehicles</b>
          <span>dashed line: saturation K_s = {K.toFixed(2)}</span>
        </div>
        <div className="scp-row">
          {queue > 0.005
            ? <b style={{ color: 'var(--danger)' }}>Queue {queue.toFixed(3)} · wait {(st.waiting_time[idx] ?? 0).toFixed(3)}</b>
            : <span>No queue</span>}
        </div>
      </div>

      <div className="scp-section">
        <div className="scp-label">Price over the run</div>
        <Sparkline marker={idx} height={50} format={(v) => v.toFixed(3)}
          series={[{ label: 'ψ', color, values: st.price }]} />
      </div>
      <div className="scp-section">
        <div className="scp-label">Occupancy over the run</div>
        <Sparkline marker={idx} height={50} format={(v) => v.toFixed(2)}
          series={[{ label: 'x', color, values: st.occupancy }]} />
      </div>
    </div>
  )
}

export default function NetworkGraph({
  network,
  trajectory,
  timeIndex,
  mode,
  selectedStation,
  onSelectStation,
}: Props) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const [stationCard, setStationCard] = useState<{ name: string; x: number; y: number } | null>(null)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null)
  const activeNodeId = focusedNodeId ?? hoveredNodeId
  const layout = useMemo(() => computeLayout(network), [network])
  const stationPositions = useMemo(
    () => stationNodePositions(layout, network.stations, network.roads),
    [layout, network.stations, network.roads],
  )

  // A newly loaded scenario may not contain the previously hovered/selected
  // node. Clear transient graph UI so stale focus cannot fade the new graph.
  useEffect(() => {
    setTooltip(null)
    setStationCard(null)
    setHoveredEdgeId(null)
    setHoveredNodeId(null)
    setFocusedNodeId(null)
  }, [network])

  const nodes: Node[] = useMemo(() => {
    const focusNeighbourhood = new Set<string>()
    if (focusedNodeId) {
      focusNeighbourhood.add(focusedNodeId)
      network.roads.forEach((road) => {
        if (road.u === focusedNodeId || road.v === focusedNodeId) {
          focusNeighbourhood.add(road.u)
          focusNeighbourhood.add(road.v)
        }
      })
      network.stations.forEach((station) => {
        if (station.u === focusedNodeId || station.v === focusedNodeId) {
          focusNeighbourhood.add(station.u)
          focusNeighbourhood.add(station.v)
        }
      })
    }

    const idx = trajectory ? Math.min(timeIndex, trajectory.time.length - 1) : -1
    const stationNodes: Node[] = network.stations.flatMap((station) => {
      const pos = stationPositions.get(station.name)
      if (!pos) return []
      const st = trajectory?.stations[station.name]
      const occupancy = st && idx >= 0 ? st.occupancy[idx] : 0
      const shared = isSharedStation(station.name)
      const dimmed = focusedNodeId && station.u !== focusedNodeId && station.v !== focusedNodeId
      return [{
        id: `${STATION_PREFIX}${station.name}`,
        type: 'clean',
        // Junction nodes are 42px and station nodes 62x50; centre both on their layout point.
        position: { x: pos.x - 10, y: pos.y - 4 },
        data: {
          label: station.name, kind: 'station',
          utilisation: st ? occupancy / (st.saturation_K || 1) : 0,
          queued: Boolean(st && idx >= 0 && st.queue[idx] > 0.005),
        },
        className: `station-node ${shared ? 'shared-station' : 'private-station'}${selectedStation === station.name ? ' selected-station' : ''}${dimmed ? ' dimmed-node' : ''}`,
        draggable: false,
      }]
    })

    const junctionNodes: Node[] = [...layout.entries()].map(([id, pos]) => {
      const isOrigin = network.ods.some((od) => od.origin === id)
      const isDestination = network.ods.some((od) => od.dest === id)
      const roleClass = isOrigin
        ? 'origin-node'
        : isDestination
          ? 'destination-node'
          : 'junction-node'
      return {
        id,
        type: 'clean',
        position: { x: pos.x, y: pos.y },
        data: { label: id },
        className: `${roleClass}${focusedNodeId === id ? ' focused-node' : focusedNodeId && !focusNeighbourhood.has(id) ? ' dimmed-node' : ''}`,
        draggable: false,
      }
    })
    return [...junctionNodes, ...stationNodes]
  }, [layout, stationPositions, network.ods, network.roads, network.stations, focusedNodeId, trajectory, timeIndex, selectedStation])

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = []
    const idx = trajectory ? Math.min(timeIndex, trajectory.time.length - 1) : -1
    const roadCounts = new Map<string, number>()
    const roadSeen = new Map<string, number>()
    network.roads.forEach((road) => {
      const key = pairKey(road.u, road.v)
      roadCounts.set(key, (roadCounts.get(key) ?? 0) + 1)
    })
    const stationSeen = new Map<string, number>()
    const point = (id: string) => (id.startsWith(STATION_PREFIX)
      ? stationPositions.get(id.slice(STATION_PREFIX.length)) : layout.get(id))
    const handles = (u: string, v: string) => {
      const source = point(u)
      const target = point(v)
      if (!source || !target) return {}
      const dx = target.x - source.x
      const dy = target.y - source.y
      if (Math.abs(dx) >= Math.abs(dy)) {
        return dx >= 0
          ? { sourceHandle: 'source-right', targetHandle: 'target-left' }
          : { sourceHandle: 'source-left', targetHandle: 'target-right' }
      }
      return dy >= 0
        ? { sourceHandle: 'source-bottom', targetHandle: 'target-top' }
        : { sourceHandle: 'source-top', targetHandle: 'target-bottom' }
    }

    network.roads.forEach((road, i) => {
      const label = `${road.u}->${road.v}`
      const edgeId = `road:${i}:${label}`
      const rt = trajectory?.roads[label]
      const isNevOnly = Boolean(road.classes && !road.classes.includes('EV'))
      let intensity = 0
      const xValue = rt && idx >= 0 ? (rt.total_density[idx] ?? 0) : 0

      if (rt && idx >= 0) {
        if (mode === 'ev') {
          intensity = Math.min(1, (rt.ev_density[idx] ?? 0) / (rt.capacity_L || 1))
        } else if (mode === 'nev') {
          intensity = Math.min(1, (rt.nev_density[idx] ?? 0) / (rt.capacity_L || 1))
        } else if (mode === 'latency') {
          intensity = Math.min(1, (rt.latency[idx] ?? 0) / 2)
        } else {
          intensity = Math.min(1, rt.capacity_ratio[idx] ?? 0)
        }
      }

      const key = pairKey(road.u, road.v)
      const seen = roadSeen.get(key) ?? 0
      const count = roadCounts.get(key) ?? 1
      roadSeen.set(key, seen + 1)
      // Hovering a station shows its card; it should not fade the rest of the network.
      const connectedToFocus = !activeNodeId || activeNodeId.startsWith(STATION_PREFIX)
        || road.u === activeNodeId || road.v === activeNodeId
      const hasVisibleFlow = Boolean(rt && idx >= 0 && xValue > 0.005)
      const showLabel = hoveredEdgeId === edgeId || hasVisibleFlow

      out.push({
        id: edgeId,
        source: road.u,
        target: road.v,
        ...handles(road.u, road.v),
        type: 'clean',
        className: isNevOnly ? 'nev-edge' : 'road-edge',
        animated: intensity > 0.72,
        style: {
          stroke: isNevOnly ? '#eb6834' : '#6f6c66',
          strokeWidth: 1.35 + intensity * 4.5,
          opacity: connectedToFocus ? (hasVisibleFlow ? 0.62 + intensity * 0.38 : 0.28) : 0.07,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isNevOnly ? '#eb6834' : '#55524c',
          width: 12 + intensity * 9,
          height: 12 + intensity * 9,
        },
        data: {
          kind: 'road',
          label,
          road,
          rt,
          displayLabel: showLabel ? `x ${xValue.toFixed(2)}` : undefined,
          labelTone: 'road',
          parallelOffset: (seen - (count - 1) / 2) * 14,
        } satisfies CleanEdgeData,
      })
    })

    network.stations.forEach((station, i) => {
      const nodeId = `${STATION_PREFIX}${station.name}`
      const st = trajectory?.stations[station.name]
      const throughput = st && idx >= 0 ? (st.throughput[idx] ?? 0) : 0
      const color = stationColor(station.name)
      const connectedToFocus = !activeNodeId || activeNodeId.startsWith(STATION_PREFIX)
        || station.u === activeNodeId || station.v === activeNodeId
      const selected = selectedStation === station.name
      const shared = {
        type: 'clean',
        className: 'station-edge',
        style: { stroke: color, strokeWidth: selected ? 3.2 : 2.2, opacity: connectedToFocus ? 0.95 : 0.1 },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 13, height: 13 },
        data: { kind: 'station', station, st, parallelOffset: 0 } satisfies CleanEdgeData,
      }
      out.push({ id: `station:${i}:in`, source: station.u, target: nodeId, ...handles(station.u, nodeId), ...shared, animated: throughput > 0.005 })
      out.push({ id: `station:${i}:out`, source: nodeId, target: station.v, ...handles(nodeId, station.v), ...shared })
    })

    return out
  }, [network, trajectory, timeIndex, mode, selectedStation, layout, stationPositions, hoveredEdgeId, activeNodeId])

  const showTooltip = (event: React.MouseEvent, edge: Edge) => {
    setHoveredEdgeId(edge.id)
    const rect = (event.target as HTMLElement)
      .closest('.network-shell')
      ?.getBoundingClientRect()
    const x = rect ? event.clientX - rect.left + 12 : event.clientX
    const y = rect ? event.clientY - rect.top + 12 : event.clientY
    const data = edge.data as CleanEdgeData | undefined
    const idx = trajectory ? Math.min(timeIndex, trajectory.time.length - 1) : -1

    if (data?.kind === 'road' && data.road) {
      const road = data.road
      const rt = data.rt
      const lines = [
        `${road.u} → ${road.v}`,
        `classes: ${(road.classes ?? network.classes).join(', ')}`,
        `capacity L: ${(road.L ?? network.defaults.L).toFixed(2)}`,
      ]
      if (rt && idx >= 0) {
        lines.push(
          `EV density: ${(rt.ev_density[idx] ?? 0).toFixed(3)}`,
          `NEV density: ${(rt.nev_density[idx] ?? 0).toFixed(3)}`,
          `latency φ: ${(rt.latency[idx] ?? 0).toFixed(3)}`,
          `x/L: ${(rt.capacity_ratio[idx] ?? 0).toFixed(2)}`,
        )
      }
      setTooltip({ x, y, title: `Road ${data.label}`, lines })
    } else {
      setTooltip(null)
    }
  }

  const showNodeTooltip = (event: React.MouseEvent, node: Node) => {
    setHoveredNodeId(node.id)
    if (node.id.startsWith(STATION_PREFIX)) {
      setTooltip(null)
      setStationCard({ name: node.id.slice(STATION_PREFIX.length), x: event.clientX, y: event.clientY })
      return
    }
    setStationCard(null)
    const rect = (event.target as HTMLElement)
      .closest('.network-shell')
      ?.getBoundingClientRect()
    const x = rect ? event.clientX - rect.left + 12 : event.clientX
    const y = rect ? event.clientY - rect.top + 12 : event.clientY
    const originOds = network.ods.filter((od) => od.origin === node.id).map((od) => od.name)
    const destinationOds = network.ods.filter((od) => od.dest === node.id).map((od) => od.name)
    const outgoing = [...new Set(network.roads.filter((road) => road.u === node.id).map((road) => road.v))]
    const incoming = [...new Set(network.roads.filter((road) => road.v === node.id).map((road) => road.u))]
    const stations = network.stations.filter((station) => station.u === node.id || station.v === node.id)
    const role = [
      originOds.length > 0 ? `origin (${originOds.join(', ')})` : '',
      destinationOds.length > 0 ? `destination (${destinationOds.join(', ')})` : '',
    ].filter(Boolean).join(' · ') || 'junction'
    const summarize = (values: string[]) => values.length > 6
      ? `${values.slice(0, 6).join(', ')}, +${values.length - 6} more`
      : values.join(', ')
    const lines = [
      `role: ${role}`,
      `roads: ${incoming.length} incoming · ${outgoing.length} outgoing`,
    ]
    if (outgoing.length > 0) lines.push(`to: ${summarize(outgoing)}`)
    if (incoming.length > 0) lines.push(`from: ${summarize(incoming)}`)
    if (stations.length > 0) lines.push(`stations: ${summarize(stations.map((station) => station.name))}`)
    setTooltip({ x, y, title: `Node ${node.id}`, lines })
  }

  return (
    <div className="network-shell">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.25}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        onEdgeMouseEnter={showTooltip}
        onEdgeMouseMove={showTooltip}
        onEdgeMouseLeave={() => {
          setTooltip(null)
          setHoveredEdgeId(null)
        }}
        onNodeMouseEnter={showNodeTooltip}
        onNodeMouseMove={showNodeTooltip}
        onNodeMouseLeave={() => {
          setTooltip(null)
          setStationCard(null)
          setHoveredNodeId(null)
        }}
        onNodeClick={(_, node) => {
          if (node.id.startsWith(STATION_PREFIX)) {
            const name = node.id.slice(STATION_PREFIX.length)
            onSelectStation(name === selectedStation ? null : name)
          } else {
            setFocusedNodeId(node.id === focusedNodeId ? null : node.id)
          }
        }}
        onPaneClick={() => {
          setFocusedNodeId(null)
          setHoveredNodeId(null)
        }}
      >
        <Background gap={24} size={0.7} color="#e7e4dc" />
        <Controls showInteractive={false} />
      </ReactFlow>

      <div className="network-hint">Hover a station for its details · Click a station to select it, a junction to focus</div>

      {stationCard && <StationCard network={network} trajectory={trajectory} timeIndex={timeIndex} {...stationCard} />}

      {tooltip && (
        <div className="graph-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <b>{tooltip.title}</b>
          {tooltip.lines.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}
    </div>
  )
}
