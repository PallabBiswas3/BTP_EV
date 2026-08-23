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
import copy
import dis
import multiprocessing as mp
import os
import pickle
import threading
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field

import numpy as np

from simulation.pricing.equilibrium import solve_equilibrium
from simulation.pricing.metrics import station_metrics


_GRADIENT_WORKER_NET = None
_PARALLEL_POOL_GATE = threading.BoundedSemaphore(1)


class _ConstantDemand:
    """Picklable equivalent of the constant lambdas used by scenario builders."""

    __slots__ = ("value",)

    def __init__(self, value):
        self.value = value

    def __call__(self, _time):
        return self.value


def _constant_lambda_value(fn):
    """Return a lambda's captured constant, or raise if it may depend on time.

    JSON and paper scenario builders use either ``lambda t, val=x: val`` or
    ``lambda t: captured_x``.  Those functions are not picklable with the
    standard library on Windows.  Restricting the accepted bytecode to a
    single constant/default/closure load prevents us from silently changing
    a genuinely time-varying demand function merely to enable parallelism.
    """
    code = getattr(fn, "__code__", None)
    if code is None or code.co_argcount < 1:
        raise TypeError("demand callable is not a supported constant lambda")

    allowed = {
        "CACHE", "COPY_FREE_VARS", "LOAD_CONST", "LOAD_DEREF", "LOAD_FAST",
        "NOP", "RESUME", "RETURN_VALUE",
    }
    time_arg = code.co_varnames[0]
    loaded_values = 0
    for instruction in dis.get_instructions(fn):
        if instruction.opname not in allowed:
            raise TypeError("demand callable may perform time-varying work")
        if instruction.opname == "LOAD_FAST" and instruction.argval == time_arg:
            raise TypeError("demand callable depends on integration time")
        if instruction.opname in {"LOAD_CONST", "LOAD_DEREF", "LOAD_FAST"}:
            loaded_values += 1
    if loaded_values != 1:
        raise TypeError("demand callable is not a simple captured constant")

    value = fn(0.0)
    pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)
    return value


def _pickle_network_for_workers(net):
    """Serialize a built network without rebuilding or reordering its paths."""
    try:
        return pickle.dumps(net, protocol=pickle.HIGHEST_PROTOCOL)
    except Exception:  # noqa: BLE001 - inability to pickle means serial fallback
        pass

    worker_net = copy.copy(net)
    worker_net.ods = []
    for od in net.ods:
        worker_od = dict(od)
        demand = worker_od["lam_fn"]
        try:
            pickle.dumps(demand, protocol=pickle.HIGHEST_PROTOCOL)
        except Exception:  # noqa: BLE001 - inspect only known-safe lambdas below
            worker_od["lam_fn"] = _ConstantDemand(_constant_lambda_value(demand))
        worker_net.ods.append(worker_od)
    return pickle.dumps(worker_net, protocol=pickle.HIGHEST_PROTOCOL)


def _init_gradient_worker(network_blob):
    """Install one immutable network copy per worker process."""
    global _GRADIENT_WORKER_NET
    os.environ["EVCS_GRADIENT_WORKER"] = "1"
    _GRADIENT_WORKER_NET = pickle.loads(network_blob)


def _solve_gradient_worker(task):
    """Process-pool entry point; kept at module scope for Windows spawn."""
    index, psi, state, t_max = task
    if _GRADIENT_WORKER_NET is None:
        raise RuntimeError("gradient worker was not initialized")
    return index, solve_equilibrium(
        _GRADIENT_WORKER_NET, psi, y0=state, t_max=t_max,
    )


def _solve_gradient_serial(net, tasks):
    return [
        (index, solve_equilibrium(net, psi, y0=state, t_max=t_max))
        for index, psi, state, t_max in tasks
    ]


class _CoordinateGradientExecutor:
    """Reusable, bounded process pool with transparent serial fallback."""

    def __init__(self, net, task_count):
        self.net = net
        self.task_count = task_count
        self.executor = None
        self.gate_acquired = False
        self.execution = "serial"
        self.workers = 1
        self.fallback_reason = ""

    @staticmethod
    def _parallel_enabled():
        setting = os.environ.get("EVCS_PARALLEL_GRADIENTS", "1").strip().lower()
        return setting not in {"0", "false", "no", "off"}

    def _requested_workers(self):
        cpu_limit = max(1, os.cpu_count() or 1)
        try:
            configured = int(os.environ.get("EVCS_GRADIENT_WORKERS", "4"))
        except ValueError:
            configured = 4
        return min(self.task_count, cpu_limit, max(1, configured))

    def _start(self):
        if self.executor is not None or self.fallback_reason:
            return
        if not self._parallel_enabled():
            self.fallback_reason = "disabled by EVCS_PARALLEL_GRADIENTS"
            return
        if os.environ.get("EVCS_GRADIENT_WORKER") == "1":
            self.fallback_reason = "nested worker process"
            return

        workers = self._requested_workers()
        if workers < 2:
            self.fallback_reason = "fewer than two workers available"
            return
        if not _PARALLEL_POOL_GATE.acquire(blocking=False):
            self.fallback_reason = "another pricing run owns the process pool"
            return
        self.gate_acquired = True

        try:
            network_blob = _pickle_network_for_workers(self.net)
            self.executor = ProcessPoolExecutor(
                max_workers=workers,
                mp_context=mp.get_context("spawn"),
                initializer=_init_gradient_worker,
                initargs=(network_blob,),
            )
            self.workers = workers
        except Exception as exc:  # noqa: BLE001 - serial execution remains valid
            self.fallback_reason = f"worker initialization failed: {exc}"
            self.close()

    def solve(self, tasks):
        self._start()
        if self.executor is None:
            return _solve_gradient_serial(self.net, tasks)
        try:
            # map() preserves coordinate/+/- ordering, so accumulation and
            # quality metadata remain deterministic relative to the serial loop.
            results = list(self.executor.map(_solve_gradient_worker, tasks, chunksize=1))
            self.execution = "process-parallel"
            return results
        except Exception as exc:  # noqa: BLE001 - retry the complete batch serially
            self.fallback_reason = f"parallel solve failed: {exc}"
            self.execution = "serial-fallback"
            self.workers = 1
            self.close()
            return _solve_gradient_serial(self.net, tasks)

    def _shutdown_executor(self):
        if self.executor is not None:
            self.executor.shutdown(wait=True, cancel_futures=True)
            self.executor = None

    def close(self):
        self._shutdown_executor()
        if self.gate_acquired:
            _PARALLEL_POOL_GATE.release()
            self.gate_acquired = False

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        self.close()


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
    # Apply the same coordinate-gradient path universally: every nominal and
    # perturbed equilibrium uses the configured maximum horizon, with the
    # independent +/- station perturbations dispatched concurrently below.
    cold_t_max = t_max
    continuation_t_max = t_max
    final_effective_kappa = kappa
    inner_results = []
    last_price_change = 0.0
    last_projected_price_change = 0.0
    max_steps = n_steps
    stable_steps = 0
    completed_steps = 0
    stop_reason = "fixed step count"

    with _CoordinateGradientExecutor(net, 2 * len(stations)) as gradient_executor:
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

            # Every +/- coordinate solve starts from the same nominal state.
            # They are independent, so evaluating them concurrently changes
            # wall time but not the central-difference formula or update order.
            tasks = []
            coordinates = []
            for s in stations:
                psi_p = dict(psi)
                psi_p[s] = min(psi[s] + delta, psi_max)
                plus_index = len(tasks)
                tasks.append((plus_index, psi_p, state, continuation_t_max))

                psi_m = dict(psi)
                psi_m[s] = max(psi[s] - delta, 0.0)
                minus_index = len(tasks)
                tasks.append((minus_index, psi_m, state, continuation_t_max))
                coordinates.append(
                    (s, psi_p, psi_m, plus_index, minus_index),
                )

            solved = dict(gradient_executor.solve(tasks))
            grad = {}
            for s, psi_p, psi_m, plus_index, minus_index in coordinates:
                eq_p = solved[plus_index]
                inner_results.append(eq_p)
                profit_p, _, _ = station_metrics(net, psi_p, eq_p.state)

                eq_m = solved[minus_index]
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
            final_effective_kappa = kappa
            for s in stations:
                psi[s] = float(np.clip(
                    psi[s] + dt_outer * final_effective_kappa * grad[s], 0.0, psi_max,
                ))
            last_price_change = max(
                (abs(psi[s] - previous_psi[s]) for s in stations), default=0.0,
            )
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

        gradient_execution = gradient_executor.execution
        gradient_workers = gradient_executor.workers
        gradient_fallback_reason = gradient_executor.fallback_reason

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
    outer_converged = last_price_change <= outer_tolerance
    quality = {
        "accuracy_mode": accuracy_mode,
        "gradient_method": "coordinate central difference",
        "gradient_samples": 2 * len(stations),
        "gradient_execution": gradient_execution,
        "gradient_workers": gradient_workers,
        "gradient_fallback_reason": gradient_fallback_reason,
        "effective_kappa": final_effective_kappa,
        "state_count": net.N_STATES,
        "path_count": len(net.path_edges),
        "route_limit": net.max_paths_per_group,
        "route_limit_hits": route_limit_hits,
        "inner_solve_count": len(inner_results),
        "cache_hit_count": sum(result.cache_hit for result in inner_results),
        "cache_warm_start_count": sum(
            result.cache_warm_start for result in inner_results
        ),
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
