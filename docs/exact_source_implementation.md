# Exact supplied-script implementation

Date: 2026-10-24.

## Source of truth

`backend/network_engine.py` and `backend/sim.py` are byte-for-byte copies of:

- `C:/Users/PALLAB/Desktop/dynamic-ev-pricing/network_engine.py`
- `C:/Users/PALLAB/Desktop/dynamic-ev-pricing/sim.py`

SHA-256:

| File | Hash |
|---|---|
| network_engine.py | F55641AA32D70634968B0A5CE845C3BF2132E15B37C3D100F1F4B5AFFCDCC020 |
| sim.py | 1EF923889EB22C3D930638B9DA091D90A752B2973AE6BE9112C2D4D607B32843 |

Neither source file is patched, monkey-patched, or regenerated at runtime.
The complete CLI, plotting functions, derivative diagnostics, demand classes,
network builder, simulation functions and console summary remain available.
No dependency on the external desktop directory is required after copying.

## Integration

`simulation/core/network_engine.py` re-exports the original class and functions.
`simulation/scenarios/loader.py` translates JSON into original add_road,
add_station and add_od calls, then calls the original build method.
`simulation/scenarios/demand.py` re-exports the original demand classes.

`simulation/pricing/strategic_pricing.py` calls original sim.outer_loop. A
subclass observes successful actual advance calls to publish job progress;
its override delegates directly to the original method with unchanged
arguments and returns its unchanged result. It does not observe forecasts as
actual steps. Callbacks are excluded from worker pickles. Source calculations,
including process-global worker initialization, are otherwise untouched.
An API lock serializes calls because the original serial worker network is
global. That avoids contamination between simultaneous simulation requests.

The API result adds diagnostic metadata, skipped-group warnings and physical
times. These additions do not feed back into source calculations. The original
raw result is retained for plotting. Unknown per-forecast convergence diagnostics
are null rather than fabricated as zero failures.

`app/services/reference_outputs.py` invokes the original CLI plotting functions
and final simulate_discrete continuation. All plots are downloadable; the final
traffic trajectory and metrics are returned separately from pricing results.
The default final duration is 500, rounded upward by the original method.
For h=1500, this produces one 1500-unit continuation, exactly as the CLI does.

The API follows CLI defaults (h=1500, endpoint profit); the pricing adapter's
Python function defaults follow the original Python signature (h=10, mean
profit). Explicit arguments are used when comparing these entry points.

## Differences from the previous adapter

- Removed inherited legacy engine equations and sparse path-cost replacement
  from custom-network execution; the original implementation is called directly.
- Removed class-filtered route graphs, lowest-weight parallel-road collapsing,
  charging-only cutoff fallback, added unused-station states and alternative
  path identifiers. Original route graph insertion order and state order apply.
- Removed the alternate equilibrium forecast implementation and automatic
  process-pool serial fallback from custom-network execution.
- Removed upper-price caps and per-station initial-price maps. A non-null legacy
  psi_max or dictionary psi0 is rejected. Source gradient clipping is supported.
- Uniform initial price defaults to 0.5, including EV-adoption sweeps. Station
  initial_psi remains ignored by outer_loop, preserving original behavior.
- Added all original plotting outputs, console summary, and final continuation.
- Both simulation prechecks and the standalone validation endpoint now perform
  structural validation. Invalid input rejection does not add/change states.

Original quirks are preserved: class labels do not constrain routes; charging-
only OD connections are skipped; a parallel road added last replaces an earlier
road in the route-search DiGraph; future demand switches can be missed if an
equilibrium forecast stops first. The API reports skipped demanded groups.
Unused stations are rejected before a job because source metrics require their
occupancy states; the original CLI instead fails on those configurations.

Main dashboard animation and endpoint metrics remain the pricing run. Separate
final_traffic data explicitly represents the CLI's fixed-price continuation.
The original PNG plots are linked in Raw Data; save_plots=false skips only plot
output, while final_t configures the continuation. Model parameters and source
stepping are unchanged by output controls.

Paper-reproduction endpoints and their legacy modules remain separate. They
are additional research workflows, absent from the two supplied files.

## Validation scope

Regression tests compare full pricing state histories, price histories and
station metrics with the originals, including all seven bundled networks,
parallel roads, class labels, both forecast profit modes, demand switches and
equilibrium forecasts. Hash assertions protect source integrity. Other tests
exercise job/API behavior, parallel equivalence, original plots, download path
validation, and final continuation.

Short runs establish implementation parity, not proof of convergence or a
runtime estimate for the 75000-unit defaults. No default-duration performance
or equilibrium certification claim is made.
