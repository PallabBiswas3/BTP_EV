# Backend - exact supplied simulation

Custom-network simulation executes the unchanged `network_engine.py` and
`sim.py` in this directory. Their SHA-256 hashes match the two supplied files.
The adapter modules under `simulation/` translate network JSON, report job
progress, and serialize the original results; they do not replace the pricing
loop, routing, demand functions, equilibrium forecasts, or ODE integration.

See [exact-source implementation](../docs/exact_source_implementation.md) for
behavior, source fingerprints, compatibility changes, and verification.
The older [migration record](../docs/predictive_pricing_migration.md) describes
the previous adapted implementation and is historical.

## Run the API

```powershell
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
```

The API docs are at `/docs`. The default CORS origin is
`http://localhost:5173`; set `CORS_ORIGINS` to change it. A built
`frontend/dist` is served by FastAPI for a single-service deployment.
Use one uvicorn worker: background jobs are stored in process memory.

## Run the original command-line workflow

The complete original CLI is available, including CSV loading, all PNG plots,
console summaries, and final fixed-price continuation:

```powershell
cd backend
python sim.py roads.csv stations.csv ods.csv --t-end 75000 --h 1500 --horizon 10 --profit-mode end --final-t 500
```

CSV headers are exactly those expected by the supplied script:

- Roads: `u,v,classes,l0,L,a` (quote comma-separated classes).
- Stations: `u,v,station_id,mu_s,a_s,c_s,phi0,initial_psi`.
- OD pairs: `od_name,origin,dest,total_demand,ev_share,nev_share,demand_schedule`.

The dashboard also accepts its existing column aliases and submits JSON.

## API workflow

`POST /api/simulate` returns a job ID. Poll `/api/jobs/{job_id}` until its
status is `done` or `error`. Other job endpoints are `/api/equilibrium`,
`/api/beta-sweep`, `/api/compare-pricing`, and `/api/paper/experiment{1,2,3}`.
Scenario and validation endpoints remain synchronous.

Example simulation options for a short smoke run:

```json
{
  "t_end": 4,
  "h": 2,
  "ctrl_horizon": 2,
  "profit_mode": "end",
  "parallel": false,
  "psi0": 0.5,
  "final_t": 4,
  "save_plots": false
}
```

The usual network configuration goes beside `simulation_options` in the
request. Source CLI defaults are `t_end=75000`, `h=1500`, `ctrl_horizon=10`,
`profit_mode=end`, and `final_t=500`. `save_plots` defaults to true.

The result contains:

- `equilibrium`: the pricing run's dynamic endpoint (historical key name).
- `outer_history`: original post-update metrics with physical times added.
- `trajectory`: original pricing state and price histories for the dashboard.
- `final_traffic`: the source CLI's separate fixed-price continuation,
  including trajectory and final metrics. Duration rounds upward to a whole h.
- `artifacts`: original PNG plots downloadable from `/api/artifacts/...`.

Plots are written to `backend/.outputs/<run_id>/`, which is gitignored.
The Raw Data tab provides download links and both result sets.
`/api/equilibrium` returns the pricing summary without plots or continuation.

## Exact-source behavior

The source does not filter routes using road/station class labels. It skips OD
pairs lacking a road-only connection, including four extra groups in `i2.json`.
Skipped demand is reported in response warnings without introducing routes.
It keeps state only for selected routes and their stations. The API rejects
networks with unused stations because the original station metrics cannot
handle their missing states; no artificial states are added.

`psi0` is one uniform scalar, default 0.5. Station `initial_psi` is loaded but,
as in the original loop, does not select starting prices. No upper price cap
is available. `grad_clip` remains an optional source function argument.
Predictive steps are `round(t_end/h)`; old step count, accuracy-profile and
stopping fields are deprecated compatibility inputs and have no effect.

The original serial loop uses a module-global worker network. The API
serializes pricing runs to avoid concurrent requests replacing that network.
The original process-pool behavior is retained; worker failures are not
silently replaced with a different solver. Job exceptions are reported through
the normal error response. Equilibrium-forecast messages are printed by the
source; it does not return per-forecast convergence metadata.

The separate paper-reproduction endpoints retain their historical model in
`legacy_network_engine.py`, `legacy_strategic_pricing.py`, and `equilibrium.py`.
They are not part of the supplied CSV CLI workflow.

## Verification

```powershell
cd backend
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
```

Parity tests run against the local unchanged scripts by default. To compare
with the external originals instead:

```powershell
$env:EVCS_REFERENCE_DIR = 'C:\Users\PALLAB\Desktop\dynamic-ev-pricing'
python -m unittest discover -s tests -v
```

Tests cover source fingerprints, all seven bundled networks, path construction,
physical states, station histories, both profit objectives, step demand,
equilibrium forecasts, parallel execution, progress, API validation,
fixed-price continuation, original PNG generation and downloads.

## Time one Sioux Falls pricing iteration

```powershell
cd backend
python -u benchmarks/benchmark_iteration.py
```

This measures the first original pricing iteration with h=1500, a 10-interval
forecast, endpoint profit and serial execution. It retains the full 15000-unit
forecast horizon, times all 12 forecasts and the actual traffic advance, and
excludes plots and final continuation. The detailed machine-specific result is
saved to `.ecc/benchmarks/sioux_falls_one_iteration.json` at the repository root.
Later iterations can take different times; this is one measurement, not a
full-run runtime estimate.
