interface Props {
  phase: string
  step: number
  nSteps: number
  onCancel?: () => void
}

export default function ProgressOverlay({ phase, step, nSteps, onCancel }: Props) {
  const pct = nSteps > 0 ? Math.min(100, (step / nSteps) * 100) : (phase === 'Preparing network' ? 8 : 50)
  return (
    <div className="progress-overlay">
      <div>{phase}</div>
      <div className="bar"><span style={{ width: `${pct}%` }} /></div>
      {onCancel && <button type="button" onClick={onCancel}>Cancel request</button>}
    </div>
  )
}
