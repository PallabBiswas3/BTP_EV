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
  initial_psi?: number
}

export interface ODConfig {
  name: string
  origin: string
  dest: string
  lam: number
  shares: Record<string, number>
  demand_schedule?: string
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
  kappa: number
  delta: number
  dt_outer: number
  grad_clip: number | null
  t_end: number
  h: number
  ctrl_horizon: number | 'eq'
  profit_mode: 'mean' | 'end'
  eq_t_max: number
  parallel: boolean | null
  n_workers: number | null
  psi0: number
  final_t: number
  save_plots: boolean
}

export const DEFAULT_SIMULATION_OPTIONS: SimulationOptions = {
  kappa: 0.1,
  delta: 0.02,
  dt_outer: 1.0,
  grad_clip: null,
  t_end: 75000,
  h: 1500,
  ctrl_horizon: 1,
  profit_mode: 'end',
  eq_t_max: 75000,
  parallel: true,
  n_workers: null,
  psi0: 0.5,
  final_t: 500,
  save_plots: true,
}

// ---- Result shapes (mirror app/services/simulation_service.py serializers) ----

export interface EquilibriumBlock {
  prices: Record<string, number>
  occupancies: Record<string, number>
  throughputs: Record<string, number>
  profits: Record<string, number>
  total_profit: number
  total_user_cost: number
  total_revenue: number
  result_kind: 'dynamic_endpoint'
  converged: boolean
  warnings: string[]
  quality: {
    approach: 'predictive'
    result_kind: 'dynamic_endpoint'
    ctrl_horizon: number | 'eq'
    profit_mode: 'mean' | 'end'
    h: number
    requested_t_end: number
    actual_t_end: number
    forecast_duration: number | null
    forecast_solve_count: number
    actual_advance_count: number
    wall_time_seconds: number
    accuracy_mode: 'preview' | 'balanced' | 'research'
    gradient_method: string
    gradient_samples: number
    gradient_execution: string
    gradient_workers: number
    gradient_fallback_reason: string
    effective_kappa: number
    state_count: number
    path_count: number
    route_limit: number
    route_limit_hits: string[]
    inner_solve_count: number
    cache_hit_count: number
    cache_warm_start_count: number
    inner_failure_count: number | null
    max_inner_residual: number | null
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
  revenue?: number[]
  queue?: number[]
}

export interface OuterHistoryBlock {
  step: number[]
  time: number[]
  wardrop: Record<string, number[]>
  path_y: Record<string, number[]>
  total_revenue: number[]
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
  revenue: number[]
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
  total_revenue: number[]
}

export type RunStreamEvent<T> =
  | { type: 'progress'; phase: string; step: number; n_steps: number }
  | { type: 'heartbeat' }
  | { type: 'artifact'; name: string; url: string; mime_type: 'image/png'; data_base64: string }
  | { type: 'result'; result: T }
  | { type: 'error'; code: string; message: string }

export interface SimulateResult {
  network: NetworkConfig
  equilibrium: EquilibriumBlock
  outer_history: OuterHistoryBlock
  trajectory: TrajectoryBlock
  final_traffic: {
    requested_duration: number
    actual_duration: number
    success: boolean
    trajectory: TrajectoryBlock
    total_user_cost: number
    total_profit: number
    total_revenue: number
    occupancies: Record<string, number>
    throughputs: Record<string, number>
    profits: Record<string, number>
  }
  artifacts: { name: string; url: string }[]
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

// ---- Solar + battery + fast/slow charger model (mirrors backend/simulation/energy/loop.py) ----

export interface EnergyOptions {
  t_end: number
  h: number
  horizon: number
  kappa: number
  delta: number
  price_cap: number | null
  parallel: boolean
}

export const DEFAULT_ENERGY_OPTIONS: EnergyOptions = {
  t_end: 72,
  h: 0.5,
  horizon: 2,
  kappa: 4,
  delta: 5,
  price_cap: null,
  parallel: true,
}

export interface EnergyChargerSeries {
  site: string
  mode: string
  count: number
  power_kw: number
  price: number[]
  arrivals: number[]
  throughput: number[]
  occupancy: number[]
  queue: number[]
}

export interface EnergySiteTotals {
  hours: number
  revenue: number
  energy_cost: number
  fixed_cost: number
  profit: number
  vehicles_served: number
  energy_delivered_kwh: number
  grid_energy_bought_kwh: number
  solar_curtailed_kwh: number
  share_solar_direct: number
  share_battery: number
  share_grid_direct: number
  average_price: Record<string, number>
}

export interface EnergySiteSeries {
  strategic: boolean
  has_solar: boolean
  has_storage: boolean
  chargers: string[]
  solar_peak_kw: number
  battery_capacity_kwh: number
  soc: number[]
  load_kw: number[]
  solar_available_kw: number[]
  solar_to_load_kw: number[]
  solar_to_battery_kw: number[]
  solar_curtailed_kw: number[]
  grid_to_load_kw: number[]
  grid_to_battery_kw: number[]
  battery_to_load_kw: number[]
  stored_kwh: number[]
  marginal_cost: number[]
  revenue_rate: number[]
  energy_cost_rate: number[]
  profit_rate: number[]
  summary: EnergySiteTotals
  last_day: EnergySiteTotals
}

export interface EnergyResult {
  model: 'energy-pricing'
  scenario: Record<string, unknown>
  units: { time: string; power: string; energy: string; currency: string; price: string }
  time: number[]
  hour_of_day: number[]
  tariff: number[]
  chargers: Record<string, EnergyChargerSeries>
  sites: Record<string, EnergySiteSeries>
  settings: Record<string, number | string | boolean | null>
  warnings: string[]
}
