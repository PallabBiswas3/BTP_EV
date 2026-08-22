import type { NetworkConfig } from '../types'

type CsvRecord = Record<string, string>

function parseCsv(text: string, filename: string): CsvRecord[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const input = text.replace(/^\uFEFF/, '')

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i += 1 }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') { row.push(field.trim()); field = '' }
    else if (char === '\n') {
      row.push(field.trim()); field = ''
      if (row.some((value) => value !== '')) rows.push(row)
      row = []
    } else if (char !== '\r') field += char
  }
  row.push(field.trim())
  if (row.some((value) => value !== '')) rows.push(row)
  if (quoted) throw new Error(`${filename}: unmatched quote.`)
  if (rows.length === 0) throw new Error(`${filename}: file is empty.`)

  const headers = rows[0].map((header) => header.trim().toLowerCase())
  if (headers.some((header) => !header)) throw new Error(`${filename}: header names cannot be empty.`)
  if (new Set(headers).size !== headers.length) throw new Error(`${filename}: duplicate header name.`)

  return rows.slice(1).map((values, index) => {
    if (values.length > headers.length) throw new Error(`${filename}: row ${index + 2} has too many columns.`)
    return Object.fromEntries(headers.map((header, column) => [header, values[column] ?? '']))
  })
}

function required(record: CsvRecord, key: string, filename: string, row: number) {
  const value = record[key]?.trim()
  if (!value) throw new Error(`${filename}: row ${row}, '${key}' is required.`)
  return value
}

function numberValue(record: CsvRecord, key: string, filename: string, row: number, requiredField = false) {
  const raw = record[key]?.trim()
  if (!raw) {
    if (requiredField) throw new Error(`${filename}: row ${row}, '${key}' is required.`)
    return undefined
  }
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${filename}: row ${row}, '${key}' must be a number.`)
  return value
}

function classList(value: string | undefined) {
  const classes = value?.split(/[|;]/).map((item) => item.trim()).filter(Boolean)
  return classes?.length ? classes : undefined
}

function ensureUnique(values: string[], label: string) {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index)
  if (duplicate) throw new Error(`Duplicate ${label} '${duplicate}'.`)
}

export function networkFromCsv(
  roadText: string,
  stationText: string,
  odText: string,
  defaults: NetworkConfig['defaults'],
): NetworkConfig {
  const roadRecords = parseCsv(roadText, 'roads.csv')
  const stationRecords = parseCsv(stationText, 'station.csv')
  const odRecords = parseCsv(odText, 'ods.csv')
  if (roadRecords.length === 0) throw new Error('roads.csv: at least one road is required.')
  if (odRecords.length === 0) throw new Error('ods.csv: at least one OD pair is required.')

  const roads = roadRecords.map((record, index) => {
    const row = index + 2
    const road = {
      u: required(record, 'u', 'roads.csv', row),
      v: required(record, 'v', 'roads.csv', row),
      classes: classList(record.classes),
      l0: numberValue(record, 'l0', 'roads.csv', row),
      L: numberValue(record, 'l', 'roads.csv', row),
      a: numberValue(record, 'a', 'roads.csv', row),
    }
    if (road.L !== undefined && road.L <= 0) throw new Error(`roads.csv: row ${row}, 'L' must be positive.`)
    if (road.a !== undefined && road.a <= 0) throw new Error(`roads.csv: row ${row}, 'a' must be positive.`)
    return road
  })

  const stations = stationRecords.map((record, index) => {
    const row = index + 2
    const station = {
      u: required(record, 'u', 'station.csv', row),
      v: required(record, 'v', 'station.csv', row),
      name: required(record, 'name', 'station.csv', row),
      classes: classList(record.classes),
      mu_s: numberValue(record, 'mu_s', 'station.csv', row),
      a_s: numberValue(record, 'a_s', 'station.csv', row),
      c_s: numberValue(record, 'c_s', 'station.csv', row),
      phi0: numberValue(record, 'phi0', 'station.csv', row),
    }
    if (station.mu_s !== undefined && station.mu_s <= 0) throw new Error(`station.csv: row ${row}, 'mu_s' must be positive.`)
    if (station.a_s !== undefined && station.a_s <= 0) throw new Error(`station.csv: row ${row}, 'a_s' must be positive.`)
    return station
  })
  ensureUnique(stations.map((station) => station.name), 'station name')

  const inferredClasses = new Set<string>()
  const ods = odRecords.map((record, index) => {
    const row = index + 2
    const shares: Record<string, number> = {}
    Object.entries(record).forEach(([header, raw]) => {
      const vehicleClass = header.startsWith('share_')
        ? header.slice('share_'.length)
        : ['ev', 'nev'].includes(header) ? header : ''
      if (!vehicleClass || !raw.trim()) return
      const share = Number(raw)
      if (!Number.isFinite(share) || share < 0 || share > 1) {
        throw new Error(`ods.csv: row ${row}, share '${header}' must be between 0 and 1.`)
      }
      const className = vehicleClass.toUpperCase()
      shares[className] = share
      inferredClasses.add(className)
    })
    if (Object.keys(shares).length === 0) {
      throw new Error(`ods.csv: row ${row} needs EV/NEV or share_<class> columns.`)
    }
    const total = Object.values(shares).reduce((sum, share) => sum + share, 0)
    if (Math.abs(total - 1) > 1e-6) throw new Error(`ods.csv: row ${row}, shares sum to ${total}, not 1.`)
    const lam = numberValue(record, 'lam', 'ods.csv', row, true)!
    if (lam < 0) throw new Error(`ods.csv: row ${row}, 'lam' cannot be negative.`)
    return {
      name: required(record, 'name', 'ods.csv', row),
      origin: required(record, 'origin', 'ods.csv', row),
      dest: required(record, 'dest', 'ods.csv', row),
      lam,
      shares,
    }
  })
  ensureUnique(ods.map((od) => od.name), 'OD name')

  roads.forEach((road) => road.classes?.forEach((name) => inferredClasses.add(name)))
  stations.forEach((station) => station.classes?.forEach((name) => inferredClasses.add(name)))

  return {
    defaults: { ...defaults },
    classes: [...inferredClasses],
    roads,
    stations,
    ods,
  }
}
