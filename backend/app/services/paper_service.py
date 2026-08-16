from app.services.simulation_service import _f, serialize_outer_history
from simulation.experiments.paper_experiments import (
    PAPER_BETA_SWEEP, PAPER_INITIAL_CONDITIONS, build_paper_network,
)
from simulation.pricing.metrics import total_user_cost
from simulation.pricing.strategic_pricing import outer_loop


def run_experiment1(n_steps: int = 40, report_progress=None) -> dict:
    """Closed-loop convergence from three initial price profiles."""
    net = build_paper_network(beta=0.6)
    stations = list(net.stations.keys())
    runs = {}
    warnings = []
    labels = list(PAPER_INITIAL_CONDITIONS.items())
    for li, (label, psi0) in enumerate(labels):
        if report_progress:
            report_progress(f"Running {label} ({li + 1}/{len(labels)})", li, len(labels))
        outer = outer_loop(net, psi0=psi0, n_steps=n_steps)
        warnings.extend(outer.warnings)
        runs[label] = {
            "initial_prices": psi0,
            "equilibrium_prices": {s: _f(outer.psi[s]) for s in stations},
            "history": serialize_outer_history(net, outer.hist),
        }
    return {"stations": stations, "runs": runs, "warnings": warnings}


def run_experiment2(n_steps: int = 25, report_progress=None) -> dict:
    """Sensitivity of the equilibrium to the EV demand fraction beta."""
    stations_ref: list[str] = []
    prices, throughputs, occupancies = {}, {}, {}
    warnings = []
    for bi, beta in enumerate(PAPER_BETA_SWEEP):
        if report_progress:
            report_progress(f"beta={beta:.1f} ({bi + 1}/{len(PAPER_BETA_SWEEP)})", bi, len(PAPER_BETA_SWEEP))
        net = build_paper_network(beta=beta)
        stations = list(net.stations.keys())
        if not stations_ref:
            stations_ref[:] = stations
            for d in (prices, throughputs, occupancies):
                d.update({s: [] for s in stations})
        outer = outer_loop(net, psi0={s: 0.4 for s in stations}, n_steps=n_steps)
        warnings.extend(outer.warnings)
        for s in stations:
            prices[s].append(_f(outer.psi[s]))
            throughputs[s].append(_f(outer.rho[s]))
            occupancies[s].append(_f(outer.occ[s]))
    return {
        "beta": list(PAPER_BETA_SWEEP),
        "stations": stations_ref,
        "prices": prices,
        "throughputs": throughputs,
        "occupancies": occupancies,
        "warnings": warnings,
    }


def run_experiment3(n_steps: int = 25, report_progress=None) -> dict:
    """Strategic (NE) pricing vs. uniform fixed pricing at the same average
    price, swept over beta."""
    from simulation.pricing.equilibrium import solve_equilibrium
    from simulation.pricing.metrics import station_metrics

    stations_ref: list[str] = []
    out = {
        "beta": list(PAPER_BETA_SWEEP),
        "strategic": {"user_cost": [], "profit": []},
        "fixed": {"user_cost": [], "profit": []},
    }
    warnings = []
    for bi, beta in enumerate(PAPER_BETA_SWEEP):
        if report_progress:
            report_progress(f"beta={beta:.1f} ({bi + 1}/{len(PAPER_BETA_SWEEP)})", bi, len(PAPER_BETA_SWEEP))
        net = build_paper_network(beta=beta)
        stations = list(net.stations.keys())
        if not stations_ref:
            stations_ref[:] = stations
        outer = outer_loop(net, psi0={s: 0.4 for s in stations}, n_steps=n_steps)
        warnings.extend(outer.warnings)

        avg = sum(outer.psi.values()) / len(outer.psi)
        psi_bar = {s: avg for s in stations}
        net_bar = build_paper_network(beta=beta)
        eq_bar = solve_equilibrium(net_bar, psi_bar)
        profit_bar, _, _ = station_metrics(net_bar, psi_bar, eq_bar.state)
        uc_bar = total_user_cost(net_bar, psi_bar, eq_bar.state)
        uc_star = total_user_cost(net, outer.psi, outer.state)

        out["strategic"]["user_cost"].append(_f(uc_star))
        out["strategic"]["profit"].append(_f(sum(outer.profit.values())))
        out["fixed"]["user_cost"].append(_f(uc_bar))
        out["fixed"]["profit"].append(_f(sum(profit_bar.values())))

    out["stations"] = stations_ref
    out["warnings"] = warnings
    return out
