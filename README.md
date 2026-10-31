# EV Dynamic Pricing Lab

A research dashboard for the tri-level EV charging-station pricing model
(traffic dynamics + replicator route choice + gradient-flow station pricing),
based on Hota, *"Game-Theoretic Modeling of Competitive Electric Vehicle
Charging Stations with Strategic Users on a Traffic Network."*

- **backend/** â€” FastAPI service wrapping the original simulation engine.
- **frontend/** â€” Vite + React + TypeScript dashboard.

See `backend/README.md` and `frontend/README.md` for details on each half.
Below is the fastest path to running the whole thing locally.

## Project structure

```text
project/
|-- README.md                         # Project overview and setup instructions
|-- .gitattributes                    # Git file-handling rules
|-- .gitignore                        # Files excluded from version control
|-- backend/                          # FastAPI API and Python simulation engine
|   |-- README.md                     # Backend setup and API documentation
|   |-- requirements.txt              # Python dependencies
|   |-- Procfile                      # Deployment process command
|   |-- network_engine.py             # Original network simulation engine
|   |-- sim.py                        # Original CSV-based simulation CLI
|   |-- app/
|   |   |-- main.py                   # FastAPI entry point and frontend serving
|   |   |-- api/                      # HTTP route handlers
|   |   |   |-- routes_artifacts.py
|   |   |   |-- routes_jobs.py
|   |   |   |-- routes_paper.py
|   |   |   |-- routes_scenarios.py
|   |   |   `-- routes_simulate.py
|   |   |-- schemas/
|   |   |   `-- network.py            # Network and simulation request schemas
|   |   `-- services/                 # Job management and simulation orchestration
|   |       |-- jobs.py
|   |       |-- paper_service.py
|   |       |-- reference_outputs.py
|   |       `-- simulation_service.py
|   |-- networks/                     # Bundled network scenario JSON files
|   `-- simulation/
|       |-- core/                     # Network dynamics engines
|       |   |-- network_engine.py
|       |   `-- legacy_network_engine.py
|       |-- experiments/
|       |   `-- paper_experiments.py  # Paper reproduction experiments
|       |-- pricing/                  # Pricing, equilibrium solving and metrics
|       |   |-- equilibrium.py
|       |   |-- equilibrium_cache.py
|       |   |-- legacy_strategic_pricing.py
|       |   |-- metrics.py
|       |   |-- predictive_equilibrium.py
|       |   `-- strategic_pricing.py
|       `-- scenarios/                # Scenario loading and validation
|           |-- demand.py
|           |-- loader.py
|           `-- validation.py
|-- frontend/                         # React + TypeScript dashboard
|   |-- README.md                     # Frontend setup instructions
|   |-- .env.example                  # Example API connection settings
|   |-- package.json                  # Dependencies and npm scripts
|   |-- package-lock.json             # Locked dependency versions
|   |-- index.html                    # HTML entry point
|   |-- vite.config.ts                # Vite configuration
|   |-- tsconfig*.json                # TypeScript configurations
|   |-- examples/                     # Sample networks for CSV import
|   |   |-- medium-network/           # ods.csv, roads.csv, station.csv
|   |   `-- paper-network/            # ods.csv, roads.csv, station.csv
|   `-- src/
|       |-- main.tsx                  # React entry point
|       |-- App.tsx                   # Main dashboard and tab navigation
|       |-- api.ts                    # Backend API client
|       |-- types.ts                  # Shared TypeScript types
|       |-- styles.css                # Dashboard styles
|       |-- vite-env.d.ts             # Vite environment types
|       |-- components/               # Dashboard controls and analysis views
|       |   |-- ControlsPanel.tsx
|       |   |-- CsvNetworkImport.tsx
|       |   |-- EVAdoption.tsx
|       |   |-- LineSeriesChart.tsx
|       |   |-- ModelExplanation.tsx
|       |   |-- NetworkGraph.tsx
|       |   |-- PaperReproduction.tsx
|       |   |-- PricingDynamics.tsx
|       |   |-- ProgressOverlay.tsx
|       |   |-- RouteChoice.tsx
|       |   |-- StationAnalysis.tsx
|       |   |-- StationCards.tsx
|       |   `-- StrategicVsFixed.tsx
|       `-- utils/                    # Visualization, import and export helpers
|           |-- colors.ts
|           |-- csvNetwork.ts
|           |-- export.ts
|           `-- layout.ts
`-- docs/                             # Research and implementation documentation
    |-- exact_source_implementation.md
    |-- predictive_pricing_migration.md
    |-- problem_statement_and_methodology.tex
    `-- problem_statement_and_methodology.pdf
```

The tree omits Python package markers (`__init__.py`), generated files,
dependency folders, caches and local verification files. Frontend builds are
written to `frontend/dist/`, and simulation artifacts to `backend/.outputs/`.

Custom-network runs execute unchanged copies of the supplied `network_engine.py`
and `sim.py`, including their exact routes, ODE integration, predictive pricing,
original PNG plots and final fixed-price traffic continuation. Both files are
available in `backend/` and can also be run with the original CSV command line.
The dashboard provides the original plot downloads in Raw Data. See the
[exact-source implementation record](docs/exact_source_implementation.md) for
source hashes, behavior and verification. Paper experiments retain their
separate historical equilibrium model.

Defaults match the supplied CLI: `t_end=75000`, `h=1500`, a 10-interval forecast,
endpoint profit and a final fixed-price run of 500 requested time units. The
full default run can be expensive. Source routing skips OD pairs without a
road-only connection and does not enforce class labels; these behaviors now
apply exactly, with skipped demand reported in warnings.

## Quick start (development, two servers)

Requires Python 3.11+ and Node 18+.

```bash
# Terminal 1 â€” backend
cd backend
python3 -m venv .venv && source .venv/bin/activate     # optional but recommended
pip install -r requirements.txt --break-system-packages  # drop the flag in a venv
uvicorn app.main:app --reload --port 8000

# Terminal 2 â€” frontend
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

Then open `http://localhost:8000` â€” no separate frontend server needed.

## Hosting

Deploy the dashboard and API together using the root `Dockerfile` and
`render.yaml`. See [the hosting guide](docs/hosting.md) for Render setup,
local Docker commands, compute sizing, and job persistence limits.
Use exactly one instance and one Uvicorn worker.

## What's implemented vs. deferred

Implemented: interactive network diagram with auto-layout and four view
modes, live station cards, all seven bundled scenarios plus a validated
custom-network JSON path, the full parameter set, async job progress, and
eight dashboard tabs (Network Dynamics, Pricing Dynamics, Route Choice,
Station Analysis, EV Adoption, Strategic vs Fixed, Paper Reproduction,
Model Explanation) plus a Raw Data / JSON+CSV export tab.

Deliberately deferred (flag if you want these built out next): a drag-and-
drop custom-network *builder* UI (today you can validate/simulate arbitrary
JSON, but there's no visual editor for it), WebSocket/SSE push (progress
uses polling instead, which was simpler and just as effective at this
scale), and SVG chart export (original simulation PNGs and JSON/CSV export are available).
