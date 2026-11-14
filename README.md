# EV Dynamic Pricing Lab

A simulator and web dashboard for studying how competing electric-vehicle (EV)
charging stations set their prices on a traffic network, when drivers choose
their routes in response to congestion, queues and price.

This is a B.Tech project by Pallab Biswas at the Indian Institute of
Technology Kharagpur, supervised by Prof. Ashish Ranjan Hota. It implements the supervisor's
game-theoretic model and runs his two reference simulation scripts unchanged.

## What the model does

Three things evolve together on one road network:

| Layer | What changes | How |
|---|---|---|
| Traffic | Vehicles on each road and at each station | Conservation equations; a station serves at most a fixed rate, and a queue forms above that |
| Route choice | Share of each trip's demand on each route | Drivers shift gradually to cheaper routes (replicator dynamics) until used routes cost the same |
| Pricing | Price charged by each station | Each station forecasts its profit under a slightly higher and a slightly lower price, then moves its price in the better direction |

EVs must pass through one charging station; other vehicles use roads only. A
route's cost is road delay plus, for EVs, the station's waiting time and price.
Prices are updated once per pricing interval, and all stations update together.

## Quick start

You need **Python 3.11 or later** and **Node 18 or later**. Open two terminals
in the project folder. The commands below are for Windows PowerShell.

**Terminal 1: backend**

```powershell
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
```

**Terminal 2: frontend**

```powershell
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173>. The two `install` commands are only needed the
first time.

On macOS or Linux the commands are the same, with `python3` in place of
`python`. API documentation is at <http://localhost:8000/docs> while the
backend is running.

## Using the dashboard

1. Choose a bundled network from the list on the left, or import your own.
2. Adjust the EV share, demand and model parameters if you wish.
3. Press **Run simulation** and wait for the progress bar to finish.
4. Read the results in the tabs.

| Tab | Shows |
|---|---|
| Network Dynamics | The network over time, with traffic, latency and live station cards |
| Pricing Dynamics | Price, throughput, profit and revenue of each station |
| Route Choice | Route shares and route costs for each trip, and how close they are to equilibrium |
| Station Analysis | Detailed figures for each station |
| EV Adoption | A sweep over the EV share of demand |
| Strategic vs Fixed | Strategic prices compared with one uniform price at their mean |
| Paper Reproduction | The three reference experiments on the two-trip reference network |
| Model Explanation | The equations and what each symbol means |
| Raw Data | JSON and CSV export, and the plots written by the reference script |

**Run time.** A default run (`t_end = 75000`, `h = 1500`, 50 price updates)
takes from under a minute to a few minutes on the five-station networks, and
about 15 minutes on Sioux Falls, on a laptop. To check that everything works, lower the total time and pricing
interval in the solver settings first. Only one run is accepted at a time.

## Bundled networks

| File in `backend/networks/` | Roads | Stations | Trips | Purpose |
|---|---|---|---|---|
| `i.json` | 14 | 5 | 3 | Base network: each trip has a station on its direct corridor and can reach stations on cross links |
| `i2.json` | 14 | 5 | 7 | Base network plus four EV-only trips with no road-only path (skipped, with a warning) |
| `i3.json` | 18 | 5 | 3 | Extra cross links, so every trip can reach more stations |
| `i4.json` | 2 | 1 | 1 | Smallest sanity test |
| `network_o1_r1_s1.json` | 8 | 3 | 2 | Two-trip, three-station reference network |
| `network_ods_roads_stations.json` | 76 | 6 | 6 | A larger custom network |
| `sioux_falls_24node_6station.json` | 76 | 6 | 6 | The 24-node Sioux Falls benchmark with six stations |

## Importing your own network

In the dashboard, open **CSV network import** and supply three files. Working
examples are in `frontend/examples/`.

| File | Columns |
|---|---|
| `roads.csv` | `u,v,classes,l0,L,a` |
| `station.csv` | `u,v,name,classes,mu_s,a_s,c_s,phi0` |
| `ods.csv` | `name,origin,dest,lam,EV,NEV` |

Separate vehicle classes with `|` or `;`, for example `EV|NEV`. The network is
validated before it runs. A network in the same JSON form as the bundled files
is also accepted.

## Running from the command line

The reference script can be run directly, without the dashboard:

```powershell
cd backend
python sim.py roads.csv stations.csv ods.csv --t-end 75000 --h 1500 --horizon 1 --profit-mode end
```

The command-line CSV format differs from the dashboard's: it uses the columns
`station_id`, `od_name`, `total_demand`, `ev_share`, `nev_share` and
`demand_schedule`, with comma-separated classes. A demand schedule such as
`20000:1.5;40000:0.8` sets the demand to 1.5 from time 20000 and to 0.8 from
time 40000.

## Running as one service

FastAPI serves the built frontend when `frontend/dist` exists, so the whole
application can run as one process on one address:

```powershell
cd frontend
npm install
npm run build
cd ..\backend
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Then open <http://localhost:8000>. With Docker:

```powershell
docker build -t ev-pricing-lab .
docker run -p 8000:8000 ev-pricing-lab
```

Run exactly one instance with one worker, because running jobs are kept in
memory. The [hosting guide](docs/hosting.md) covers deployment on Render.

## Project layout

```text
backend/
  network_engine.py     reference script: network, routes, traffic equations (unchanged)
  sim.py                reference script: pricing loop, plots, command line (unchanged)
  networks/             the seven bundled networks
  simulation/           adapters around the reference scripts, scenario loading and validation
  app/                  FastAPI application: routes, request schemas, job and streaming services
frontend/
  src/                  React and TypeScript dashboard
  examples/             sample CSV networks for import
docs/                   implementation notes and the hosting guide
Dockerfile, render.yaml single-service deployment
```

More detail is in [backend/README.md](backend/README.md) and
[frontend/README.md](frontend/README.md).

## Things to know about the model

These behaviours come from the reference scripts and are kept on purpose.

- **Bounded routes.** Each trip gets at most five road-only routes, and one EV
  route per reachable station, all within twice the shortest free-flow cost.
- **Skipped trips.** A trip with no road-only path is left out entirely and
  reported as a warning.
- **Unused stations.** A network with a station that lies on no route is
  rejected.
- **Starting price.** Every station starts at the same price (0.5 by default),
  and there is no price cap.
- **Defaults.** The dashboard uses a look-ahead of one pricing interval with
  parallel forecasts. The command line uses a look-ahead of ten.

The two reference scripts are byte-for-byte copies, checked by their SHA-256
digests. See the [implementation record](docs/exact_source_implementation.md).

## Configuration

| Variable | Effect |
|---|---|
| `VITE_API_BASE` | Backend address used by the frontend build. Defaults to `http://localhost:8000` in development |
| `CORS_ORIGINS` | Comma-separated list of frontend addresses the backend accepts. Defaults to `http://localhost:5173` |
| `VITE_SHOW_ENERGY_TAB=1` | Shows the Solar & Battery tab (see below) |

Copy `frontend/.env.example` to `frontend/.env` to set the frontend variables.

## Solar and battery model (future work)

A separate model in `backend/simulation/energy/` gives each site fast and slow
chargers, optional solar panels and a battery, and a grid tariff that varies
through the day. It is not part of the project's reported results, and its
dashboard tab is hidden by default. To see it, open the dashboard with
`?energy=1` added to the address, or set `VITE_SHOW_ENERGY_TAB=1`. It also runs
from the command line:

```powershell
cd backend
python -m simulation.energy.cli energy_networks/two_od_solar_battery.json --t-end 96 --parallel
```

## Further documentation

- [Implementation record](docs/exact_source_implementation.md): how the
  reference scripts are integrated and verified.
- [Problem statement and methodology (PDF)](docs/problem_statement_and_methodology.pdf):
  a formal statement of the earlier nested-equilibrium formulation.
- [Hosting guide](docs/hosting.md): Render deployment and Docker.
