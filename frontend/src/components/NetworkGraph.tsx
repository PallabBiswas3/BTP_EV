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
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null)
  const activeNodeId = focusedNodeId ?? hoveredNodeId
  const layout = useMemo(() => computeLayout(network), [network])

  // A newly loaded scenario may not contain the previously hovered/selected
  // node. Clear transient graph UI so stale focus cannot fade the new graph.
  useEffect(() => {
    setTooltip(null)
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

    return [...layout.entries()].map(([id, pos]) => {
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
  }, [layout, network.ods, network.roads, network.stations, focusedNodeId])

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
      const connectedToFocus = !activeNodeId || road.u === activeNodeId || road.v === activeNodeId
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
          stroke: isNevOnly ? '#9c8256' : '#8b8b87',
          strokeWidth: 1.35 + intensity * 4.5,
          opacity: connectedToFocus ? (hasVisibleFlow ? 0.62 + intensity * 0.38 : 0.28) : 0.07,
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
          displayLabel: showLabel ? `x ${xValue.toFixed(2)}` : undefined,
          labelTone: 'road',
          parallelOffset: (seen - (count - 1) / 2) * 14,
        } satisfies CleanEdgeData,
      })
    })

    network.stations.forEach((station, i) => {
      const edgeId = `station:${i}:${station.name}`
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
      const connectedToFocus = !activeNodeId || station.u === activeNodeId || station.v === activeNodeId
      const showValue = selected || hoveredEdgeId === edgeId || intensity > 0.02

      out.push({
        id: edgeId,
        source: station.u,
        target: station.v,
        ...handles(station.u, station.v),
        type: 'clean',
        className: `station-edge ${isSharedStation(station.name) ? 'shared-station-edge' : 'private-station-edge'}${selected ? ' selected-edge' : ''}`,
        animated: intensity > 0.8,
        style: {
          stroke: color,
          strokeWidth: (selected ? 4.5 : 2.8) + intensity * 2.4,
          opacity: connectedToFocus ? 1 : 0.1,
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
          displayLabel: showValue ? `${station.name} · x ${(occupancy ?? 0).toFixed(2)}` : station.name,
          labelTone: isSharedStation(station.name) ? 'shared' : 'private',
          parallelOffset: (roadCount > 0 ? 11 : 0) + stationIndex * 8,
        } satisfies CleanEdgeData,
      })
    })

    return out
  }, [network, trajectory, timeIndex, mode, selectedStation, layout, hoveredEdgeId, activeNodeId])

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

  const showNodeTooltip = (event: React.MouseEvent, node: Node) => {
    setHoveredNodeId(node.id)
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
          setHoveredNodeId(null)
        }}
        onNodeClick={(_, node) => setFocusedNodeId(node.id === focusedNodeId ? null : node.id)}
        onPaneClick={() => {
          setFocusedNodeId(null)
          setHoveredNodeId(null)
        }}
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

      <div className="network-hint">Hover for details · Click a node to lock focus</div>

      {tooltip && (
        <div className="graph-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <b>{tooltip.title}</b>
          {tooltip.lines.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}
    </div>
  )
}
