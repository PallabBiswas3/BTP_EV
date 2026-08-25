import type { NetworkConfig } from '../types'

export interface LayoutNode {
  id: string
  x: number
  y: number
  layer: number
}

const WIDTH = 920
const HEIGHT = 680
const PADDING = 56
const NODE_CLEARANCE = 72
const COLLISION_ITERATIONS = 160

/**
 * Deterministic force-directed layout for cyclic and bidirectional roads.
 * Links act as undirected springs for positioning only; rendered edges keep
 * their configured direction and class data.
 */
export function computeLayout(network: NetworkConfig): Map<string, LayoutNode> {
  const ids = [...new Set([
    ...network.roads.flatMap((road) => [road.u, road.v]),
    ...network.stations.flatMap((station) => [station.u, station.v]),
    ...network.ods.flatMap((od) => [od.origin, od.dest]),
  ])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  if (ids.length === 0) return new Map()

  const index = new Map(ids.map((id, i) => [id, i]))
  const links = new Map<string, [number, number]>()
  const addLink = (u: string, v: string) => {
    const a = index.get(u)
    const b = index.get(v)
    if (a === undefined || b === undefined || a === b) return
    const key = a < b ? `${a}:${b}` : `${b}:${a}`
    links.set(key, [a, b])
  }
  network.roads.forEach((road) => addLink(road.u, road.v))
  network.stations.forEach((station) => addLink(station.u, station.v))

  const n = ids.length
  const radius = Math.min(WIDTH, HEIGHT) * 0.36
  const positions = ids.map((_, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2
    return { x: WIDTH / 2 + radius * Math.cos(angle), y: HEIGHT / 2 + radius * Math.sin(angle) }
  })

  const area = (WIDTH - 2 * PADDING) * (HEIGHT - 2 * PADDING)
  const ideal = Math.sqrt(area / Math.max(n, 1))
  for (let iteration = 0; iteration < 280; iteration += 1) {
    const displacement = positions.map(() => ({ x: 0, y: 0 }))

    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let dx = positions[i].x - positions[j].x
        let dy = positions[i].y - positions[j].y
        const distance = Math.max(2, Math.hypot(dx, dy))
        dx /= distance; dy /= distance
        const force = (ideal * ideal) / distance
        displacement[i].x += dx * force; displacement[i].y += dy * force
        displacement[j].x -= dx * force; displacement[j].y -= dy * force
      }
    }

    links.forEach(([a, b]) => {
      let dx = positions[a].x - positions[b].x
      let dy = positions[a].y - positions[b].y
      const distance = Math.max(2, Math.hypot(dx, dy))
      dx /= distance; dy /= distance
      const force = (distance * distance) / ideal
      displacement[a].x -= dx * force; displacement[a].y -= dy * force
      displacement[b].x += dx * force; displacement[b].y += dy * force
    })

    const temperature = 52 * (1 - iteration / 280) + 1
    positions.forEach((position, i) => {
      displacement[i].x += (WIDTH / 2 - position.x) * 0.025
      displacement[i].y += (HEIGHT / 2 - position.y) * 0.025
      const magnitude = Math.max(1, Math.hypot(displacement[i].x, displacement[i].y))
      position.x += (displacement[i].x / magnitude) * Math.min(magnitude, temperature)
      position.y += (displacement[i].y / magnitude) * Math.min(magnitude, temperature)
      position.x = Math.max(PADDING, Math.min(WIDTH - PADDING, position.x))
      position.y = Math.max(PADDING, Math.min(HEIGHT - PADDING, position.y))
    })
  }

  // Keep the force-directed vertical ordering and all junction positions, but
  // present OD endpoints consistently: origins on the left, destinations on
  // the right. Origin takes precedence here as it does in NetworkGraph's node
  // styling when a node appears in both roles.
  const origins = new Set(network.ods.map((od) => od.origin))
  const destinations = new Set(network.ods.map((od) => od.dest))
  const orderByNeighbourPosition = (members: number[]) => {
    if (members.length < 2) return
    const slots = members.map((i) => positions[i].y).sort((a, b) => a - b)
    const neighbourAverage = (nodeIndex: number) => {
      const neighbourYs: number[] = []
      links.forEach(([a, b]) => {
        if (a === nodeIndex) neighbourYs.push(positions[b].y)
        if (b === nodeIndex) neighbourYs.push(positions[a].y)
      })
      return neighbourYs.length > 0
        ? neighbourYs.reduce((sum, y) => sum + y, 0) / neighbourYs.length
        : positions[nodeIndex].y
    }
    members
      .sort((a, b) => neighbourAverage(a) - neighbourAverage(b) || a - b)
      .forEach((nodeIndex, slotIndex) => { positions[nodeIndex].y = slots[slotIndex] })
  }

  // Match each endpoint column's vertical order to its connected junctions.
  // This reduces long criss-crossing links without moving the junctions.
  orderByNeighbourPosition(ids.flatMap((id, i) => origins.has(id) ? [i] : []))
  orderByNeighbourPosition(ids.flatMap((id, i) => destinations.has(id) && !origins.has(id) ? [i] : []))

  const anchorX = ids.map((id) => {
    if (origins.has(id)) return PADDING
    if (destinations.has(id)) return WIDTH - PADDING
    return null
  })
  ids.forEach((id, i) => {
    if (origins.has(id)) {
      positions[i].x = PADDING
    } else if (destinations.has(id)) {
      positions[i].x = WIDTH - PADDING
    }
  })

  // Pinning endpoints can place two previously separated nodes in the same
  // column. Resolve only those new close contacts (and any they cause), while
  // retaining the endpoint columns. NODE_CLEARANCE includes the 42px node
  // diameter plus a visible gap.
  for (let iteration = 0; iteration < COLLISION_ITERATIONS; iteration += 1) {
    let adjusted = false
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let dx = positions[i].x - positions[j].x
        let dy = positions[i].y - positions[j].y
        let distance = Math.hypot(dx, dy)
        if (distance >= NODE_CLEARANCE) continue

        adjusted = true
        if (distance < 0.001) {
          dx = 0
          dy = -1
          distance = 1
        }
        const ux = dx / distance
        const uy = dy / distance
        const overlap = NODE_CLEARANCE - distance + 0.1
        const iAnchored = anchorX[i] !== null
        const jAnchored = anchorX[j] !== null

        if (iAnchored && jAnchored) {
          // Endpoints in the same side column may move vertically, but never
          // leave their assigned left/right side.
          const direction = Math.abs(dy) < 0.001 ? -1 : Math.sign(dy)
          positions[i].y += direction * overlap / 2
          positions[j].y -= direction * overlap / 2
        } else if (iAnchored) {
          positions[j].x -= ux * overlap
          positions[j].y -= uy * overlap
        } else if (jAnchored) {
          positions[i].x += ux * overlap
          positions[i].y += uy * overlap
        } else {
          positions[i].x += ux * overlap / 2
          positions[i].y += uy * overlap / 2
          positions[j].x -= ux * overlap / 2
          positions[j].y -= uy * overlap / 2
        }
      }
    }

    positions.forEach((position, i) => {
      position.x = anchorX[i] ?? Math.max(PADDING, Math.min(WIDTH - PADDING, position.x))
      position.y = Math.max(PADDING, Math.min(HEIGHT - PADDING, position.y))
    })
    if (!adjusted) break
  }

  return new Map(ids.map((id, i) => [id, { id, ...positions[i], layer: 0 }]))
}
