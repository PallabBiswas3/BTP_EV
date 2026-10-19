"""Predictive discrete-time pricing ported from dynamic-ev-pricing/sim.py.

Each station evaluates two constant-price forecasts from the SAME current
state. All stations update simultaneously, then the actual state advances one
physical-time interval. Forecast mode is finite-horizon or equilibrium.
"""
import multiprocessing as mp
import os
import pickle
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field

import numpy as np

from simulation.pricing.equilibrium import _conservation_error
from simulation.pricing.legacy_strategic_pricing import (
    _PARALLEL_POOL_GATE, _pickle_network_for_workers,
)
from simulation.pricing.metrics import station_metrics
from simulation.pricing.predictive_equilibrium import residual, solve_equilibrium


_WORKER_NET = None


def _init_worker(network_blob):
    global _WORKER_NET
    _WORKER_NET = pickle.loads(network_blob)


def _forecast(net, task):
    station, sign, psi, state, t_now, horizon, h, profit_mode, eq_t_max = task
    if horizon == "eq":
        eq = solve_equilibrium(net, psi, y0=state, t_max=eq_t_max, t0=t_now)
        profit, _, _ = station_metrics(net, psi, eq.state)
        return station, sign, psi[station], profit[station], eq
    _, samples = net.advance(state, t_now, psi, h, horizon, return_samples=True)
    edge = net.stations[station]
    attrs = net.G.edges[edge]
    occupancy = samples[net.IDX[("xs", edge)]]
    throughput = np.minimum(attrs["a_s"] * occupancy, attrs["mu_s"])
    profits = (psi[station] - attrs["c_s"]) * throughput
    objective = float(profits[-1]) if profit_mode == "end" else float(profits.mean())
    return station, sign, psi[station], objective, None


def _worker_forecast(task):
    return _forecast(_WORKER_NET, task)


class _ForecastExecutor:
    """One reusable process pool per run; bounded across concurrent API jobs."""

    def __init__(self, net, enabled, n_workers, task_count):
        self.net = net
        self.pool = None
        self.owns_gate = False
        self.execution = "serial"
        self.workers = 1
        self.fallback_reason = ""
        workers = n_workers or min(max(task_count, 1), os.cpu_count() or 1)
        disabled = os.environ.get("EVCS_PARALLEL_GRADIENTS", "1").lower() in {"0", "false", "no", "off"}
        if not enabled or disabled or workers < 2:
            return
        if not _PARALLEL_POOL_GATE.acquire(blocking=False):
            self.fallback_reason = "another pricing run owns the process pool"
            return
        self.owns_gate = True
        try:
            self.pool = ProcessPoolExecutor(
                max_workers=min(workers, max(task_count, 1)),
                mp_context=mp.get_context("spawn"),
                initializer=_init_worker, initargs=(_pickle_network_for_workers(net),),
            )
            self.workers = min(workers, max(task_count, 1))
        except (OSError, TypeError, ValueError, pickle.PickleError) as exc:
            self.fallback_reason = f"worker initialization failed: {exc}"
            self.close()

    def solve(self, tasks):
        if self.pool is not None:
            try:
                results = list(self.pool.map(_worker_forecast, tasks, chunksize=1))
                self.execution = "process-parallel"
                return results
            except Exception as exc:  # Worker failures retry the identical batch.
                self.fallback_reason = f"parallel forecast failed: {exc}"
                self.execution = "serial-fallback"
                self.workers = 1
                self.close()
        return [_forecast(self.net, task) for task in tasks]

    def close(self):
        if self.pool is not None:
            self.pool.shutdown(wait=True, cancel_futures=True)
            self.pool = None
        if self.owns_gate:
            _PARALLEL_POOL_GATE.release()
            self.owns_gate = False

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()


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


def wardrop_spreads(net, psi, state, t=0.0, y_tol=1e-6):
    data = net._unpack(state)
    costs = net._path_costs(data, t, psi)
    spreads = {}
    for key, paths in net.game_groups.items():
        used = [costs[pid] for pid in paths if data["y"][pid] > y_tol]
        spreads[key] = max(used) - min(used) if len(used) > 1 else 0.0
    return spreads


def outer_loop(net, psi0=None, t_end=75000.0, h=1500.0, ctrl_horizon=10,
               kappa=0.1, delta=0.02, dt_outer=1.0, grad_clip=None,
               profit_mode="end", eq_t_max=75000.0, n_workers=None,
               parallel=None, psi_max=None, progress_cb=None,
               accuracy_mode="preview"):
    """Reference CLI defaults; optional caps are explicit backend extensions."""
    if h <= 0 or t_end <= 0:
        raise ValueError("h and t_end must be positive.")
    horizon = "eq" if ctrl_horizon == "eq" else int(ctrl_horizon)
    if horizon != "eq" and (horizon < 1 or horizon != ctrl_horizon):
        raise ValueError("ctrl_horizon must be a positive integer or 'eq'.")
    if profit_mode not in {"end", "mean"}:
        raise ValueError("profit_mode must be 'end' or 'mean'.")
    count = int(round(t_end / h))
    stations = list(net.stations)
    if isinstance(psi0, dict):
        unknown = set(psi0) - set(stations)
        if unknown:
            raise ValueError(f"Unknown initial-price stations: {sorted(unknown)}")
        psi = {station: float(psi0.get(station, 0.5)) for station in stations}
    else:
        psi = {station: float(0.5 if psi0 is None else psi0) for station in stations}
    if any(not np.isfinite(value) or value < 0 or (psi_max is not None and value > psi_max) for value in psi.values()):
        raise ValueError("Initial prices must be finite, nonnegative and within the optional price cap.")

    hist = {
        station: {key: [] for key in ("psi", "rho", "occ", "profit", "revenue", "queue")}
        for station in stations
    }
    hist["total_revenue"] = []
    hist["wardrop"] = {key: [] for key in net.game_groups}
    hist["path_y"] = {pid: [] for pid in net.path_state_keys}
    hist["time"] = []
    state = net.initial_state()
    states, prices, times = [state.copy()], [dict(psi)], [0.0]
    t_now = 0.0
    warnings, eq_results = [], []
    last_change = 0.0
    started = time.perf_counter()
    enabled = horizon == "eq" if parallel is None else parallel

    if progress_cb:
        progress_cb(0, count)
    with _ForecastExecutor(net, enabled, n_workers, 2 * len(stations)) as executor:
        for step in range(count):
            tasks = []
            for station in stations:
                for sign in (1, -1):
                    candidate = dict(psi)
                    candidate[station] = max(psi[station] + sign * delta, 0.0)
                    if psi_max is not None:
                        candidate[station] = min(candidate[station], psi_max)
                    tasks.append((station, sign, candidate, state, t_now, horizon, h, profit_mode, eq_t_max))
            results = executor.solve(tasks)
            profits = {(station, sign): (price, value) for station, sign, price, value, _ in results}
            eq_results.extend(eq for *_, eq in results if eq is not None)
            grad = {}
            for station in stations:
                plus_price, plus_profit = profits[(station, 1)]
                minus_price, minus_profit = profits[(station, -1)]
                denominator = plus_price - minus_price
                value = (plus_profit - minus_profit) / denominator if denominator > 1e-9 else 0.0
                grad[station] = float(np.clip(value, -grad_clip, grad_clip)) if grad_clip is not None else float(value)
            previous = dict(psi)
            for station in stations:
                psi[station] = max(psi[station] + dt_outer * kappa * grad[station], 0.0)
                if psi_max is not None:
                    psi[station] = min(psi[station], psi_max)
            last_change = max((abs(psi[s] - previous[s]) for s in stations), default=0.0)
            state = net.advance(state, t_now, psi, h, 1)
            t_now += h
            states.append(state.copy())
            prices.append(dict(psi))
            times.append(t_now)
            profit, rho, occ = station_metrics(net, psi, state)
            data = net._unpack(state)
            for station in stations:
                attrs = net.G.edges[net.stations[station]]
                values = dict(psi=psi[station], rho=rho[station], occ=occ[station],
                              profit=profit[station], revenue=psi[station] * rho[station],
                              queue=max(occ[station] - attrs["mu_s"] / attrs["a_s"], 0.0))
                for key, value in values.items():
                    hist[station][key].append(value)
            hist["time"].append(t_now)
            hist["total_revenue"].append(sum(psi[s] * rho[s] for s in stations))
            for key, spread in wardrop_spreads(net, psi, state, t_now).items():
                hist["wardrop"][key].append(spread)
            for pid in net.path_state_keys:
                hist["path_y"][pid].append(data["y"][pid])
            if progress_cb:
                progress_cb(step + 1, count)
        execution, workers, fallback = executor.execution, executor.workers, executor.fallback_reason

    profit, rho, occ = station_metrics(net, psi, state)
    failed = [eq for eq in eq_results if not eq.converged]
    if failed:
        warnings.append(f"{len(failed)} of {len(eq_results)} equilibrium forecasts did not meet the residual tolerance.")
    final_residual = residual(net, psi, state, t_now)
    quality = {
        "approach": "predictive", "result_kind": "dynamic_endpoint",
        "accuracy_mode": accuracy_mode, "route_strategy": "reference shortest routes with 2x cost cutoff",
        "gradient_method": "coordinate central difference", "gradient_samples": 2 * len(stations),
        "gradient_execution": execution, "gradient_workers": workers,
        "gradient_fallback_reason": fallback, "effective_kappa": kappa,
        "state_count": net.N_STATES, "path_count": len(net.path_edges),
        "route_limit": 5, "route_limit_hits": [], "inner_solve_count": len(eq_results),
        "route_cutoff_fallback_groups": [f"{od}/{cls}" for od, cls in net.cutoff_fallback_groups],
        "forecast_solve_count": count * 2 * len(stations), "actual_advance_count": count,
        "cache_hit_count": 0, "cache_warm_start_count": 0, "inner_failure_count": len(failed),
        "max_inner_residual": max((eq.residual for eq in eq_results), default=0.0),
        "final_residual": final_residual, "conservation_error": _conservation_error(net, state),
        "last_price_change": last_change, "last_projected_price_change": last_change,
        "outer_converged": last_change <= 1e-4, "requested_steps": count,
        "completed_steps": count, "maximum_steps": count, "outer_tolerance": 1e-4,
        "stable_steps_required": 0, "stop_reason": "fixed simulation duration",
        "certified": False, "ctrl_horizon": horizon, "profit_mode": profit_mode,
        "h": h, "requested_t_end": t_end, "actual_t_end": t_now,
        "forecast_duration": None if horizon == "eq" else horizon * h,
        "wall_time_seconds": time.perf_counter() - started,
    }
    return OuterLoopResult(
        psi, state, profit, rho, occ, hist, states, prices, times,
        final_residual <= 1e-6 and last_change <= 1e-4 and not failed, quality, warnings,
    )
