# EV Dynamic Pricing Lab

A research dashboard for the tri-level EV charging-station pricing model
(traffic dynamics + replicator route choice + gradient-flow station pricing),
based on Hota, *"Game-Theoretic Modeling of Competitive Electric Vehicle
Charging Stations with Strategic Users on a Traffic Network."*

- **backend/** — FastAPI service wrapping the original simulation engine.
- **frontend/** — Vite + React + TypeScript dashboard.

See `backend/README.md` and `frontend/README.md` for details on each half.
Below is the fastest path to running the whole thing locally.

## Quick start (development, two servers)

Requires Python 3.11+ and Node 18+.

```bash
# Terminal 1 — backend
cd backend
python3 -m venv .venv && source .venv/bin/activate     # optional but recommended
pip install -r requirements.txt --break-system-packages  # drop the flag in a venv
uvicorn app.main:app --reload --port 8000

# Terminal 2 — frontend
cd frontend
npm install
npm run dev
```

Open the URL Vite prints (default `http://localhost:5173`). The frontend
talks to `http://localhost:8000` by default (see `frontend/.env.example` if
you need to point it elsewhere) and the backend's default CORS allowlist is
exactly `http://localhost:5173`, so the two defaults match out of the box.

## Single-service mode (production-style)

FastAPI will serve the built frontend directly if `frontend/dist` exists,
so the whole app can run as one process:

```bash
cd frontend && npm install && npm run build && cd ..
cd backend
pip install -r requirements.txt --break-system-packages
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Then open `http://localhost:8000` — no separate frontend server needed.

## Deploying (e.g. Heroku)

The `Procfile` in `backend/` is set up for this single-service pattern:

```
web: uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${WEB_CONCURRENCY:-2}
```

1. Build the frontend (`npm run build` inside `frontend/`) and make sure
   `frontend/dist` is present in whatever you deploy (commit it, or run the
   build as part of your CI/deploy step before `git push heroku main`).
2. Deploy the repo root (with `backend/Procfile` at `backend/Procfile` —
   point your platform's app root at `backend/`, or move the Procfile to
   the repo root and adjust the `cd` accordingly).
3. Set `CORS_ORIGINS` if you're *not* using single-service mode (e.g. if the
   frontend is hosted separately on Vercel/Netlify) — otherwise the default
   same-origin setup needs no CORS configuration at all.

Because the async job pattern (see backend README) keeps every HTTP request
short, this comfortably fits Heroku's ~30s router timeout even though the
underlying ODE solving can take much longer.

## What's implemented vs. deferred

Implemented: interactive network diagram with auto-layout and four view
modes, live station cards, all three bundled scenarios plus a validated
custom-network JSON path, the full parameter set, async job progress, and
eight dashboard tabs (Network Dynamics, Pricing Dynamics, Route Choice,
Station Analysis, EV Adoption, Strategic vs Fixed, Paper Reproduction,
Model Explanation) plus a Raw Data / JSON+CSV export tab.

Deliberately deferred (flag if you want these built out next): a drag-and-
drop custom-network *builder* UI (today you can validate/simulate arbitrary
JSON, but there's no visual editor for it), WebSocket/SSE push (progress
uses polling instead, which was simpler and just as effective at this
scale), and PNG/SVG chart export (JSON/CSV export is in).
