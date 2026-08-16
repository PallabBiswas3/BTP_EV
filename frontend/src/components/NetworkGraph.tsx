import { useMemo, useState } from 'react'
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react'
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

function stationPosition(u: { x: number; y: number }, v: { x: number; y: number }, offset: number) {
  return { x: (u.x + v.x) / 2, y: (u.y + v.y) / 2 + offset }
}

export default function NetworkGraph({ network, trajectory, timeIndex, mode, selectedStation, onSelectStation }: Props) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const layout = useMemo(() => computeLayout(network), [network])

  const nodes: Node[] = useMemo(() => {
    const out: Node[] = []
    layout.forEach((pos, id) => {
      const isTerminal = network.ods.some((od) => od.origin === id || od.dest === id)
      out.push({
        id,
        position: { x: pos.x, y: pos.y },
        data: { label: id },
        className: isTerminal ? 'terminal-node' : undefined,
        draggable: false,
      })
    })
    network.stations.forEach((station, index) => {
      const u = layout.get(station.u); const v = layout.get(station.v)
      if (!u || !v) return
      out.push({
        id: `station:${station.name}`,
        position: stationPosition(u, v, index % 2 === 0 ? -30 : 30),
        data: { label: station.name },
        className: `station-node${selectedStation === station.name ? ' selected-node' : ''}`,
        draggable: false,
      })
    })
    return out
  }, [layout, network, selectedStation])

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = []
    const idx = trajectory ? Math.min(timeIndex, trajectory.time.length - 1) : -1

    network.roads.forEach((road, i) => {
      const label = `${road.u}->${road.v}`
      const rt = trajectory?.roads[label]
      const isNevOnly = road.classes && !road.classes.includes('EV')
      let intensity = 0
      let valueLabel: string | undefined

      if (rt && idx >= 0) {
        const capRatio = rt.capacity_ratio[idx] ?? 0
        const lat = rt.latency[idx] ?? 0
        if (mode === 'ev') { intensity = Math.min(1, (rt.ev_density[idx] ?? 0) / (rt.capacity_L || 1)); valueLabel = `EV ${(rt.ev_density[idx] ?? 0).toFixed(2)}` }
        else if (mode === 'nev') { intensity = Math.min(1, (rt.nev_density[idx] ?? 0) / (rt.capacity_L || 1)); valueLabel = `NEV ${(rt.nev_density[idx] ?? 0).toFixed(2)}` }
        else if (mode === 'latency') { intensity = Math.min(1, lat / 2); valueLabel = `φ ${lat.toFixed(2)}` }
        else { intensity = capRatio; valueLabel = `x ${(rt.total_density[idx] ?? 0).toFixed(2)}` }
      }

      out.push({
        id: `road:${i}:${label}`,
        source: road.u,
        target: road.v,
        type: 'smoothstep',
        animated: intensity > 0.5,
        label: valueLabel,
        className: isNevOnly ? 'nev-edge' : undefined,
        style: {
          strokeWidth: 1.6 + intensity * 6,
          opacity: 0.55 + intensity * 0.45,
        },
        data: { kind: 'road', label, road, rt },
      })
    })

    network.stations.forEach((station, i) => {
      const sid = `station:${station.name}`
      const st = trajectory?.stations[station.name]
      const occ = st && idx >= 0 ? st.occupancy[idx] : undefined
      const K = st?.saturation_K
      const over = occ !== undefined && K !== undefined && occ > K
      const common = { type: 'smoothstep' as const, animated: true, className: `station-edge${over ? ' selected-edge' : ''}` }
      out.push({ id: `station-in:${i}`, source: station.u, target: sid, data: { kind: 'station', station, st }, ...common })
      out.push({ id: `station-out:${i}`, source: sid, target: station.v, data: { kind: 'station', station, st }, ...common })
    })

    return out
  }, [network, trajectory, timeIndex, mode])

  const showTooltip = (e: React.MouseEvent, edge: Edge) => {
    const rect = (e.target as HTMLElement).closest('.network-shell')?.getBoundingClientRect()
    const x = rect ? e.clientX - rect.left + 12 : e.clientX
    const y = rect ? e.clientY - rect.top + 12 : e.clientY
    const d = edge.data as any
    if (d?.kind === 'road') {
      const r = d.road
      const rt = d.rt
      const idx = trajectory ? Math.min(timeIndex, trajectory.time.length - 1) : -1
      const lines = [
        `${r.u} -> ${r.v}`,
        `classes: ${(r.classes ?? network.classes).join(', ')}`,
        `capacity L: ${(r.L ?? network.defaults.L).toFixed(2)}`,
      ]
      if (rt && idx >= 0) {
        lines.push(
          `EV density: ${(rt.ev_density[idx] ?? 0).toFixed(3)}`,
          `NEV density: ${(rt.nev_density[idx] ?? 0).toFixed(3)}`,
          `latency φ: ${(rt.latency[idx] ?? 0).toFixed(3)}`,
          `x/L: ${(rt.capacity_ratio[idx] ?? 0).toFixed(2)}`,
        )
      }
      setTooltip({ x, y, title: `Road ${d.label}`, lines })
    } else if (d?.kind === 'station') {
      const s = d.station
      const st = d.st
      const idx = trajectory ? Math.min(timeIndex, trajectory.time.length - 1) : -1
      const lines = [`u->v: ${s.u} -> ${s.v}`]
      if (st && idx >= 0) {
        lines.push(
          `price ψ: ${(st.price[idx] ?? 0).toFixed(3)}`,
          `occupancy: ${(st.occupancy[idx] ?? 0).toFixed(3)} (K=${st.saturation_K.toFixed(2)})`,
          `queue: ${(st.queue[idx] ?? 0).toFixed(3)}`,
          `throughput ρ: ${(st.throughput[idx] ?? 0).toFixed(3)}`,
        )
      }
      setTooltip({ x, y, title: `Station ${s.name}`, lines })
    }
  }

  return (
    <div className="network-shell">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        minZoom={0.3}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
        onEdgeMouseEnter={(e, edge) => showTooltip(e, edge)}
        onEdgeMouseMove={(e, edge) => showTooltip(e, edge)}
        onEdgeMouseLeave={() => setTooltip(null)}
        onEdgeClick={(_, edge) => {
          const d = edge.data as any
          if (d?.kind === 'station') onSelectStation(d.station.name === selectedStation ? null : d.station.name)
        }}
        onNodeClick={(_, node) => {
          if (node.id.startsWith('station:')) {
            const name = node.id.slice('station:'.length)
            onSelectStation(name === selectedStation ? null : name)
          }
        }}
      >
        <Background gap={22} size={1} color="#e2ded3" />
        <Controls showInteractive={false} />
      </ReactFlow>
      {tooltip && (
        <div className="graph-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <b>{tooltip.title}</b>
          {tooltip.lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  )
}
