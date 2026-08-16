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

`simulation/core/network_engine.py` has exactly one intentional change from
the supplied file — the latency formula now includes the outflow-rate
factor `a_i` that the paper's own definition requires (invisible under every
bundled scenario, since they all use `a=1.0`, but would silently diverge
from the paper for a custom network with `a != 1`). Everything else in that
file is unchanged.

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
