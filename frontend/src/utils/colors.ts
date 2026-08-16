const PALETTE = ['#2a5f5b', '#9c8256', '#6b5b8c', '#b0743a', '#4b6f8c', '#7a8c4b', '#8c4b6f', '#4b8c7a']

export function colorForIndex(i: number): string {
  return PALETTE[i % PALETTE.length]
}

export function colorForStation(stations: string[], name: string): string {
  const i = stations.indexOf(name)
  return colorForIndex(i < 0 ? 0 : i)
}
