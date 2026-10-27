# Predictive pricing migration and previous approach

> Historical record: superseded on 2026-10-24 by the
> [exact supplied-script implementation](exact_source_implementation.md).
> Adaptations described here no longer define custom-network execution.

Date: 2026-10-08.

## Scope and source

The custom-network backend now implements the predictive discrete-time pricing
algorithm supplied in `dynamic-ev-pricing/sim.py` and `network_engine.py`.
It supports both finite-horizon and equilibrium forecasts. This is a simulation
migration, not a connection to live city chargers or a completed city deployment.

Source files were read without modifying them. SHA-256 fingerprints at migration:

- `network_engine.py`: `F55641AA32D70634968B0A5CE845C3BF2132E15B37C3D100F1F4B5AFFCDCC020`.
- `sim.py`: `1EF923889EB22C3D930638B9DA091D90A752B2973AE6BE9112C2D4D607B32843`.

The source's command-line defaults are used, rather than the different defaults
in its Python `outer_loop()` signature. See the explicit defaults below.

## Previous approach: nested equilibrium pricing

Before this migration, each pricing iteration:

1. Held the current station prices fixed and solved the coupled traffic and
   route-choice ODE to an approximate equilibrium.
2. Recorded that nominal equilibrium and computed station profits.
3. Perturbed each station's own price upward and downward. Each of the 2m
   perturbations started from the nominal equilibrium and solved to another
   approximate equilibrium.
4. Estimated the coordinate derivative of equilibrium profit.
5. Updated all station prices using projected gradient ascent.
6. Repeated for at most `min(n_steps, max_outer_steps)` iterations, with early
   stopping after enough small price changes and converged inner solves.
7. Performed one additional equilibrium solve at the final prices.

For m stations and N pricing steps, the maximum solve count was
`N * (1 + 2*m) + 1`.

The equilibrium solver used BDF, relative tolerance 1e-8, absolute tolerance
1e-10, maximum step 10, and a default horizon of 75000. It integrated in
50-unit chunks and renormalized route allocations after every chunk. Its
stopping residual was the sum of the physical-state and route-state L2 norms:

`||x_dot||_2 + ||y_dot||_2 <= 1e-6`.

It used sparse Jacobian support, verified persistent equilibrium caching,
nearby cached warm starts, local restarts, and defensive failure metadata.
The current implementation did not multiply route adaptation by 20.
Some earlier README and methodology text described older numerical settings.

Road latency used discharge flow `a * x_total` divided by L. Routes used
class-filtered bounded alternatives with preview/balanced/research budgets:
preview 1/1/8, balanced 6/4/16, research 10/8/32 for segment alternatives,
station alternatives, and maximum paths per group, respectively.

The API's trajectory contained nominal equilibria indexed by pricing step.
It was not a continuous physical-time traffic trajectory, and `t_end` did not
control that trajectory.

This approach remains appropriate for stationary equilibrium experiments.
It assumes the traffic response settles before every pricing update, which
removes the transient response and limits the treatment of changing demand.

## Preserving the previous implementation

The existing working-tree versions, including pre-existing uncommitted
changes, were copied before replacing the active implementation:

- `backend/simulation/core/legacy_network_engine.py`: previous engine.
- `backend/simulation/pricing/legacy_strategic_pricing.py`: previous outer loop.
- `backend/simulation/pricing/equilibrium.py`: retained legacy inner solver.
- `backend/simulation/pricing/equilibrium_cache.py`: retained legacy cache.

Paper-network construction imports the legacy engine, and paper experiment
services import the legacy pricing loop. The paper endpoints therefore keep
their stationary research behavior.

The active engine inherits shared conservation, initialization, state-index,
and replicator machinery from the preserved engine. It overrides reference
routing, latency, path costs, and physical-time advancement. Sparse path-cost
summation is retained; results are numerically compared with the source.

## New approach: predictive discrete-time pricing

At time t_k, the state contains current road occupancies, station occupancies,
and route-allocation states. For each station s:

1. Construct candidate prices `psi_s+ = psi_s + delta` and
   `psi_s- = max(psi_s - delta, 0)`. Competitor prices remain fixed.
2. Forecast both scenarios from exactly the same current state and time.
3. Evaluate only that station's own forecast profit.
4. Estimate `g_s = (J_s+ - J_s-) / (psi_s+ - psi_s-)`.
5. After all gradients are available, update every station simultaneously:
   `psi_s <- max(psi_s + dt_outer * kappa * g_s, 0)`.
6. Advance the actual simulated network by one interval h at the updated prices.
7. Record the new state and prices at `t_(k+1) = t_k + h`.

There is no nominal equilibrium solve before forecasting and no extra
equilibrium solve after the final pricing step. No early stopping for stable
prices is applied. The run performs `round(t_end / h)` steps, matching Python
rounding in the source; when the ratio is not integral, the realized duration
may differ from the requested duration. Both durations are reported.

### Forecast modes

- Integer `ctrl_horizon = H`: advance each candidate scenario H intervals,
  with constant candidate prices. Samples occur at t+h through t+H*h.
  `profit_mode = "end"` uses the last sample's profit.
  `profit_mode = "mean"` uses the arithmetic mean of those sample profits.
  This is not an integrated or discounted profit objective.
- `ctrl_horizon = "eq"`: use the reference single-window BDF equilibrium
  solver starting at the current absolute time and state. The event checks
  the split L2 residual against 1e-6, with `eq_t_max` as maximum duration.
  Horizon exhaustion produces explicit warnings. The actual traffic still
  advances only h units after the price update.

An equilibrium forecast may stop before a future scheduled demand change if
it becomes stationary first, as in the source. It should not be interpreted
as a forecast covering every future switch.

### Physical model and routes

Road occupancy evolves by arrivals minus `a*x`. Station service is
`min(a_s*x_s, mu_s)`. Route preferences evolve by replicator dynamics:

`y_dot_p = eta*y_p*(weighted_average_cost - path_cost_p)`.

Physical path flow is `q_p(t) = demand_group(t)*y_p/sum(y)`, so changing
demand scales the route allocation without requiring y to equal current
demand. No legacy simplex projection is inserted into this loop.

Road latency now follows the supplied engine's occupancy formula:
`l0 * (x_total/L) / (1-x_total/L)`, clipping the ratio below one.
The discharge coefficient a still affects road departures, but no longer
multiplies occupancy in the latency function.

Reference route construction selects up to five road-only routes for NEVs
and one shortest-prefix/station/shortest-suffix route per reachable EV station.
Routes pass a cutoff of twice the shortest road-only OD cost, using l0 on
roads and phi0 on station links. Accuracy-profile settings do not alter this
reference strategy set.

BDF windows use rtol=1e-8, atol=1e-10 and max_step=min(h,10).
At window endpoints, physical states are floored at zero and route allocations
at 1e-12, matching `advance()` in the supplied engine.

## What changed and why

| Area | Previous behavior | New behavior and reason |
|---|---|---|
| Price objective | Equilibrium profit | Forecast endpoint/mean profit; captures transient response |
| Actual state | Nominal equilibrium per iteration | One physical-time step after each update |
| Demand | Constant JSON demand | Constant or scheduled step changes at absolute simulation time |
| Step count | n_steps and stable-price early stopping | round(t_end/h), matching the reference |
| Trajectory | Equilibrium snapshots indexed by k | Actual state history at 0,h,...,N*h |
| Inner solver | Cached, chunked, projected equilibrium | BDF windows; separate single-window equilibrium forecasts when selected |
| Road latency | a*x_total/L saturation ratio | x_total/L, matching the supplied physical model |
| Routes | Accuracy-profile route budgets | Reference shortest routes and 2x cutoff |
| Bounds | API price cap 3 and gradient clip 5 | Both optional, disabled by default |
| Metrics | Profit, occupancy, throughput | Adds revenue, queues, route allocations, used-path cost spreads, runtime and forecast count |
| Fixed-price comparison | Settled fixed-price state | Same initial state and physical duration as strategic pricing |
| Paper experiments | Current equilibrium implementation | Preserved legacy implementation |
| UI | Equilibrium wording and step axes | Physical-time axes, prediction controls, dynamic endpoint wording |

## Explicit API safeguards and extensions

The pricing algorithm and integration settings match the reference. These
backend adaptations are deliberate and covered by tests:

- Explicit road/station class restrictions are honored; the CSV script's route
  graph did not enforce them.
- If a road-only OD connection does not exist but an EV charging route does,
  the cutoff baseline is the cheapest charging-enabled route. This preserves
  the demand-stress scenario's valid charging-only connections instead of
  silently dropping their demand. Affected groups are reported in
  `quality.route_cutoff_fallback_groups`.
- All configured stations retain occupancy states, including unused stations,
  so serialization and profit reporting cannot fail on missing states.
- Unreachable demanded groups fail clearly instead of silently disappearing.
- Invalid schedules, horizon settings, unknown initial-price stations, and
  initial prices outside optional bounds fail validation.
- Station names conflicting with reference history keys are rejected.
- A partial per-station `psi0` map is supported, with missing stations defaulting
  to 0.5. The reference CLI starts every station at 0.5.
- An explicitly configured price cap constrains perturbations and updates;
  gradient clipping is applied only when requested.
- Process pools use Windows-compatible spawn and are bounded across concurrent
  API jobs. Failure retries the same forecast batch serially and reports why.
- Responses are JSON-safe and continue using the asynchronous job API.
- The frontend CSV importer accepts the reference column aliases and schedules.
- Plot-file generation and the CLI's separate final fixed-price summary run are
  not invoked by `/simulate`: its endpoint and final animation frame are the
  same state. The fixed-price continuation remains available through
  `simulate_discrete()`.

Numerical parity means agreement within floating-point tolerance, not
byte-identical output. Sparse summation, path IDs and state ordering can differ.

## Defaults and API usage

| Setting | Default |
|---|---|
| t_end | 75000 |
| h | 1500 |
| ctrl_horizon | 10 |
| profit_mode | end |
| kappa | 0.1 |
| delta | 0.02 |
| dt_outer | 1 |
| eq_t_max | 75000 |
| psi_max / grad_clip | null / null |
| parallel | null: enabled automatically only for equilibrium forecasts |
| n_workers | null: min(2*station_count, CPU count) |
| psi0 | null: 0.5 at every station |

POST `/api/simulate` with the usual network and:

```json
{
  "simulation_options": {
    "t_end": 75000,
    "h": 1500,
    "ctrl_horizon": 10,
    "profit_mode": "end",
    "parallel": null,
    "psi_max": null,
    "grad_clip": null
  }
}
```

For a small smoke run, use `t_end=4`, `h=2`, `ctrl_horizon=2`,
`parallel=false`. This changes the simulated duration and objective horizon;
it is a test configuration, not an accuracy-equivalent replacement.

An OD schedule is encoded as:

```json
{"name":"OD1","origin":"O1","dest":"D1","lam":1,
 "shares":{"EV":0.6,"NEV":0.4},"demand_schedule":"20000:1.5;40000:0.8"}
```

Schedules use the same time units as h and t_end. Switches are sorted; values
and times must be finite and nonnegative.

Old `n_steps`, `max_outer_steps`, `outer_tolerance`,
`stable_outer_steps`, and `accuracy_mode` request fields remain accepted for
client compatibility but do not control predictive stepping, early stopping,
or route budgets. Set t_end, h and ctrl_horizon explicitly when migrating an
old client. In particular, an old t_end=50 with default h=1500 fails because it
rounds to zero steps; it is not silently converted to the old 30-step run.

`/api/equilibrium` retains its URL/response envelope for compatibility but now
returns the predictive run's final summary. The historical `equilibrium`
response key carries `result_kind="dynamic_endpoint"`. Its residual and
`converged` are endpoint diagnostics; `quality.certified` is always false
for this predictive loop. Finite-horizon transients are expected and are not
reported as failed equilibrium solves.

`outer_history` includes k, physical times, station metrics, revenue, queues,
allocation histories and used-path cost spreads. `trajectory` includes
physical-time flows and costs. Price history has N+1 frames; outer metrics have
N post-update samples.

## Runtime and city deployment implications

The reference defaults run 50 updates, with 2m forecasts and one actual
advancement per update. Five stations therefore require 500 forecasts and
50 actual integrations. Finite-horizon forecasts run for 15000 units each,
and max_step=10 imposes at least 1500 internal steps per forecast. The default
finite-horizon run is serial unless parallel=true is requested.

No full-default runtime claim is made. Short two-step smoke runs on bundled
networks were around 1.3-1.5 seconds in this environment; that does not estimate
a 75000-unit city run. Responses expose measured pricing-loop wall time,
excluding network construction and serialization.

District decomposition, reduced city models, live telemetry ingestion,
operator tariff publishing, persistent distributed jobs, energy-based
charging economics, and latency-budget policies remain future deployment
work. They are not silently introduced as changes to this reference algorithm.

## Verification

Run the normal backend suite from backend:

```powershell
pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
```

To additionally compare with the unchanged supplied scripts:

```powershell
$env:EVCS_REFERENCE_DIR = 'C:\Users\PALLAB\Desktop\dynamic-ev-pricing'
python -m unittest discover -s tests -v
```

Reference tests cover endpoint profit, sample-mean profit, scheduled demand,
equilibrium forecasts, price histories, station metrics and physical states.
Other tests cover the job API, invalid inputs, process-parallel equivalence,
physical-time serialization, optional bounds, unused stations, all bundled
OD groups, class permissions, road-only demand, reference latency and preserved
paper-model imports. All 20 tests passed with the external parity tests enabled.

Frontend verification:

```powershell
cd frontend
npm run build
```

The earlier methodology .tex/.pdf describes the historical equilibrium
approach. This Markdown file is the current migration record; the existing PDF
was not regenerated or presented as describing the new algorithm.

