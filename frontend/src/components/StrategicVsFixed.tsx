import type { ComparePricingResult } from '../types'

interface Props {
  result: ComparePricingResult | null
  running: boolean
  onRun: () => void
}

function Row({ label, strategic, fixed, digits = 3 }: { label: string; strategic: number; fixed: number; digits?: number }) {
  const diff = strategic - fixed
  return (
    <tr>
      <td>{label}</td>
      <td>{strategic.toFixed(digits)}</td>
      <td>{fixed.toFixed(digits)}</td>
      <td style={{ color: diff >= 0 ? '#3f7a5a' : '#b23b3b' }}>{diff >= 0 ? '+' : ''}{diff.toFixed(digits)}</td>
    </tr>
  )
}

export default function StrategicVsFixed({ result, running, onRun }: Props) {
  return (
    <div>
      <p className="muted" style={{ marginBottom: 12 }}>
        Compares the strategic Nash-equilibrium price profile against a uniform fixed price set to the same
        average — isolating the effect of price <i>differentiation</i> across stations from the effect of price
        <i> level</i>. Uses the current network and solver settings from the left panel.
      </p>
      <button className="primary-button" onClick={onRun} disabled={running} style={{ marginBottom: 16 }}>
        {running ? 'Comparing…' : 'Run comparison'}
      </button>

      {!result ? (
        <div className="empty-state">No comparison run yet.</div>
      ) : (
        <>
          <p className="muted" style={{ marginBottom: 10 }}>
            Uniform fixed price: <b className="mono">{result.average_price.toFixed(3)}</b> (average of the strategic prices below)
          </p>
          <table className="compare-table">
            <thead>
              <tr><th>Station</th><th>Strategic ψ</th><th>Fixed ψ</th><th>Δ</th></tr>
            </thead>
            <tbody>
              {result.stations.map((s) => (
                <Row key={s} label={s} strategic={result.strategic.prices[s]} fixed={result.fixed.prices[s]} />
              ))}
            </tbody>
          </table>

          <div className="charts-grid" style={{ marginTop: 18 }}>
            <div className="chart-card" style={{ minHeight: 'auto' }}>
              <h3 style={{ marginBottom: 10 }}>Per-station throughput</h3>
              <table className="compare-table">
                <thead><tr><th>Station</th><th>Strategic ρ</th><th>Fixed ρ</th><th>Δ</th></tr></thead>
                <tbody>
                  {result.stations.map((s) => (
                    <Row key={s} label={s} strategic={result.strategic.throughputs[s]} fixed={result.fixed.throughputs[s]} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="chart-card" style={{ minHeight: 'auto' }}>
              <h3 style={{ marginBottom: 10 }}>Per-station occupancy</h3>
              <table className="compare-table">
                <thead><tr><th>Station</th><th>Strategic x</th><th>Fixed x</th><th>Δ</th></tr></thead>
                <tbody>
                  {result.stations.map((s) => (
                    <Row key={s} label={s} strategic={result.strategic.occupancies[s]} fixed={result.fixed.occupancies[s]} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <table className="compare-table" style={{ marginTop: 18 }}>
            <thead><tr><th>Aggregate</th><th>Strategic</th><th>Fixed</th><th>Δ</th></tr></thead>
            <tbody>
              <Row label="Total station profit" strategic={result.strategic.total_profit} fixed={result.fixed.total_profit} />
              <Row label="Total user cost" strategic={result.strategic.total_user_cost} fixed={result.fixed.total_user_cost} />
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
