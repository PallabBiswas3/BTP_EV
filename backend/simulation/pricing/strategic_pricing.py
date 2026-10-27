"""API adapter around the unchanged supplied sim.py pricing loop.

Only progress observation and response metadata are added. Prices, forecasts,
states, histories, solver fallback and process-pool behavior come from sim.py.
The source uses a process-global serial worker network, so concurrent API runs
are serialized to keep one request from replacing another request's network.
"""
import os
import threading
import time
from dataclasses import dataclass, field

os.environ.setdefault("MPLBACKEND", "Agg")

import numpy as np
import sim as source

from simulation.core.network_engine import ChargingNetwork
from simulation.pricing.equilibrium import _conservation_error, _state_index_groups

SOURCE_LOCK = threading.RLock()


class _ProgressNetwork(ChargingNetwork):
    """Observe actual advancements without modifying their inputs or outputs."""

    def advance(self, *args, **kwargs):
        result = super().advance(*args, **kwargs)
        # Source forecasts request samples; actual physical steps do not.
        if not kwargs.get("return_samples", False) and self._progress_cb:
            self._completed += 1
            self._progress_cb(self._completed, self._total)
        return result

    def __getstate__(self):
        state = self.__dict__.copy()
        state["_progress_cb"] = None
        return state


@dataclass
class OuterLoopResult:
    psi: dict
    state: np.ndarray
    profit: dict
    rho: dict
    occ: dict
    hist: dict
    state_history: list
    price_history: list
    time_history: list
    converged: bool
    quality: dict
    warnings: list = field(default_factory=list)
    raw: dict = field(default_factory=dict)


def outer_loop(net, t_end=75000.0, h=10.0, ctrl_horizon=10, kappa=0.1,
               delta=0.02, dt_outer=1.0, grad_clip=None, save_prefix=None,
               profit_mode="mean", eq_t_max=75000.0, n_workers=None,
               parallel=None, psi0=0.5, log_every=None, progress_cb=None):
    """Use the source function defaults; API defaults follow its CLI instead."""
    count = int(round(t_end / h))
    observed = _ProgressNetwork.__new__(_ProgressNetwork)
    observed.__dict__ = net.__dict__.copy()
    observed._progress_cb = progress_cb
    observed._completed = 0
    observed._total = count
    if progress_cb:
        progress_cb(0, count)
    with SOURCE_LOCK:
        started = time.perf_counter()
        raw = source.outer_loop(
            observed, t_end=t_end, h=h, ctrl_horizon=ctrl_horizon, kappa=kappa,
            delta=delta, dt_outer=dt_outer, grad_clip=grad_clip,
            save_prefix=save_prefix, profit_mode=profit_mode, eq_t_max=eq_t_max,
            n_workers=n_workers, parallel=parallel, psi0=psi0, log_every=log_every,
        )
        elapsed = time.perf_counter() - started
    sol = raw["final_sol"]
    hist = dict(raw["hist"], time=sol.t[1:].tolist())
    previous = sol.psi_hist[-2] if len(sol.psi_hist) > 1 else sol.psi_hist[-1]
    change = max((abs(raw["psi"][s] - previous[s]) for s in net.stations), default=0.0)
    x_idx, y_idx = _state_index_groups(net)
    derivative = net.dynamics(raw["t_end"], raw["state"], raw["psi"])
    residual = float(np.linalg.norm(derivative[x_idx]) + np.linalg.norm(derivative[y_idx]))
    skipped = [
        f"{od['name']}/{cls}"
        for od in net.ods for cls in ("EV", "NEV")
        if od["class_shares"].get(cls, 0) > 0 and (od["name"], cls) not in net.groups
    ]
    warnings = [f"Source route builder skipped demanded groups: {', '.join(skipped)}."] if skipped else []
    horizon = "eq" if ctrl_horizon == "eq" else int(ctrl_horizon)
    use_pool = horizon == "eq" if parallel is None else bool(parallel)
    workers = n_workers or min(2 * max(len(net.stations), 1), os.cpu_count() or 1)
    quality = dict(
        approach="predictive", result_kind="dynamic_endpoint", source_exact=True,
        route_strategy="unchanged supplied network_engine.py", accuracy_mode="preview",
        gradient_method="coordinate central difference", gradient_samples=2 * len(net.stations),
        gradient_execution="process-parallel" if use_pool else "serial",
        gradient_workers=workers if use_pool else 1, gradient_fallback_reason="",
        effective_kappa=kappa, state_count=net.N_STATES, path_count=len(net.path_edges),
        route_limit=5, route_limit_hits=[], skipped_demand_groups=skipped,
        inner_solve_count=count * 2 * len(net.stations) if horizon == "eq" else 0,
        forecast_solve_count=count * 2 * len(net.stations), actual_advance_count=count,
        cache_hit_count=0, cache_warm_start_count=0,
        # Source returns forecast states, not per-forecast convergence flags.
        inner_failure_count=None, max_inner_residual=None,
        final_residual=residual, conservation_error=_conservation_error(net, raw["state"]),
        last_price_change=change, last_projected_price_change=change,
        outer_converged=change <= 1e-4, requested_steps=count, completed_steps=count,
        maximum_steps=count, outer_tolerance=1e-4, stable_steps_required=0,
        stop_reason="fixed simulation duration", certified=False,
        ctrl_horizon=horizon, profit_mode=profit_mode, h=h,
        requested_t_end=t_end, actual_t_end=raw["t_end"],
        forecast_duration=None if horizon == "eq" else horizon * h,
        wall_time_seconds=elapsed,
    )
    return OuterLoopResult(
        raw["psi"], raw["state"], raw["profit"], raw["rho"], raw["occ"], hist,
        [sol.y[:, k].copy() for k in range(sol.y.shape[1])], sol.psi_hist,
        sol.t.tolist(), residual <= 1e-6 and change <= 1e-4, quality, warnings, raw,
    )
