import type {
  BetaSweepResult, ComparePricingResult, EquilibriumOnlyResult, JobStatus,
  NetworkConfig, PaperExperiment1Result, PaperExperiment2Result,
  PaperExperiment3Result, ScenarioMeta, SimulateResult, SimulationOptions,
  ValidationResult,
} from './types'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000'

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
async function pollJob<T>(jobId: string, onProgress?: ProgressCallback, intervalMs = 900): Promise<T> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const status = await req<JobStatus<T>>(`/api/jobs/${jobId}`)
    onProgress?.(status.phase, status.step, status.n_steps)
    if (status.status === 'done') {
      if (status.result === null) throw new Error('Job finished with no result.')
      return status.result
    }
    if (status.status === 'error') {
      throw new Error(status.error ?? 'Job failed for an unknown reason.')
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

async function startAndPoll<T>(path: string, body: unknown, onProgress?: ProgressCallback): Promise<T> {
  const { job_id } = await req<{ job_id: string }>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return pollJob<T>(job_id, onProgress)
}

export function runSimulate(
  network: NetworkConfig, options: SimulationOptions, onProgress?: ProgressCallback,
): Promise<SimulateResult> {
  return startAndPoll('/api/simulate', { network, simulation_options: options }, onProgress)
}

export function runEquilibrium(
  network: NetworkConfig, options: SimulationOptions, onProgress?: ProgressCallback,
): Promise<EquilibriumOnlyResult> {
  return startAndPoll('/api/equilibrium', { network, simulation_options: options }, onProgress)
}

export function runBetaSweep(
  network: NetworkConfig, options: SimulationOptions,
  betaMin: number, betaMax: number, betaStep: number, onProgress?: ProgressCallback,
): Promise<BetaSweepResult> {
  return startAndPoll('/api/beta-sweep', {
    network, simulation_options: options,
    beta_min: betaMin, beta_max: betaMax, beta_step: betaStep,
  }, onProgress)
}

export function runComparePricing(
  network: NetworkConfig, options: SimulationOptions, onProgress?: ProgressCallback,
): Promise<ComparePricingResult> {
  return startAndPoll('/api/compare-pricing', { network, simulation_options: options }, onProgress)
}

export function runPaperExperiment1(nSteps: number, onProgress?: ProgressCallback): Promise<PaperExperiment1Result> {
  return startAndPoll(`/api/paper/experiment1?n_steps=${nSteps}`, {}, onProgress)
}

export function runPaperExperiment2(nSteps: number, onProgress?: ProgressCallback): Promise<PaperExperiment2Result> {
  return startAndPoll(`/api/paper/experiment2?n_steps=${nSteps}`, {}, onProgress)
}

export function runPaperExperiment3(nSteps: number, onProgress?: ProgressCallback): Promise<PaperExperiment3Result> {
  return startAndPoll(`/api/paper/experiment3?n_steps=${nSteps}`, {}, onProgress)
}
