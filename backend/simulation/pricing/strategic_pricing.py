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
    converged: bool
    warnings: list = field(default_factory=list)


def outer_loop(net, psi0=None, n_steps=30, kappa=0.1, delta=0.02,
                dt_outer=1.0, psi_max=3.0, grad_clip=5.0, t_max=800.0,
                progress_cb=None):
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

    for step in range(n_steps):
        eq = solve_equilibrium(net, psi, y0=state, t_max=t_max)
        state = eq.state
        if not eq.converged:
            warnings.append(f"outer step {step}: {eq.message}")
        profit, rho, occ = station_metrics(net, psi, state)
        for s in stations:
            hist[s]["psi"].append(psi[s])
            hist[s]["rho"].append(rho[s])
            hist[s]["occ"].append(occ[s])
            hist[s]["profit"].append(profit[s])

        grad = {}
        for s in stations:
            psi_p = dict(psi); psi_p[s] = min(psi[s] + delta, psi_max)
            eq_p = solve_equilibrium(net, psi_p, y0=state, t_max=t_max)
            profit_p, _, _ = station_metrics(net, psi_p, eq_p.state)

            psi_m = dict(psi); psi_m[s] = max(psi[s] - delta, 0.0)
            eq_m = solve_equilibrium(net, psi_m, y0=state, t_max=t_max)
            profit_m, _, _ = station_metrics(net, psi_m, eq_m.state)

            denom = psi_p[s] - psi_m[s]
            g = (profit_p[s] - profit_m[s]) / denom if denom > 1e-9 else 0.0
            grad[s] = float(np.clip(g, -grad_clip, grad_clip))

        for s in stations:
            psi[s] = float(np.clip(psi[s] + dt_outer * kappa * grad[s], 0.0, psi_max))

        if progress_cb:
            progress_cb(step + 1, n_steps)

    eq = solve_equilibrium(net, psi, y0=state, t_max=t_max)
    state = eq.state
    if not eq.converged:
        warnings.append(f"final equilibrium: {eq.message}")
    profit, rho, occ = station_metrics(net, psi, state)
    return OuterLoopResult(
        psi=psi, state=state, profit=profit, rho=rho, occ=occ, hist=hist,
        converged=(len(warnings) == 0), warnings=warnings,
    )
