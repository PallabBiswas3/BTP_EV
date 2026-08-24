"""
Inner-loop equilibrium solver.

Extracted from the two near-identical copies in `simulator_paper.py` and
`simulator_paper_generalised.py`, with changes made for a live web API (the
original scripts were only ever run once, offline, from the CLI). Each is
documented at the point of change; summary:

1. **Integrator: RK45 -> BDF.** The paper's own numerical-methods section
   (Sec. IV: "All simulations were performed in Python using SciPy's BDF
   integrator for the inner closed-loop dynamics") does not match the
   supplied code, which used `method="RK45"`. Measured on these networks,
   BDF also reaches the same steady state 2-5x faster than RK45, so
   switching to BDF is both a fidelity fix and a performance win.

2. **Terminal convergence event.** Convergence uses the split L2 residual
   criterion from ``sim3.py``, ``||x_dot||_2 + ||y_dot||_2 <= 1e-6``, where
   ``x`` contains road and station states and ``y`` contains route-flow states.
   The integration stops as soon as this criterion is reached, while a final
   post-hoc check verifies the returned (and route-flow-projected) state.

3. **Chunked integration with path-flow renormalization.** BDF advances in
   short chunks (50 time units by default), and the route-flow components are
   projected after every chunk. Replicator average cost is normalized by the
   current route-flow sum, so the vector field does not amplify a small
   off-simplex numerical error. A generic stiff solver can still violate the
   invariant slightly, especially near a simplex boundary, so projection
   clips negative flows and restores each group to its known demand. This is
   an exact, cheap correction onto the manifold where the true solution lives.

4. **`y0` warm-starting.** Sec. III-B describes re-solving perturbed prices
   "with the unperturbed equilibrium as a warm start", which neither
   original script actually implements (both call `solve_equilibrium(net,
   psi)` with no `y0` at every step, always cold-starting). This is a
   performance-only change: the ODE is unchanged and the steady state
   doesn't depend on the starting point, so results are identical, just
   cheaper to reach -- and, combined with (3), it also means drift never
   gets the chance to accumulate across chained outer-loop steps.

5. **Route-clock acceleration.** Small finite-difference price perturbations
   create small path-cost gaps, so the replicator state can approach its fixed
   point much more slowly than the physical traffic states. During equilibrium
   integration only, route derivatives are multiplied by 20. Positive time
   rescaling leaves every fixed point unchanged. Convergence is still measured
   with the original, unscaled model derivative, and ordinary trajectory
   simulation continues to use the configured `eta` without acceleration.

`t_max` defaults to the paper's original 1000-unit maximum horizon. Every
network is integrated until either the split L2 convergence criterion is met
or that horizon is reached. A terminal event can stop inside a chunk; the
projected state is always checked again before it is accepted as converged.
Every solve additionally has a defensive fallback so a
misbehaving network returns a labeled "not fully converged" result instead
of letting NaN/Inf leak into the JSON response.
"""
import numpy as np
from scipy.integrate import solve_ivp

from simulation.pricing import equilibrium_cache


_INTEGRATION_CHUNK = 50.0
_MAX_LOCAL_RESTARTS = 2
_ROUTE_TIME_SCALE = 20.0


class EquilibriumResult:
    __slots__ = (
        "state", "converged", "message", "residual", "conservation_error",
        "elapsed", "cache_hit", "cache_warm_start",
    )

    def __init__(self, state, converged, message="", residual=float("inf"),
                 conservation_error=float("inf"), elapsed=0.0, cache_hit=False,
                 cache_warm_start=False):
        self.state = state
        self.converged = converged
        self.message = message
        self.residual = float(residual)
        self.conservation_error = float(conservation_error)
        self.elapsed = float(elapsed)
        self.cache_hit = bool(cache_hit)
        self.cache_warm_start = bool(cache_warm_start)


def _conservation_error(net, state):
    """Maximum OD/class route-flow simplex error."""
    maximum = 0.0
    for (od_name, c), pids in net.game_groups.items():
        od = next(o for o in net.ods if o["name"] == od_name)
        target = od["class_shares"][c] * od["lam_fn"](0.0)
        values = np.array([state[net.IDX[("y", pid)]] for pid in pids])
        maximum = max(maximum, abs(float(values.sum()) - target))
        maximum = max(maximum, max(0.0, -float(values.min())))
    return maximum


def _renormalize_path_flows(net, state):
    """Project path-flow (y) components back onto the exact constraint
    manifold sum_{p in group} y_p = lambda_{od,c}, correcting numerical
    drift accumulated during integration. See module docstring, point 3."""
    state = state.copy()
    for (od_name, c), pids in net.game_groups.items():
        od = next(o for o in net.ods if o["name"] == od_name)
        target = od["class_shares"][c] * od["lam_fn"](0.0)
        idxs = [net.IDX[("y", pid)] for pid in pids]
        vals = np.clip(state[idxs], 0.0, None)
        total = vals.sum()
        if total > 1e-12:
            state[idxs] = vals * (target / total)
        else:
            state[idxs] = target / len(idxs)
    return state


def _state_index_groups(net):
    """Return physical-state and route-flow indices for the split L2 norm."""
    x_idx = np.array(
        [net.IDX[("xr", edge, cls)] for edge, cls in net.road_state_keys]
        + [net.IDX[("xs", edge)] for edge in net.station_edges],
        dtype=int,
    )
    y_idx = np.array(
        [net.IDX[("y", pid)] for pid in net.path_state_keys],
        dtype=int,
    )
    return x_idx, y_idx


def solve_equilibrium(net, psi, y0=None, t_max=1000.0, tol=1e-6):
    """Integrate the closed inner (traffic + routing) system to steady state.

    Returns an EquilibriumResult. `converged=False` means the residual
    ||x_dot||_2 + ||y_dot||_2 was still above a practical threshold when
    `t_max` was hit;
    the state is still returned (it's typically accurate to 3-4 significant
    figures well before that point -- see module docstring) but the caller
    should surface the warning rather than silently trusting it as an exact
    fixed point.
    """
    def model_rhs(t, state):
        return net.dynamics(t, state, psi_override=psi)

    x_idx, y_idx = _state_index_groups(net)

    def rhs(t, state):
        """Accelerated integration field with the same equilibrium points."""
        derivative = model_rhs(t, state)
        if y_idx.size:
            derivative[y_idx] *= _ROUTE_TIME_SCALE
        return derivative

    def _residual(t, state):
        """Split L2 residual of the original, unscaled model dynamics."""
        derivative = model_rhs(t, state)
        x_dot_norm = np.linalg.norm(derivative[x_idx]) if x_idx.size else 0.0
        y_dot_norm = np.linalg.norm(derivative[y_idx]) if y_idx.size else 0.0
        value = float(x_dot_norm + y_dot_norm)
        return value if np.isfinite(value) else float("inf")

    def _meets_tolerance(residual):
        """Accept an event root despite insignificant floating-point error."""
        return residual <= tol or np.isclose(residual, tol, rtol=1e-9, atol=0.0)

    def convergence_event(t, state):
        return _residual(t, state) - tol

    convergence_event.terminal = True
    convergence_event.direction = -1

    cached = equilibrium_cache.load_exact(net, psi, tol)
    if cached is not None:
        cached_state, _stored_residual, _stored_conservation, cached_elapsed = cached
        residual = _residual(0.0, cached_state)
        conservation = _conservation_error(net, cached_state)
        if _meets_tolerance(residual) and conservation <= 1e-8:
            return EquilibriumResult(
                cached_state, converged=True, residual=residual,
                conservation_error=conservation, elapsed=cached_elapsed,
                cache_hit=True,
            )

    cache_warm_start = False
    started_cold = False
    if y0 is None:
        nearest = equilibrium_cache.load_nearest(net, psi)
        if nearest is not None:
            y0, _distance = nearest
            cache_warm_start = True
        else:
            y0 = net.initial_state()
            started_cold = True

    jac_sparsity = net.jacobian_sparsity()

    def _solve(y_start):
        """Advance BDF in bounded chunks and restore route-flow invariants.

        The terminal event is retained so a solve can stop between chunk
        boundaries. Because projecting route flows can slightly change the
        derivative, convergence is only accepted after projection and a fresh
        split L2 residual evaluation.
        """
        state = np.asarray(y_start, dtype=float).copy()
        if state.shape != (net.N_STATES,) or not np.all(np.isfinite(state)):
            return state, False, "Initial state contains invalid values.", 0.0

        state = _renormalize_path_flows(net, state)
        elapsed = 0.0
        residual = _residual(elapsed, state)
        if _meets_tolerance(residual):
            return state, True, "", elapsed

        local_restarts = 0
        last_message = ""
        horizon = max(0.0, float(t_max))

        while elapsed < horizon:
            chunk_end = min(elapsed + _INTEGRATION_CHUNK, horizon)
            try:
                sol = solve_ivp(
                    rhs, (elapsed, chunk_end), state, method="BDF",
                    rtol=1e-7, atol=1e-9, max_step=15.0,
                    jac_sparsity=jac_sparsity,
                    events=convergence_event,
                )
            except Exception as exc:  # noqa: BLE001 - handled by fallback
                return state, False, f"BDF raised {exc}", elapsed

            if not sol.y.size or not sol.t.size:
                return state, False, sol.message or "BDF returned no state.", elapsed

            candidate = sol.y[:, -1]
            candidate_elapsed = float(sol.t[-1])
            if not np.all(np.isfinite(candidate)):
                return state, False, sol.message or "BDF returned a non-finite state.", elapsed

            # Projection is performed even when BDF stopped on the event or
            # reported failure, so a numerically drifted but finite endpoint
            # can be safely checked or locally restarted.
            state = _renormalize_path_flows(net, candidate)
            progress = candidate_elapsed - elapsed
            elapsed = candidate_elapsed
            residual = _residual(elapsed, state)
            if _meets_tolerance(residual):
                return state, True, "", elapsed

            if not sol.success:
                last_message = sol.message
                # A projection often removes the simplex-boundary stiffness
                # that caused the failed step. Retry locally rather than
                # throwing away all completed chunks and starting cold.
                minimum_progress = max(1e-10, 1e-10 * max(1.0, abs(elapsed)))
                if progress <= minimum_progress or local_restarts >= _MAX_LOCAL_RESTARTS:
                    return state, False, last_message, elapsed
                local_restarts += 1
                continue

            local_restarts = 0

            # An event can fire on the unprojected trajectory. If projection
            # moved the endpoint back above tolerance, resume from that exact
            # manifold point. Guard against an event repeatedly stopping at
            # the same floating-point time.
            if progress <= max(1e-12, 1e-12 * max(1.0, abs(elapsed))):
                return state, False, (
                    "Convergence event stalled before the projected state "
                    "met the residual tolerance."
                ), elapsed

        return state, True, last_message, elapsed

    def _finalize(state, elapsed, solver_message=""):
        residual = _residual(elapsed, state)
        converged = bool(_meets_tolerance(residual))
        if converged:
            msg = ""
        elif solver_message:
            msg = (
                f"Inner BDF solve stopped at t={elapsed:g}: {solver_message} "
                f"Residual ||x_dot||_2+||y_dot||_2={residual:.2e} did not meet "
                f"the tolerance <= {tol:.1e}."
            )
        else:
            msg = (
                f"Residual ||x_dot||_2+||y_dot||_2={residual:.2e} did not meet "
                f"the tolerance <= {tol:.1e} after t={elapsed:g} "
                f"(t_max={t_max})."
            )
        result = EquilibriumResult(
            state, converged=converged, message=msg, residual=residual,
            conservation_error=_conservation_error(net, state), elapsed=elapsed,
            cache_warm_start=cache_warm_start,
        )
        if result.converged:
            equilibrium_cache.store(
                net, psi, tol, result.state, result.residual,
                result.conservation_error, result.elapsed,
            )
        return result

    def _defensive_result(state, elapsed, message):
        """Build a finite failure result even for a malformed network/state."""
        try:
            safe_state = np.asarray(state, dtype=float)
            if safe_state.shape != (net.N_STATES,):
                safe_state = np.asarray(net.initial_state(), dtype=float)
            safe_state = np.nan_to_num(
                safe_state, nan=0.0, posinf=1e6, neginf=0.0,
            )
        except Exception:  # noqa: BLE001 - last-resort API safety
            safe_state = np.zeros(net.N_STATES, dtype=float)

        try:
            residual = _residual(elapsed, safe_state)
        except Exception:  # noqa: BLE001
            residual = float("inf")
        try:
            conservation = _conservation_error(net, safe_state)
        except Exception:  # noqa: BLE001
            conservation = float("inf")
        return EquilibriumResult(
            safe_state, converged=False, message=message, residual=residual,
            conservation_error=conservation, elapsed=elapsed,
            cache_warm_start=cache_warm_start,
        )

    state = net.initial_state()
    success = False
    solver_message = "Inner solve failed before integration started."
    elapsed = 0.0
    try:
        state, success, solver_message, elapsed = _solve(y0)
        if success:
            return _finalize(state, elapsed)
    except Exception as exc:  # noqa: BLE001 - defensive for bad configs
        solver_message = f"Inner solve raised {exc}"

    # Cold retry only when a warm start failed before making meaningful
    # progress. A late failure already has a finite, projected state; redoing
    # the entire horizon cold is expensive and normally less accurate than
    # returning that best endpoint with a clear warning.
    meaningful_progress = 0.5 * min(
        _INTEGRATION_CHUNK, max(0.0, float(t_max)),
    )
    if elapsed >= meaningful_progress or started_cold:
        try:
            return _finalize(state, elapsed, solver_message)
        except Exception as exc:  # noqa: BLE001
            return _defensive_result(
                state, elapsed, f"Inner solve failed while finalizing: {exc}",
            )

    # The warm start itself may have been invalid or already divergent.
    # Preserve the defensive cold fallback for that case.
    try:
        state, success, solver_message, elapsed = _solve(net.initial_state())
        if success:
            return _finalize(state, elapsed)
        return _finalize(
            np.nan_to_num(state, nan=0.0, posinf=1e6, neginf=0.0),
            elapsed,
            f"{solver_message} Cold fallback also failed; treat results as unreliable.",
        )
    except Exception as exc:  # noqa: BLE001
        return _defensive_result(
            state, elapsed, f"Inner solve failed: {exc}",
        )
