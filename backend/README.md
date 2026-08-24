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

## Unified optimized equilibrium approach

### Persistent reuse and caching

Repeated requests reuse work at two levels:

- An in-memory LRU cache (16 topologies) reuses the constructed NetworkX graph,
  bounded route set, state indices, and lazily computed Jacobian sparsity.
- A persistent SQLite equilibrium bank stores up to 512 converged states per
  network/profile fingerprint in `backend/.cache/equilibria.sqlite3`.

An exact network/price/tolerance hit is never trusted blindly: its ODE residual
and route-flow conservation error are recomputed before integration is skipped.
For a nearby price vector, the closest stored state within RMS price distance
0.35 is only a BDF warm start; a fresh integration and convergence check are
still mandatory. Failed or non-finite solves are never cached. Cache keys also
contain a model-version string, full canonical network configuration, route
profile, and solver tolerance, preventing incompatible results from being
reused. Set `EVCS_CACHE_PATH` to relocate the SQLite file.

### Accuracy profiles

Simulation requests expose an `accuracy_mode` with three explicit trade-offs:

| Profile | Maximum routes per OD/class | Inner horizon | Price gradient |
|---|---:|---:|---|
| `preview` | 8 | up to 1000 | coordinate central differences |
| `balanced` | 16 | up to 1000 | coordinate central differences |
| `research` | 32 | up to 1000 | coordinate central differences |

`preview` is the default because large Research runs can take minutes per
pricing step. Use `research` for final reported results and run it as a
background/offline calculation; the API continues to publish job progress.

Profiles now differ only in their candidate-route budgets. Every network and
profile uses a chunked inner solve of up to 1000 time units and coordinate
central differences. The inner solve stops early when the sum of the physical-
state and route-flow L2 derivative norms is below `1e-6`. `research` remains
the strictest route-set estimate. The
response includes a quality block with route-cap hits,
inner residuals, path-flow conservation error, gradient method, and a
`certified` flag. A run is certified only when every nominal and
gradient-perturbation solve meets tolerance, no OD/class group reaches an
internal candidate-route cap, and the final outer-loop price change is at most
`1e-4`.

`n_steps` is the maximum requested outer-loop iteration count (also bounded by
`max_outer_steps`). The loop stops early after `stable_outer_steps` consecutive
fully converged iterations whose projected price change is at most
`outer_tolerance`.

The original builder enumerated every simple path for every OD pair and
vehicle class. That works for the small paper topology, but path counts grow
combinatorially on cyclic road networks. The bundled 24-node, 76-road,
6-station network has approximately 66,512 EV paths and 20,759 NEV paths
under unrestricted enumeration, producing roughly 87,000 route-flow states.

The backend now uses the following strategy for every network size.

- The interactive `preview` profile keeps one best road prefix and suffix per
  reachable station, preserving station competition without enumerating
  alternative segments that will not be displayed.
- Each class-filtered road graph is constructed once per network build, and
  repeated origin/station/destination segment queries reuse cached paths.
- Path search stops immediately after collecting the requested number of
  paths; it does not generate an extra path solely to detect truncation.

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

Path costs are also compiled into a sparse path-link incidence matrix when the
network is built. During every ODE evaluation, each unique road/station cost is
computed once and all path costs are obtained with one sparse matrix-vector
product instead of recomputing a road latency for every path that uses it.

### 3. Chunked integration and route-flow projection

Replicator dynamics normalize average cost by the current route-flow sum, so
their vector field preserves each group's total even after a small numerical
deviation. BDF can still introduce minor simplex error near a boundary.

`solve_equilibrium()` advances BDF in 50-time-unit chunks until
`||x_dot||_2 + ||y_dot||_2` is below `1e-6` or the requested maximum horizon
is reached.
For equilibrium integration only, route-choice derivatives are time-scaled by
20 so small price perturbations do not require thousands of simulated time
units to settle. This positive scaling does not change fixed points, and the
terminal residual is evaluated using the original unscaled model dynamics.
After every chunk it clips negative path flows and renormalizes every OD/class
group to its known demand, then re-evaluates the residual. A finite late BDF
failure resumes locally from its projected endpoint instead of discarding all
progress and repeating the full cold solve.

### 4. Warm-started pricing continuation

The first pricing solve is cold-started. Every later nominal and perturbed
solve starts from the preceding equilibrium estimate because consecutive
price profiles are close.

- Every cold, continuation, and perturbation solve uses the same configured
  maximum horizon (1000 time units by default) and split L2 terminal event.

Residual warnings remain visible in the API response and frontend.

### 5. Coordinate price-gradient estimation

Every network and accuracy profile uses the original station-by-station
central difference. Each pricing iteration requires `2S` perturbed equilibrium
solves for `S` stations. These independent solves run concurrently in a bounded
process pool while their results are consumed in the original deterministic
station order. Price bounds and gradient clipping remain applied. Set
`EVCS_GRADIENT_WORKERS` to choose the worker limit (default 4), or set
`EVCS_PARALLEL_GRADIENTS=0` to force serial execution. Unsupported custom
time-varying demand callables automatically fall back to serial execution.

### Accuracy and measured performance

Every mode computes an equilibrium estimate over a profile-bounded,
representative route set. It is not an exhaustive all-simple-path solution,
which is unsuitable for an interactive service. Research mode uses the
largest route budget. Runtime depends on CPU, solver tolerances, topology,
demand, station count, worker count, and the number of pricing steps. On the
development machine, the 212-state Preview model's RHS became about 3x faster,
a formerly failing 1000-unit inner solve fell from 52.15 seconds to 3.61
seconds, and a one-step four-worker coordinate-gradient benchmark was 2.26x
faster than serial with identical prices and final state. Use job progress
rather than assuming a fixed duration on other machines.

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
- `EVCS_GRADIENT_WORKERS` — maximum coordinate-gradient worker processes
  (default `4`)
- `EVCS_PARALLEL_GRADIENTS` — set to `0`/`false` to force serial gradients
