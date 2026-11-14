import type {
  BetaSweepResult, ComparePricingResult, EnergyOptions, EnergyResult, EquilibriumOnlyResult, JobStatus,
  NetworkConfig, PaperExperiment1Result, PaperExperiment2Result,
  PaperExperiment3Result, ScenarioMeta, SimulateResult, SimulationOptions,
  ValidationResult,
} from './types'
import { readRunStream } from './stream'

const API_BASE = (import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? 'http://localhost:8000' : '')).replace(/\/+$/, '')

export function artifactUrl(path: string): string {
  if (path.startsWith('blob:')) return path
  return `${API_BASE}${path}`
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`
    try {
      const body = await response.json()
      message = body.detail ? (typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)) : message
    } catch {
      // response wasn't JSON; keep the generic message
    }
    throw new Error(message)
  }
  return response.json()
}

export function fetchScenarios(): Promise<ScenarioMeta[]> {
  return req('/api/scenarios')
}

export function fetchScenarioNetwork(id: string): Promise<NetworkConfig> {
  return req(`/api/scenarios/${id}`)
}

export function validateNetwork(network: NetworkConfig): Promise<ValidationResult> {
  return req('/api/custom-network/validate', {
    method: 'POST',
    body: JSON.stringify({ network }),
  })
}

export type ProgressCallback = (phase: string, step: number, nSteps: number) => void

/** Poll a job until it finishes (done|error), reporting progress along the way. */
async function pollJob<T>(jobId: string, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<T> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const status = await req<JobStatus<T>>(`/api/jobs/${jobId}`, { signal })
    onProgress?.(status.phase, status.step, status.n_steps)
    if (status.status === 'done') {
      if (status.result === null) throw new Error('Job finished with no result.')
      return status.result
    }
    if (status.status === 'error') {
      throw new Error(status.error ?? 'Job failed for an unknown reason.')
    }
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return }
      const abort = () => { clearTimeout(timer); reject(signal?.reason) }
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, 900)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
}

async function startAndPoll<T>(path: string, body: unknown, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    const detail = error?.detail
    throw new Error(typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : `Request failed with status ${response.status}`)
  }
  if (response.headers.get('Content-Type')?.includes('application/x-ndjson')) {
    return readRunStream<T>(response, onProgress)
  }
  // Local/Render servers retain the original submit/poll transport by default.
  const { job_id } = await response.json() as { job_id: string }
  if (!job_id) throw new Error('The server returned no simulation job ID.')
  return pollJob<T>(job_id, onProgress, signal)
}

export function runSimulate(
  network: NetworkConfig, options: SimulationOptions, onProgress?: ProgressCallback, signal?: AbortSignal,
): Promise<SimulateResult> {
  return startAndPoll('/api/simulate', { network, simulation_options: options }, onProgress, signal)
}

export function runEquilibrium(
  network: NetworkConfig, options: SimulationOptions, onProgress?: ProgressCallback, signal?: AbortSignal,
): Promise<EquilibriumOnlyResult> {
  return startAndPoll('/api/equilibrium', { network, simulation_options: options }, onProgress, signal)
}

export function runBetaSweep(
  network: NetworkConfig, options: SimulationOptions,
  betaMin: number, betaMax: number, betaStep: number, onProgress?: ProgressCallback, signal?: AbortSignal,
): Promise<BetaSweepResult> {
  return startAndPoll('/api/beta-sweep', {
    network, simulation_options: options,
    beta_min: betaMin, beta_max: betaMax, beta_step: betaStep,
  }, onProgress, signal)
}

export function runComparePricing(
  network: NetworkConfig, options: SimulationOptions, onProgress?: ProgressCallback, signal?: AbortSignal,
): Promise<ComparePricingResult> {
  return startAndPoll('/api/compare-pricing', { network, simulation_options: options }, onProgress, signal)
}

export function runPaperExperiment1(nSteps: number, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<PaperExperiment1Result> {
  return startAndPoll(`/api/paper/experiment1?n_steps=${nSteps}`, {}, onProgress, signal)
}

export function runPaperExperiment2(nSteps: number, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<PaperExperiment2Result> {
  return startAndPoll(`/api/paper/experiment2?n_steps=${nSteps}`, {}, onProgress, signal)
}

export function runPaperExperiment3(nSteps: number, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<PaperExperiment3Result> {
  return startAndPoll(`/api/paper/experiment3?n_steps=${nSteps}`, {}, onProgress, signal)
}

export function fetchEnergyScenarios(): Promise<ScenarioMeta[]> {
  return req('/api/energy/scenarios')
}

export function fetchEnergyScenario(id: string): Promise<Record<string, unknown>> {
  return req(`/api/energy/scenarios/${id}`)
}

export function runEnergySimulate(
  scenario: Record<string, unknown>, options: EnergyOptions, onProgress?: ProgressCallback, signal?: AbortSignal,
): Promise<EnergyResult> {
  return startAndPoll('/api/energy/simulate', { scenario, simulation_options: options }, onProgress, signal)
}
