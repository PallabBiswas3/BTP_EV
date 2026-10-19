"""Reference single-window BDF equilibrium forecast with absolute-time demand.

No equilibrium cache or chunk projection is used here. equilibrium.py remains
the preserved solver used by legacy paper experiments.
"""
import numpy as np
from scipy.integrate import solve_ivp

from simulation.pricing.equilibrium import (
    EquilibriumResult, _conservation_error, _state_index_groups,
)


def residual(net, psi, state, t=0.0):
    x_indices, y_indices = _state_index_groups(net)
    derivative = net.dynamics(t, state, psi_override=psi)
    return float(np.linalg.norm(derivative[x_indices]) + np.linalg.norm(derivative[y_indices]))


def solve_equilibrium(net, psi, y0=None, t_max=75000.0, tol=1e-6, t0=0.0):
    initial = net.initial_state() if y0 is None else np.asarray(y0, dtype=float)

    def rhs(t, state):
        return net.dynamics(t, state, psi_override=psi)

    def event(t, state):
        return residual(net, psi, state, t) - tol

    event.terminal = True
    event.direction = -1

    def integrate(state):
        if residual(net, psi, state, t0) < tol:
            return state.copy(), 0.0, True
        sol = solve_ivp(
            rhs, (t0, t0 + t_max), state, method="BDF",
            rtol=1e-8, atol=1e-10, events=event, max_step=10.0,
        )
        if not sol.success or not sol.y.size or not np.all(np.isfinite(sol.y[:, -1])):
            raise FloatingPointError(f"Equilibrium forecast failed: {sol.message}")
        return sol.y[:, -1], float(sol.t[-1] - t0), bool(len(sol.t_events[0]))

    try:
        state, elapsed, converged = integrate(initial)
    except (FloatingPointError, ValueError, RuntimeError):
        state, elapsed, converged = integrate(net.initial_state())
    final_residual = residual(net, psi, state, t0 + elapsed)
    message = "" if converged else f"Equilibrium forecast did not reach tolerance {tol:g} within {t_max:g} time units."
    return EquilibriumResult(
        state, converged, message, final_residual, _conservation_error(net, state), elapsed,
    )
