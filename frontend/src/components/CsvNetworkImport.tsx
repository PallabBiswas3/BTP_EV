import { useState } from 'react'
import { validateNetwork } from '../api'
import type { NetworkConfig } from '../types'
import { downloadJson } from '../utils/export'
import { networkFromCsv } from '../utils/csvNetwork'

interface Props {
  defaults: NetworkConfig['defaults']
  running: boolean
  onImport: (network: NetworkConfig) => void
}

type FileKey = 'roads' | 'stations' | 'ods'

export default function CsvNetworkImport({ defaults, running, onImport }: Props) {
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState<Partial<Record<FileKey, File>>>({})
  const [generated, setGenerated] = useState<NetworkConfig | null>(null)
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const choose = (key: FileKey, file?: File) => {
    setFiles((current) => ({ ...current, [key]: file }))
    setGenerated(null)
    setMessage(null)
  }

  const generate = async () => {
    if (!files.roads || !files.stations || !files.ods) return
    setChecking(true)
    setMessage(null)
    try {
      const [roads, stations, ods] = await Promise.all([
        files.roads.text(), files.stations.text(), files.ods.text(),
      ])
      const candidate = networkFromCsv(roads, stations, ods, defaults)
      const validation = await validateNetwork(candidate)
      if (!validation.valid) throw new Error(validation.errors.join(' '))
      setGenerated(candidate)
      setMessage({
        ok: true,
        text: `${candidate.roads.length} roads, ${candidate.stations.length} stations, ${candidate.ods.length} OD pairs.`,
      })
    } catch (error) {
      setGenerated(null)
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'CSV validation failed.' })
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="section-divider csv-import">
      <button type="button" className="collapse-toggle csv-toggle" onClick={() => setOpen((value) => !value)}>
        <h3>CSV network import</h3><span className="mono muted">{open ? '-' : '+'}</span>
      </button>
      {open && (
        <div className="csv-import-body">
          <p className="muted">Required columns: roads <b>u,v</b>; stations <b>u,v,name</b>; ODs <b>name,origin,dest,lam,EV,NEV</b>.</p>
          {(['roads', 'stations', 'ods'] as FileKey[]).map((key) => (
            <label className="csv-file" key={key}>
              <span>{key === 'stations' ? 'station.csv' : `${key}.csv`}</span>
              <input type="file" accept=".csv,text/csv" disabled={running || checking}
                onChange={(event) => choose(key, event.target.files?.[0])} />
            </label>
          ))}
          <button className="secondary-button" onClick={generate}
            disabled={running || checking || !files.roads || !files.stations || !files.ods}>
            {checking ? 'Validating...' : 'Validate and generate JSON'}
          </button>
          {message && <div className={`csv-result ${message.ok ? 'valid' : 'invalid'}`}>{message.text}</div>}
          {generated && (
            <div className="csv-actions">
              <button className="primary-button" onClick={() => onImport(generated)} disabled={running}>Use for simulation</button>
              <button className="secondary-button" onClick={() => downloadJson('network.json', generated)}>Download JSON</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
