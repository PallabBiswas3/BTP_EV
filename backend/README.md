# Backend — EV Dynamic Pricing Lab API

FastAPI service around the original research simulation code.

## Layout

```
app/
  main.py            FastAPI app, CORS, static-serves frontend/dist in prod
  api/                routers (scenarios, simulate, paper, jobs)
  schemas/            pydantic request/response models
  services/
    simulation_service.py   orchestrates build -> solve -> serialize
    paper_service.py        paper-network experiment reproductions
    jobs.py                 in-memory background job runner (see below)
simulation/
  core/network_engine.py    the math: traffic dynamics, replicator routing,
                             station buffer dynamics, path costs (preserved
                             from the original file; one documented fix, see
                             its module docstring)
  pricing/
    equilibrium.py          inner-loop ODE solve (heavily reworked for
                             performance + a numerical-stability fix — read
                             its module docstring, it's worth it)
    metrics.py               station/user-cost metrics
    strategic_pricing.py     outer gradient-flow pricing loop
  scenarios/loader.py        JSON scenario loading + build_network_from_data
  scenarios/validation.py    custom-network validation
  experiments/paper_experiments.py   the paper's exact fixed network
networks/                    i.json / i2.json / i3.json
```

## Why requests return a `job_id` instead of a result

A full pricing run is a chain of ODE solves (an outer gradient-ascent loop,
each step needing several inner traffic-equilibrium solves). Even after the
performance work described in `equilibrium.py`, that can take anywhere from
a few seconds to ~30-60s depending on network size and step count — too
long to block a synchronous POST, and past the hard timeout most hosts
(including Heroku, ~30s) enforce on a single request.

So `/api/simulate`, `/api/equilibrium`, `/api/beta-sweep`,
`/api/compare-pricing`, and `/api/paper/experiment{1,2,3}` all return
`{"job_id": "..."}` immediately. Poll `GET /api/jobs/{job_id}` for progress:

```json
{"job_id": "...", "status": "running", "phase": "Pricing iteration 7/30", "step": 7, "n_steps": 30, "result": null, "error": null}
```

`status` becomes `"done"` (with `result` populated) or `"error"` (with
`error` set). The job store is a simple in-process dict — fine for a single
uvicorn worker; swap it for a real queue (Celery/RQ + Redis) if you scale to
multiple workers/dynos, since jobs submitted to one worker aren't visible to
another.

## Endpoints

- `GET /api/health`
- `GET /api/scenarios`, `GET /api/scenarios/{id}` — bundled i/i2/i3 networks
- `POST /api/custom-network/validate` — synchronous, cheap; returns
  `{valid, errors[], warnings[]}` for any network JSON, including specific
  messages like "No feasible path found for OD 'OD1' class 'EV'..."
- `POST /api/simulate` → job → `{network, equilibrium, outer_history, trajectory}`
- `POST /api/equilibrium` → job → `{network, equilibrium, outer_history}` (no trajectory, cheaper)
- `POST /api/beta-sweep` → job → equilibrium swept over a beta range
- `POST /api/compare-pricing` → job → strategic NE vs. uniform fixed pricing
- `POST /api/paper/experiment{1,2,3}` → job → paper reproductions on the paper's fixed network
- `GET /api/jobs/{job_id}` — poll for status/progress/result

Interactive API docs are at `/docs` once the server is running.

## Notable engineering decisions (read before changing the math)

`simulation/pricing/equilibrium.py`'s module docstring documents four
changes made to the original `solve_equilibrium`/`outer_loop` and the
reasoning behind each — switching the integrator to BDF (matching what the
paper's methods section actually claims, and 2-5x faster than the RK45 the
supplied code used), removing a convergence-event that in practice never
fired, adding `y0` warm-starting, and — the one that matters most — a path-
flow renormalization that fixes a genuine numerical instability ("replicator
ODE overflow at high demand") this refactor traced to slow drift away from
the replicator dynamics' analytic conservation invariant. `t_max` defaults
were tuned against the *unmodified* original code as ground truth (see the
same docstring) to make sure none of this changed the actual equilibrium
values the paper reports, only how fast and how reliably they're reached.

`simulation/core/network_engine.py` also includes the latency correction,
bounded class-feasible path generation, and a cached sparse-Jacobian pattern.
These changes are documented below and in the module docstrings.

## Large-network equilibrium approach

### Accuracy profiles

Simulation requests expose an `accuracy_mode` with three explicit trade-offs:

| Profile | Maximum routes per OD/class | Inner horizons (cold/warm) | Price gradient |
|---|---:|---:|---|
| `preview` | 8 | 200 / 50 | simultaneous perturbation on large models |
| `balanced` | 16 | 500 / 150 | simultaneous perturbation on large models |
| `research` | 32 | 1000 / 300 | exact coordinate central differences |

`preview` is the default because large Research runs can take minutes per
pricing step. Use `research` for final reported results and run it as a
background/offline calculation; the API continues to publish job progress.

Small paper networks continue to use the calibrated 1000-unit horizon and
coordinate central differences in every profile. `research` is the strictest
available numerical estimate, but it is not labeled exact merely because it
ran longer: the response includes a quality block with route-cap hits, inner
residuals, path-flow conservation error, gradient method, and a `certified`
flag. A run is certified only when every nominal and gradient-perturbation
solve meets tolerance, no OD/class group reaches an internal candidate-route
cap, and the final outer-loop price change is at most `1e-4`.

For models above 200 states, `n_steps` is a minimum rather than a hard stop.
After that many iterations, pricing continues until the maximum station-price
change is at most `outer_tolerance` for `stable_outer_steps` consecutive fully
converged iterations. `max_outer_steps` is the required safety limit for a
network that never settles. The defaults are `1e-4`, 3, and 120 respectively,
and all three are editable in Solver settings. Small and paper networks retain
exactly `n_steps` iterations.

The original builder enumerated every simple path for every OD pair and
vehicle class. That works for the small paper topology, but path counts grow
combinatorially on cyclic road networks. The bundled 24-node, 76-road,
6-station network has approximately 66,512 EV paths and 20,759 NEV paths
under unrestricted enumeration, producing roughly 87,000 route-flow states.

The backend uses the following large-network strategy.

### 1. Bounded, class-feasible route sets

`ChargingNetwork.build()` retains a profile-dependent number of ranked
K-shortest simple paths for each `(OD, class)` population (8, 16, or 32).
It also enforces the paper's route definitions:

- An EV path contains exactly one charging-station access edge.
- An NEV path contains no charging-station access edge.

For each reachable EV station, the builder combines ranked road-only paths
from the origin to the station entrance with ranked road-only paths from the
station exit to the destination. Combinations that revisit a node are removed.
The shortest candidate through every reachable station is retained first;
remaining slots are filled by free-flow path cost. This prevents the nearest
station from consuming the entire route set.

For `network_ods_roads_stations.json`, the Preview model contains:

```text
110 road-density states
  6 station-occupancy states
 96 route-choice states
---
212 total ODE states
```

Network construction takes approximately 0.08 seconds on the development
machine.

### 2. Sparse BDF integration

The inner equilibrium still uses SciPy's BDF integrator. The network computes
and caches a structural Jacobian sparsity pattern and passes it to `solve_ivp`
as `jac_sparsity`. Network ODEs are sparse because a state interacts mainly
with nearby edges and paths in its OD/class group. Supplying this structure
avoids dense finite-difference Jacobian work on every solve.

### 3. Chunked integration and route-flow projection

Replicator dynamics analytically preserve
`sum(path flows) = OD/class demand`, but a long numerical solve can drift away
from that simplex and eventually make BDF fail with a required-step-size error.

`solve_equilibrium()` therefore integrates in 50-time-unit chunks. After each
chunk it clips negative path flows, renormalizes every OD/class group to its
known demand, and checks the equilibrium residual. It stops early when the
practical tolerance is reached. A failed warm start is retried from the
canonical initial state.

### 4. Warm-started pricing continuation

The first pricing solve is cold-started. Every later nominal and perturbed
solve starts from the preceding equilibrium estimate because consecutive
price profiles are close.

- Small and paper networks use the paper's calibrated 1000-unit horizon for
  every nominal and price-perturbation solve.
- Models with more than 200 states use the profile's cold horizon.
- Warm continuation and perturbation solves use the profile's warm horizon.

The shorter large-network horizons avoid spending most of the request driving
tiny route shares toward a numerically stiff boundary before prices adapt.
Residual warnings remain visible in the API response and frontend.

### 5. Adaptive price-gradient estimation

Small and paper networks retain the original coordinate-wise central
difference, which costs `2S` perturbed solves for `S` stations per pricing
iteration.

In Preview and Balanced, models with more than 200 states and more than three
stations use averaged simultaneous central perturbations (SPSA-style
estimates). Preview averages two independent directions and Balanced averages
four. Each Rademacher direction perturbs every station price up and down:

```text
psi_plus  = psi + delta * direction
psi_minus = psi - delta * direction

gradient_s ~= (profit_s(psi_plus) - profit_s(psi_minus))
              / (psi_plus_s - psi_minus_s)
```

The averaged gradient is exponentially smoothed (`0.75` previous plus `0.25`
new), and its gain follows `kappa / (k + 1)^0.602`; the perturbation follows
`delta / (k + 1)^0.101`. These standard diminishing SPSA schedules remove the
persistent fluctuation caused by a one-sample estimate with constant gain.
Research mode deliberately pays for the original coordinate-wise `2S`
perturbation solves. Price bounds and gradient clipping are still applied.
Convergence is checked against the projected update at the original full
`kappa`, not the diminished gain, so gain decay cannot create a false
convergence result.

### Accuracy and measured performance

Large-network mode computes a practical equilibrium estimate over a bounded,
representative route set. It is not an exhaustive all-simple-path solution,
which is unsuitable for an interactive service. Small and paper networks keep
their complete route sets and coordinate-wise gradients.

The stabilized Preview estimator now performs four perturbed solves per
pricing iteration (two averaged central directions), so measurements from the
former one-direction implementation are not comparable. Actual runtime
depends on CPU, solver tolerances, topology, demand, and the number of pricing
steps. Use the job progress response rather than assuming a fixed duration.

## Running tests / a quick smoke check

There's no formal test suite bundled (flag if you want one added), but a
fast manual sanity check:

```bash
uvicorn app.main:app --reload &
curl localhost:8000/api/health
curl localhost:8000/api/scenarios
```

## Environment variables

- `CORS_ORIGINS` — comma-separated allowed origins (default `http://localhost:5173`)
- `PORT` — used by the Procfile in production
- `WEB_CONCURRENCY` — uvicorn worker count in production (default **1**, and
  that default matters: the job store in `jobs.py` is an in-process dict, so
  a job submitted to worker A is invisible to a status poll that lands on
  worker B. Don't raise this above 1 unless you first swap `jobs.py` for a
  shared store — e.g. Redis, or even just SQLite — that all workers can see.)
