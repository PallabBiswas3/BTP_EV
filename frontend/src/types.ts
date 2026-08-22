// ---- Network configuration (mirrors the backend's JSON scenario schema) ----

export type VehicleClass = 'EV' | 'NEV' | string

export interface Defaults {
  l0: number
  L: number
  a: number
  mu_s: number
  a_s: number
  c_s: number
  phi0: number
  alpha: number
  gamma: number
  eta: number
}

export interface RoadConfig {
  u: string
  v: string
  classes?: VehicleClass[]
  l0?: number
  L?: number
  a?: number
}

export interface StationConfig {
  u: string
  v: string
  name: string
  classes?: VehicleClass[]
  mu_s?: number
  a_s?: number
  c_s?: number
  phi0?: number
}

export interface ODConfig {
  name: string
  origin: string
  dest: string
  lam: number
  shares: Record<string, number>
}

export interface NetworkConfig {
  defaults: Defaults
  classes: VehicleClass[]
  roads: RoadConfig[]
  stations: StationConfig[]
  ods: ODConfig[]
}

export interface ScenarioMeta {
  id: string
  label: string
  description: string
}

// ---- Simulation options (mirrors app/schemas/network.py SimulationOptions) ----

export interface SimulationOptions {
  accuracy_mode: 'preview' | 'balanced' | 'research'
  n_steps: number
  max_outer_steps: number
  outer_tolerance: number
  stable_outer_steps: number
  kappa: number
  delta: number
  dt_outer: number
  psi_max: number
  grad_clip: number
  t_end: number
  psi0?: Record<string, number> | null
}

export const DEFAULT_SIMULATION_OPTIONS: SimulationOptions = {
  accuracy_mode: 'preview',
  n_steps: 30,
  max_outer_steps: 120,
  outer_tolerance: 0.0001,
  stable_outer_steps: 3,
  kappa: 0.1,
  delta: 0.02,
  dt_outer: 1.0,
  psi_max: 3.0,
  grad_clip: 5.0,
  t_end: 50,
}

// ---- Result shapes (mirror app/services/simulation_service.py serializers) ----

export interface EquilibriumBlock {
  prices: Record<string, number>
  occupancies: Record<string, number>
  throughputs: Record<string, number>
  profits: Record<string, number>
  total_profit: number
  total_user_cost: number
  converged: boolean
  warnings: string[]
  quality: {
    accuracy_mode: 'preview' | 'balanced' | 'research'
    gradient_method: string
    gradient_samples: number
    effective_kappa: number
    state_count: number
    path_count: number
    route_limit: number
    route_limit_hits: string[]
    inner_solve_count: number
    inner_failure_count: number
    max_inner_residual: number
    final_residual: number
    conservation_error: number
    last_price_change: number
    last_projected_price_change: number
    outer_converged: boolean
    requested_steps: number
    completed_steps: number
    maximum_steps: number
    outer_tolerance: number
    stable_steps_required: number
    stop_reason: string
    certified: boolean
  }
}

export interface OuterHistoryStation {
  price: number[]
  occupancy: number[]
  throughput: number[]
  profit: number[]
}

export interface OuterHistoryBlock {
  step: number[]
  stations: Record<string, OuterHistoryStation>
}

export interface RoadTrajectory {
  u: string
  v: string
  classes: string[]
  capacity_L: number
  ev_density: number[]
  nev_density: number[]
  total_density: number[]
  latency: number[]
  capacity_ratio: number[]
}

export interface StationTrajectory {
  saturation_K: number
  occupancy: number[]
  queue: number[]
  waiting_time: number[]
  throughput: number[]
  price: number[]
  profit: number[]
}

export interface PathTrajectory {
  od: string
  vehicle_class: string
  nodes: string[]
  stations_used: string[]
  flow: number[]
  cost: number[]
}

export interface TrajectoryBlock {
  time: number[]
  roads: Record<string, RoadTrajectory>
  stations: Record<string, StationTrajectory>
  paths: Record<string, PathTrajectory>
  total_profit: number[]
  total_user_cost: number[]
}

export interface SimulateResult {
  network: NetworkConfig
  equilibrium: EquilibriumBlock
  outer_history: OuterHistoryBlock
  trajectory: TrajectoryBlock
}

export interface EquilibriumOnlyResult {
  network: NetworkConfig
  equilibrium: EquilibriumBlock
  outer_history: OuterHistoryBlock
}

export interface BetaSweepResult {
  beta: number[]
  stations: string[]
  prices: Record<string, number[]>
  throughputs: Record<string, number[]>
  occupancies: Record<string, number[]>
  profits: Record<string, number[]>
  total_profit: number[]
  total_user_cost: number[]
  warnings: string[]
}

export interface ComparePricingSide {
  prices: Record<string, number>
  throughputs: Record<string, number>
  occupancies: Record<string, number>
  profits: Record<string, number>
  total_profit: number
  total_user_cost: number
}

export interface ComparePricingResult {
  stations: string[]
  average_price: number
  strategic: ComparePricingSide
  fixed: ComparePricingSide
  warnings: string[]
}

export interface PaperExperiment1Run {
  initial_prices: Record<string, number>
  equilibrium_prices: Record<string, number>
  history: OuterHistoryBlock
}

export interface PaperExperiment1Result {
  stations: string[]
  runs: Record<string, PaperExperiment1Run>
  warnings: string[]
}

export interface PaperExperiment2Result {
  beta: number[]
  stations: string[]
  prices: Record<string, number[]>
  throughputs: Record<string, number[]>
  occupancies: Record<string, number[]>
  warnings: string[]
}

export interface PaperExperiment3Result {
  beta: number[]
  stations: string[]
  strategic: { user_cost: number[]; profit: number[] }
  fixed: { user_cost: number[]; profit: number[] }
  warnings: string[]
}

// ---- Async job polling ----

export type JobStatusValue = 'running' | 'done' | 'error'

export interface JobStatus<T> {
  job_id: string
  status: JobStatusValue
  phase: string
  step: number
  n_steps: number
  result: T | null
  error: string | null
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}
