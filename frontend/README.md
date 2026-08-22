# Frontend — EV Dynamic Pricing Lab

Vite + React 18 + TypeScript. Network diagram via `@xyflow/react`, charts
via `recharts`.

## Run

```bash
npm install
npm run dev
```

Defaults to talking to a backend at `http://localhost:8000`. Override with
`VITE_API_BASE` (copy `.env.example` to `.env`) if your backend runs
elsewhere.

## Layout

```
src/
  api.ts              backend client, incl. the job-submit/poll pattern
  types.ts             types mirroring the backend's pydantic schemas exactly
  App.tsx               top-level state: scenario, options, active job/progress, tabs
  components/
    ControlsPanel.tsx        scenario + full parameter set (collapsible advanced/solver sections)
    NetworkGraph.tsx         auto-layout topology diagram, 4 view modes, hover/click detail
    StationCards.tsx         per-station equilibrium summary cards
    PricingDynamics.tsx      outer-loop price/throughput/occupancy/profit vs. iteration
    RouteChoice.tsx          per-OD/class path flows, costs, Wardrop gap
    StationAnalysis.tsx      per-station time series incl. K_s saturation threshold
    EVAdoption.tsx           beta-sweep controls + charts
    StrategicVsFixed.tsx     strategic-NE vs. uniform-fixed-price comparison table
    PaperReproduction.tsx    the paper's 3 experiments, reproduced live
    ModelExplanation.tsx     static educational content (formulas, closed-loop diagram)
    LineSeriesChart.tsx      shared multi-series chart used by several tabs above
  utils/
    layout.ts           BFS-layered auto-layout (generalizes to any topology, not just the 3 bundled scenarios)
    colors.ts           consistent per-station color assignment
    export.ts           JSON/CSV download helpers
```

## CSV network import

The Network controls panel accepts three CSV files, validates them locally,
then calls the backend topology validator before enabling the generated JSON
for simulation.

```text
roads.csv    required: u,v       optional: classes,l0,L,a
station.csv  required: u,v,name  optional: classes,mu_s,a_s,c_s,phi0
ods.csv      required: name,origin,dest,lam,EV,NEV
```

`classes` uses `|` or `;` as its separator. OD shares may alternatively use
generic `share_<class>` columns. Empty optional cells inherit the active
network defaults. On success, the generated network can be loaded directly or
downloaded as `network.json`.

Ready-to-import examples are stored under `examples/`. The exact topology
used by the paper reproduction is in `examples/paper-network/`; select
**Paper defaults** before importing it so the global `alpha`, `gamma`, and
`eta` values also match the experiment.

## Notes on the design

The original prototype in this repo used a dark, neon "crypto dashboard"
aesthetic. That's a deliberate mismatch with the project brief (which asks
explicitly for something calm and academic — off-white backgrounds, light
grey panels, one restrained accent, a second muted accent only for the
EV/NEV distinction), so the visual theme in `styles.css` was rebuilt to
match the brief; the component architecture and interaction patterns from
the original prototype were kept.
