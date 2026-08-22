import { useMemo, useState } from 'react'
import {
  Background,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
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

const PRIVATE_STATION_COLOR = '#16a34a'
const SHARED_STATION_COLOR = '#9333ea'

function stationColor(name: string) {
  return name.toLowerCase().includes('shared') || name.toLowerCase().startsWith('ssh')
    ? SHARED_STATION_COLOR
    : PRIVATE_STATION_COLOR
}

function stationPosition(
  u: { x: number; y: number },
  v: { x: number; y: number },
  offset: number,
) {
  const dx = v.x - u.x
  const dy = v.y - u.y
  const length = Math.hypot(dx, dy) || 1
  return {
    x: (u.x + v.x) / 2 - (dy / length) * offset,
    y: (u.y + v.y) / 2 + (dx / length) * offset,
  }
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

  const layout = useMemo(() => computeLayout(network), [network])

  /*
   * --------------------------------------------------------------------------
   * Nodes
   * --------------------------------------------------------------------------
   */
  const nodes: Node[] = useMemo(() => {
    const out: Node[] = []

    // Normal road-network nodes
    layout.forEach((pos, id) => {
      const isOrigin = network.ods.some((od) => od.origin === id)
      const isDestination = network.ods.some((od) => od.dest === id)

      out.push({
        id,
        position: {
          x: pos.x,
          y: pos.y,
        },
        data: {
          label: id,
        },
        className: isOrigin
          ? 'origin-node'
          : isDestination
            ? 'destination-node'
            : 'junction-node',
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        draggable: false,
      })
    })

    // Charging-station nodes
    network.stations.forEach((station, index) => {
      const u = layout.get(station.u)
      const v = layout.get(station.v)

      if (!u || !v) return

      const color = stationColor(station.name)

      out.push({
        id: `station:${station.name}`,
        position: stationPosition(
          u,
          v,
          index % 2 === 0 ? -46 : 46,
        ),
        data: {
          label: station.name,
        },
        className: `station-node${
          color === SHARED_STATION_COLOR ? ' shared-station-node' : ' private-station-node'
        }${
          selectedStation === station.name ? ' selected-node' : ''
        }`,

        // Every station gets its own chart-consistent color.
        style: {
          background: color,
          border: `2px solid ${color}`,
          color: '#ffffff',
        },

        sourcePosition: Position.Right,
        targetPosition: Position.Left,

        draggable: false,
      })
    })

    return out
  }, [layout, network, selectedStation])

  /*
   * --------------------------------------------------------------------------
   * Edges
   * --------------------------------------------------------------------------
   */
  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = []

    const idx = trajectory
      ? Math.min(timeIndex, trajectory.time.length - 1)
      : -1

    /*
     * ------------------------------------------------------------------------
     * Road edges
     * ------------------------------------------------------------------------
     */
    network.roads.forEach((road, i) => {
      const label = `${road.u}->${road.v}`

      const rt = trajectory?.roads[label]

      const isNevOnly =
        road.classes && !road.classes.includes('EV')

      // Arrow color distinguishes NEV-only roads from normal roads.
      const arrowColor = isNevOnly ? '#9c8256' : '#9a927f'

      let intensity = 0
      let valueLabel = 'x 0.00'

      if (rt && idx >= 0) {
        const capRatio = rt.capacity_ratio[idx] ?? 0
        const lat = rt.latency[idx] ?? 0

        if (mode === 'ev') {
          intensity = Math.min(
            1,
            (rt.ev_density[idx] ?? 0) /
              (rt.capacity_L || 1),
          )

          valueLabel = `EV ${(rt.ev_density[idx] ?? 0).toFixed(2)}`
        } else if (mode === 'nev') {
          intensity = Math.min(
            1,
            (rt.nev_density[idx] ?? 0) /
              (rt.capacity_L || 1),
          )

          valueLabel = `NEV ${(rt.nev_density[idx] ?? 0).toFixed(2)}`
        } else if (mode === 'latency') {
          intensity = Math.min(1, lat / 2)

          valueLabel = `φ ${lat.toFixed(2)}`
        } else {
          intensity = capRatio

          valueLabel = `x ${(rt.total_density[idx] ?? 0).toFixed(2)}`
        }
      }

      out.push({
        id: `road:${i}:${label}`,
        source: road.u,
        target: road.v,

        type: 'default',

        // Heavily loaded roads appear animated.
        animated: intensity > 0.5,

        label: valueLabel,

        className: isNevOnly
          ? 'nev-edge'
          : undefined,

        style: {
          // Congestion / density controls line thickness.
          strokeWidth: 1.6 + intensity * 6,
          opacity: 0.55 + intensity * 0.45,
        },

        // Directional road arrow.
        // Arrow size grows with congestion intensity.
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: arrowColor,
          width: 14 + intensity * 12,
          height: 14 + intensity * 12,
        },

        data: {
          kind: 'road',
          label,
          road,
          rt,
        },
      })
    })

    /*
     * ------------------------------------------------------------------------
     * Station access-link edges
     * ------------------------------------------------------------------------
     */
    network.stations.forEach((station, i) => {
      const sid = `station:${station.name}`

      const st =
        trajectory?.stations[station.name]

      const occ =
        st && idx >= 0
          ? st.occupancy[idx]
          : undefined

      const K = st?.saturation_K

      /*
       * Occupancy ratio controls access-link thickness.
       *
       * intensity = 0 → empty / uncongested
       * intensity = 1 → occupancy reaches saturation capacity
       */
      const intensity =
        occ !== undefined && K
          ? Math.min(1, occ / K)
          : 0

      const over =
        occ !== undefined &&
        K !== undefined &&
        occ > K
      const stationValueLabel = `x ${(occ ?? 0).toFixed(2)}`

      const color = stationColor(station.name)

      const common = {
        type: 'default' as const,

        animated: true,

        className: `station-edge${
          over ? ' selected-edge' : ''
        }`,

        style: {
          stroke: color,
          strokeWidth: 1.6 + intensity * 6,
        },

        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 14 + intensity * 12,
          height: 14 + intensity * 12,
        },
      }

      /*
       * Road node → charging station
       */
      out.push({
        id: `station-in:${i}`,
        source: station.u,
        target: sid,
        label: stationValueLabel,

        data: {
          kind: 'station',
          station,
          st,
        },

        ...common,
      })

      /*
       * Charging station → road node
       */
      out.push({
        id: `station-out:${i}`,
        source: sid,
        target: station.v,

        data: {
          kind: 'station',
          station,
          st,
        },

        ...common,
      })
    })

    return out
  }, [network, trajectory, timeIndex, mode])

  /*
   * --------------------------------------------------------------------------
   * Tooltip handling
   * --------------------------------------------------------------------------
   */
  const showTooltip = (
    e: React.MouseEvent,
    edge: Edge,
  ) => {
    const rect = (
      e.target as HTMLElement
    )
      .closest('.network-shell')
      ?.getBoundingClientRect()

    const x = rect
      ? e.clientX - rect.left + 12
      : e.clientX

    const y = rect
      ? e.clientY - rect.top + 12
      : e.clientY

    const d = edge.data as any

    /*
     * Road tooltip
     */
    if (d?.kind === 'road') {
      const r = d.road
      const rt = d.rt

      const idx = trajectory
        ? Math.min(
            timeIndex,
            trajectory.time.length - 1,
          )
        : -1

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

      setTooltip({
        x,
        y,
        title: `Road ${d.label}`,
        lines,
      })
    }

    /*
     * Station tooltip
     */
    else if (d?.kind === 'station') {
      const s = d.station
      const st = d.st

      const idx = trajectory
        ? Math.min(
            timeIndex,
            trajectory.time.length - 1,
          )
        : -1

      const lines = [
        `u->v: ${s.u} -> ${s.v}`,
      ]

      if (st && idx >= 0) {
        lines.push(
          `price ψ: ${(st.price[idx] ?? 0).toFixed(3)}`,
          `occupancy: ${(st.occupancy[idx] ?? 0).toFixed(3)} (K=${st.saturation_K.toFixed(2)})`,
          `queue: ${(st.queue[idx] ?? 0).toFixed(3)}`,
          `throughput ρ: ${(st.throughput[idx] ?? 0).toFixed(3)}`,
        )
      }

      setTooltip({
        x,
        y,
        title: `Station ${s.name}`,
        lines,
      })
    }
  }

  /*
   * --------------------------------------------------------------------------
   * Rendering
   * --------------------------------------------------------------------------
   */
  return (
    <div className="network-shell">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        minZoom={0.3}
        maxZoom={1.8}
        proOptions={{
          hideAttribution: true,
        }}

        onEdgeMouseEnter={(e, edge) =>
          showTooltip(e, edge)
        }

        onEdgeMouseMove={(e, edge) =>
          showTooltip(e, edge)
        }

        onEdgeMouseLeave={() =>
          setTooltip(null)
        }

        onEdgeClick={(_, edge) => {
          const d = edge.data as any

          if (d?.kind === 'station') {
            onSelectStation(
              d.station.name === selectedStation
                ? null
                : d.station.name,
            )
          }
        }}

        onNodeClick={(_, node) => {
          if (
            node.id.startsWith('station:')
          ) {
            const name =
              node.id.slice(
                'station:'.length,
              )

            onSelectStation(
              name === selectedStation
                ? null
                : name,
            )
          }
        }}
      >
        <Background
          gap={22}
          size={1}
          color="#e2ded3"
        />

        <Controls
          showInteractive={false}
        />
      </ReactFlow>

      {tooltip && (
        <div
          className="graph-tooltip"
          style={{
            left: tooltip.x,
            top: tooltip.y,
          }}
        >
          <b>{tooltip.title}</b>

          {tooltip.lines.map(
            (line, i) => (
              <div key={i}>
                {line}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  )
}
