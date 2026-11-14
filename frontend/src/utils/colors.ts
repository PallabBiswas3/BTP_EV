// Categorical series colours, in a fixed order. The set is checked for
// separation under normal and colour-blind vision on the white chart surface.
// Aqua, yellow and magenta are below 3:1 contrast on white, so every chart
// using them keeps a legend and tooltip; never use them as text colours.
export const SERIES = {
  blue: '#2a78d6',
  orange: '#eb6834',
  aqua: '#1baf7a',
  yellow: '#eda100',
  magenta: '#e87ba4',
  green: '#008300',
  violet: '#6250d6',
  red: '#e34948',
}

/** Neutral ink for reference series (tariff, total load) that are not one of the compared entities. */
export const REFERENCE_INK = '#3d3a33'

const PALETTE = [
  SERIES.blue, SERIES.orange, SERIES.aqua, SERIES.yellow,
  SERIES.magenta, SERIES.green, SERIES.violet, SERIES.red,
]

export function colorForIndex(i: number): string {
  return PALETTE[i % PALETTE.length]
}

export function colorForStation(stations: string[], name: string): string {
  const i = stations.indexOf(name)
  return colorForIndex(i < 0 ? 0 : i)
}
