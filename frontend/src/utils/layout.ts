import type { NetworkConfig } from '../types'

export interface LayoutNode {
  id: string
  x: number
  y: number
  layer: number
}

const LAYER_W = 190
const ROW_H = 130

/**
 * Auto-layout: BFS layering from source nodes (nodes with no incoming road
 * edge) so the diagram generalizes to any topology, not just the three
 * bundled scenarios. Station access links aren't used for layering (a
 * station sits *between* its u/v road nodes, not as its own layer) so the
 * road skeleton alone determines layer depth.
 */
export function computeLayout(network: NetworkConfig): Map<string, LayoutNode> {
  const nodeIds = new Set<string>()
  const adjacency = new Map<string, string[]>()
  const hasIncoming = new Set<string>()

  const addEdge = (u: string, v: string) => {
    nodeIds.add(u); nodeIds.add(v)
    if (!adjacency.has(u)) adjacency.set(u, [])
    adjacency.get(u)!.push(v)
    hasIncoming.add(v)
  }

  network.roads.forEach((r) => addEdge(r.u, r.v))
  network.stations.forEach((s) => addEdge(s.u, s.v))

  const sources = [...nodeIds].filter((id) => !hasIncoming.has(id))
  const layer = new Map<string, number>()
  const queue: string[] = []
  const roots = sources.length > 0 ? sources : [...nodeIds].slice(0, 1)
  roots.forEach((id) => { layer.set(id, 0); queue.push(id) })

  while (queue.length > 0) {
    const id = queue.shift()!
    const d = layer.get(id)!
    for (const next of adjacency.get(id) ?? []) {
      if (!layer.has(next) || layer.get(next)! < d + 1) {
        layer.set(next, d + 1)
        queue.push(next)
      }
    }
  }
  // Anything unreached (disconnected component) gets appended as its own layer.
  let maxLayer = Math.max(0, ...layer.values())
  nodeIds.forEach((id) => {
    if (!layer.has(id)) layer.set(id, ++maxLayer)
  })

  const byLayer = new Map<number, string[]>()
  nodeIds.forEach((id) => {
    const l = layer.get(id)!
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(id)
  })

  const result = new Map<string, LayoutNode>()
  byLayer.forEach((ids, l) => {
    ids.sort()
    const totalH = (ids.length - 1) * ROW_H
    ids.forEach((id, i) => {
      result.set(id, { id, x: l * LAYER_W, y: i * ROW_H - totalH / 2 + 260, layer: l })
    })
  })
  return result
}
