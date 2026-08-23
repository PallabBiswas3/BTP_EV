import { useMemo, useState } from 'react'
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
import { computeLayout } from '../utils/layout'

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

const PRIVATE_STATION_COLOR = '#06b6d4'
const SHARED_STATION_COLOR = '#a855f7'

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
  const sx = sourceX + ox
  const sy = sourceY + oy
  const tx = targetX + ox
  const ty = targetY + oy
  const path = `M ${sx},${sy} L ${tx},${ty}`

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
              transform: `translate(-50%, -50%) translate(${(sx + tx) / 2}px,${(sy + ty) / 2}px)`,
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
  const label = String((data as { label?: unknown }).label ?? '')
  return (
    <>
      <span>{label}</span>
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

export default function NetworkGraph({
  network,
  trajectory,
  timeIndex,
  mode,
  selectedStation,
  onSelectStation,
}: Props) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const layout = useMemo(() => computeLayout(network), [network])

  const nodes: Node[] = useMemo(() => (
    [...layout.entries()].map(([id, pos]) => {
      const isOrigin = network.ods.some((od) => od.origin === id)
      const isDestination = network.ods.some((od) => od.dest === id)
      return {
        id,
        type: 'clean',
        position: { x: pos.x, y: pos.y },
        data: { label: id },
        className: isOrigin
          ? 'origin-node'
          : isDestination
            ? 'destination-node'
            : 'junction-node',
        draggable: false,
      }
    })
  ), [layout, network.ods])

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
    const handles = (u: string, v: string) => {
      const source = layout.get(u)
      const target = layout.get(v)
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

      out.push({
        id: `road:${i}:${label}`,
        source: road.u,
        target: road.v,
        ...handles(road.u, road.v),
        type: 'clean',
        className: isNevOnly ? 'nev-edge' : 'road-edge',
        animated: intensity > 0.72,
        style: {
          stroke: isNevOnly ? '#9c8256' : '#8b8b87',
          strokeWidth: 1.35 + intensity * 4.5,
          opacity: 0.72 + intensity * 0.28,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isNevOnly ? '#9c8256' : '#686864',
          width: 12 + intensity * 9,
          height: 12 + intensity * 9,
        },
        data: {
          kind: 'road',
          label,
          road,
          rt,
          displayLabel: `x ${xValue.toFixed(2)}`,
          labelTone: 'road',
          parallelOffset: (seen - (count - 1) / 2) * 7,
        } satisfies CleanEdgeData,
      })
    })

    network.stations.forEach((station, i) => {
      const st = trajectory?.stations[station.name]
      const occupancy = st && idx >= 0 ? st.occupancy[idx] : undefined
      const saturation = st?.saturation_K
      const intensity = occupancy !== undefined && saturation
        ? Math.min(1, occupancy / saturation)
        : 0
      const key = pairKey(station.u, station.v)
      const stationIndex = stationSeen.get(key) ?? 0
      stationSeen.set(key, stationIndex + 1)
      const roadCount = roadCounts.get(key) ?? 0
      const selected = selectedStation === station.name
      const color = stationColor(station.name)

      out.push({
        id: `station:${i}:${station.name}`,
        source: station.u,
        target: station.v,
        ...handles(station.u, station.v),
        type: 'clean',
        className: `station-edge ${isSharedStation(station.name) ? 'shared-station-edge' : 'private-station-edge'}${selected ? ' selected-edge' : ''}`,
        animated: intensity > 0.8,
        style: {
          stroke: color,
          strokeWidth: (selected ? 4.5 : 2.8) + intensity * 2.4,
          opacity: 1,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 14 + intensity * 9,
          height: 14 + intensity * 9,
        },
        data: {
          kind: 'station',
          station,
          st,
          displayLabel: `${station.name} · x ${(occupancy ?? 0).toFixed(2)}`,
          labelTone: isSharedStation(station.name) ? 'shared' : 'private',
          parallelOffset: (roadCount > 0 ? 11 : 0) + stationIndex * 8,
        } satisfies CleanEdgeData,
      })
    })

    return out
  }, [network, trajectory, timeIndex, mode, selectedStation, layout])

  const showTooltip = (event: React.MouseEvent, edge: Edge) => {
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
    } else if (data?.kind === 'station' && data.station) {
      const station = data.station
      const st = data.st
      const lines = [`link: ${station.u} → ${station.v}`]
      if (st && idx >= 0) {
        lines.push(
          `price ψ: ${(st.price[idx] ?? 0).toFixed(3)}`,
          `occupancy: ${(st.occupancy[idx] ?? 0).toFixed(3)} (K=${st.saturation_K.toFixed(2)})`,
          `queue: ${(st.queue[idx] ?? 0).toFixed(3)}`,
          `throughput ρ: ${(st.throughput[idx] ?? 0).toFixed(3)}`,
        )
      }
      setTooltip({ x, y, title: `Station ${station.name}`, lines })
    }
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
        onEdgeMouseLeave={() => setTooltip(null)}
        onEdgeClick={(_, edge) => {
          const data = edge.data as CleanEdgeData | undefined
          if (data?.kind === 'station' && data.station) {
            onSelectStation(data.station.name === selectedStation ? null : data.station.name)
          }
        }}
      >
        <Background gap={24} size={0.7} color="#e7e4dc" />
        <Controls showInteractive={false} />
      </ReactFlow>

      {tooltip && (
        <div className="graph-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <b>{tooltip.title}</b>
          {tooltip.lines.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}
    </div>
  )
}
