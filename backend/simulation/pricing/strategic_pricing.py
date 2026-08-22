"""
Outer-loop gradient-flow pricing dynamics (paper Sec. III-D / eq. 26-27).

Extracted from the duplicated `outer_loop()` in `simulator_paper.py` and
`simulator_paper_generalised.py`. The projected-gradient update, central
finite-difference gradient estimate, and psi_max/grad_clip safety bounds are
all unchanged. The one addition is warm-starting: each solve now reuses the
previous step's converged state as its starting point (for the nominal step
and for both perturbed evaluations), which is what the paper's Sec. III-B
describes but the original scripts didn't implement (see equilibrium.py).
"""
from dataclasses import dataclass, field

import numpy as np

from simulation.pricing.equilibrium import solve_equilibrium
from simulation.pricing.metrics import station_metrics


@dataclass
class OuterLoopResult:
    psi: dict
    state: "np.ndarray"
    profit: dict
    rho: dict
    occ: dict
    hist: dict
    state_history: list
    price_history: list
    converged: bool
    quality: dict
    warnings: list = field(default_factory=list)


def outer_loop(net, psi0=None, n_steps=30, kappa=0.1, delta=0.02,
                dt_outer=1.0, psi_max=3.0, grad_clip=5.0, t_max=1000.0,
                warm_t_max=50.0, accuracy_mode="preview", max_outer_steps=120,
                outer_tolerance=1e-4, stable_outer_steps=3, progress_cb=None):
    """Run the gradient-flow pricing outer loop.

    `progress_cb`, if given, is called as `progress_cb(step, n_steps)`
    after each outer step -- used to stream progress to a polling API
    client on long-running requests (see app/services/jobs.py).
    """
    stations = list(net.stations.keys())
    psi = dict(psi0) if psi0 else {s: 0.5 for s in stations}

    hist = {s: {"psi": [], "rho": [], "occ": [], "profit": []} for s in stations}
    warnings = []
    state = None
    state_history = []
    price_history = []
    # The paper/toy networks retain the calibrated 800-unit cold horizon.
    # Large route games use a bounded first estimate; a longer integration
    # both costs substantially more and pushes tiny route shares toward a
    # numerically stiff simplex boundary before pricing has begun adapting.
    profiles = {
        "preview": dict(cold=200.0, warm=50.0, simultaneous=True, samples=2),
        "balanced": dict(cold=500.0, warm=150.0, simultaneous=True, samples=4),
        "research": dict(cold=1000.0, warm=300.0, simultaneous=False, samples=0),
    }
    profile = profiles.get(accuracy_mode, profiles["preview"])
    cold_t_max = min(t_max, profile["cold"]) if net.N_STATES > 200 else t_max
    continuation_t_max = profile["warm"] if net.N_STATES > 200 else t_max
    use_simultaneous_gradient = (
        net.N_STATES > 200 and len(stations) > 3 and profile["simultaneous"]
    )
    gradient_rng = np.random.default_rng(0)
    smoothed_grad = None
    final_effective_kappa = kappa
    inner_results = []
    last_price_change = 0.0
    last_projected_price_change = 0.0
    is_large = net.N_STATES > 200
    max_steps = max(n_steps, max_outer_steps) if is_large else n_steps
    stable_steps = 0
    completed_steps = 0
    stop_reason = "fixed step count" if not is_large else "maximum step cap reached"

    for step in range(max_steps):
        step_inner_start = len(inner_results)
        step_t_max = cold_t_max if state is None else continuation_t_max
        eq = solve_equilibrium(net, psi, y0=state, t_max=step_t_max)
        inner_results.append(eq)
        state = eq.state
        state_history.append(state.copy())
        price_history.append(dict(psi))
        if not eq.converged:
            warnings.append(f"outer step {step}: {eq.message}")
        profit, rho, occ = station_metrics(net, psi, state)
        for s in stations:
            hist[s]["psi"].append(psi[s])
            hist[s]["rho"].append(rho[s])
            hist[s]["occ"].append(occ[s])
            hist[s]["profit"].append(profit[s])

        grad = {}
        if use_simultaneous_gradient:
            # Average several SPSA central differences. A single direction is
            # unbiased but has large cross-station variance, which produced
            # persistent price oscillation under a constant gain.
            grad_sum = {s: 0.0 for s in stations}
            perturbation = delta / ((step + 1) ** 0.101)
            for _ in range(profile["samples"]):
                direction = {
                    s: float(gradient_rng.choice((-1.0, 1.0))) for s in stations
                }
                psi_p = {
                    s: float(np.clip(psi[s] + perturbation * direction[s], 0.0, psi_max))
                    for s in stations
                }
                psi_m = {
                    s: float(np.clip(psi[s] - perturbation * direction[s], 0.0, psi_max))
                    for s in stations
                }
                eq_p = solve_equilibrium(net, psi_p, y0=state, t_max=continuation_t_max)
                eq_m = solve_equilibrium(net, psi_m, y0=state, t_max=continuation_t_max)
                inner_results.extend((eq_p, eq_m))
                profit_p, _, _ = station_metrics(net, psi_p, eq_p.state)
                profit_m, _, _ = station_metrics(net, psi_m, eq_m.state)
                for s in stations:
                    denom = psi_p[s] - psi_m[s]
                    estimate = (
                        (profit_p[s] - profit_m[s]) / denom
                        if abs(denom) > 1e-9 else 0.0
                    )
                    grad_sum[s] += estimate
            raw_grad = {
                s: float(np.clip(grad_sum[s] / profile["samples"], -grad_clip, grad_clip))
                for s in stations
            }
            if smoothed_grad is None:
                smoothed_grad = raw_grad
            else:
                smoothed_grad = {
                    s: 0.75 * smoothed_grad[s] + 0.25 * raw_grad[s]
                    for s in stations
                }
            grad = dict(smoothed_grad)
        else:
            for s in stations:
                psi_p = dict(psi); psi_p[s] = min(psi[s] + delta, psi_max)
                eq_p = solve_equilibrium(net, psi_p, y0=state, t_max=continuation_t_max)
                inner_results.append(eq_p)
                profit_p, _, _ = station_metrics(net, psi_p, eq_p.state)

                psi_m = dict(psi); psi_m[s] = max(psi[s] - delta, 0.0)
                eq_m = solve_equilibrium(net, psi_m, y0=state, t_max=continuation_t_max)
                inner_results.append(eq_m)
                profit_m, _, _ = station_metrics(net, psi_m, eq_m.state)

                denom = psi_p[s] - psi_m[s]
                g = (profit_p[s] - profit_m[s]) / denom if denom > 1e-9 else 0.0
                grad[s] = float(np.clip(g, -grad_clip, grad_clip))

        previous_psi = dict(psi)
        last_projected_price_change = max((
            abs(float(np.clip(
                previous_psi[s] + dt_outer * kappa * grad[s], 0.0, psi_max,
            )) - previous_psi[s])
            for s in stations
        ), default=0.0)
        final_effective_kappa = (
            kappa / ((step + 1) ** 0.602) if use_simultaneous_gradient else kappa
        )
        for s in stations:
            psi[s] = float(np.clip(
                psi[s] + dt_outer * final_effective_kappa * grad[s], 0.0, psi_max,
            ))
        last_price_change = max((abs(psi[s] - previous_psi[s]) for s in stations), default=0.0)
        step_inner_converged = all(
            result.converged for result in inner_results[step_inner_start:]
        )
        if last_projected_price_change <= outer_tolerance and step_inner_converged:
            stable_steps += 1
        else:
            stable_steps = 0
        completed_steps = step + 1

        if progress_cb:
            progress_cb(completed_steps, max_steps)

        # On large networks n_steps is the minimum requested work. Continue
        # beyond it only while the projected price update has not settled.
        if is_large and completed_steps >= n_steps and stable_steps >= stable_outer_steps:
            stop_reason = "price tolerance reached"
            break

    eq = solve_equilibrium(
        net, psi, y0=state, t_max=(cold_t_max if state is None else continuation_t_max),
    )
    state = eq.state
    inner_results.append(eq)
    if not eq.converged:
        warnings.append(f"final equilibrium: {eq.message}")
    profit, rho, occ = station_metrics(net, psi, state)
    state_history.append(state.copy())
    price_history.append(dict(psi))
    failed_inner = [result for result in inner_results if not result.converged]
    if failed_inner:
        warnings.append(
            f"{len(failed_inner)} of {len(inner_results)} inner solves did not meet "
            "the residual tolerance (including gradient perturbations)."
        )
    route_limit_hits = [f"{od}/{vehicle_class}" for od, vehicle_class in net.route_limit_hits]
    outer_converged = (
        last_price_change <= outer_tolerance
        if not is_large else stable_steps >= stable_outer_steps
    )
    quality = {
        "accuracy_mode": accuracy_mode,
        "gradient_method": (
            f"averaged SPSA ({profile['samples']} samples)"
            if use_simultaneous_gradient else "coordinate central difference"
        ),
        "gradient_samples": profile["samples"] if use_simultaneous_gradient else 2 * len(stations),
        "effective_kappa": final_effective_kappa,
        "state_count": net.N_STATES,
        "path_count": len(net.path_edges),
        "route_limit": net.max_paths_per_group,
        "route_limit_hits": route_limit_hits,
        "inner_solve_count": len(inner_results),
        "inner_failure_count": len(failed_inner),
        "max_inner_residual": max((result.residual for result in inner_results), default=0.0),
        "final_residual": eq.residual,
        "conservation_error": eq.conservation_error,
        "last_price_change": last_price_change,
        "last_projected_price_change": last_projected_price_change,
        "outer_converged": outer_converged,
        "requested_steps": n_steps,
        "completed_steps": completed_steps,
        "maximum_steps": max_steps,
        "outer_tolerance": outer_tolerance,
        "stable_steps_required": stable_outer_steps,
        "stop_reason": stop_reason,
        "certified": not failed_inner and not route_limit_hits and outer_converged,
    }
    return OuterLoopResult(
        psi=psi, state=state, profit=profit, rho=rho, occ=occ, hist=hist,
        state_history=state_history, price_history=price_history,
        converged=(len(failed_inner) == 0), quality=quality, warnings=warnings,
    )
