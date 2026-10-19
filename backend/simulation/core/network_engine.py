"""Physical-time engine matching the supplied dynamic-ev-pricing model.

Shared conservation and replicator equations are inherited from the preserved
engine. Routes and occupancy-based latency follow the reference; advance()
uses its BDF window, tolerances, maximum step and state floors.
"""
import networkx as nx
import numpy as np
from scipy.integrate import solve_ivp

from simulation.core.legacy_network_engine import (
    ChargingNetwork as LegacyChargingNetwork,
    station_cost,
    station_throughput as station_throughput,
    waiting_time as waiting_time,
)


def latency(x_total, l0, L, a=1.0):
    """Reference latency uses occupancy/L; a remains a discharge coefficient."""
    ratio = np.clip(x_total / L, 0.0, 0.999999)
    return l0 * ratio / (1.0 - ratio)


class ChargingNetwork(LegacyChargingNetwork):
    def __init__(self, classes, defaults=None, path_settings=None):
        # Accuracy profiles are retained at the API boundary for compatibility.
        super().__init__(classes, defaults, path_settings=None)
        self.max_paths_per_group = 5  # NEV cap; EVs have one route per station.
        self.cutoff_fallback_groups = []

    def _bounded_feasible_paths(self, od, vehicle_class):
        roads = nx.DiGraph()
        for u, v, key, attrs in self.G.edges(keys=True, data=True):
            if attrs["kind"] == "road":
                roads.add_edge(u, v, weight=attrs["l0"], key=key)
        try:
            maximum_cost = 2.0 * nx.shortest_path_length(
                roads, od["origin"], od["dest"], weight="weight",
            )
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            maximum_cost = None

        # Retain the API's explicit class permissions, missing in the CSV script.
        _simple, _keys, stations = self._path_context(vehicle_class)
        if vehicle_class != "EV":
            candidates = self._k_shortest_edge_paths(
                vehicle_class, od["origin"], od["dest"], 5,
            )
            return [path for path in candidates if maximum_cost is not None and self._free_flow_path_cost(path) <= maximum_cost]
        if not stations:
            return []

        paths = []
        for station in stations:
            before = self._k_shortest_edge_paths(vehicle_class, od["origin"], station[0], 1)
            after = self._k_shortest_edge_paths(vehicle_class, station[1], od["dest"], 1)
            if before and after:
                path = before[0] + [station] + after[0]
                paths.append(path)
        if maximum_cost is None and paths:
            # The reference silently drops these ODs. Keep charging-enabled
            # connections used by bundled demand-stress networks explicitly.
            maximum_cost = 2.0 * min(self._free_flow_path_cost(path) for path in paths)
            self.cutoff_fallback_groups.append((od['name'], vehicle_class))
        return [path for path in paths if maximum_cost is not None and self._free_flow_path_cost(path) <= maximum_cost]

    def _path_costs(self, d, t, psi_override):
        link_costs = np.empty(len(self._path_cost_edges), dtype=float)
        for index, edge in enumerate(self._path_cost_edges):
            attrs = self.G.edges[edge]
            if attrs["kind"] == "road":
                occupancy = sum(d["xr"].get((edge, cls), 0.0) for cls in self.classes)
                link_costs[index] = latency(occupancy, attrs["l0"], attrs["L"])
            else:
                link_costs[index] = station_cost(
                    d["xs"][edge], self._get_psi(edge, t, psi_override),
                    attrs["phi0"], self.defaults["alpha"], self.defaults["gamma"],
                    attrs["mu_s"] / attrs["a_s"], attrs["mu_s"],
                )
        return dict(zip(self._path_cost_ids, self._path_cost_incidence.dot(link_costs)))

    def _state_floor(self):
        floor = np.zeros(self.N_STATES)
        for pid in self.path_state_keys:
            floor[self.IDX[("y", pid)]] = 1e-12
        return floor

    def advance(self, state, t0, psi_override, h, n_steps=1, return_samples=False):
        """Hold prices fixed and integrate n_steps*h physical time units."""
        if not self._built:
            raise RuntimeError("Call .build() before simulating.")
        if h <= 0 or int(n_steps) != n_steps or n_steps < 1:
            raise ValueError("h must be positive and n_steps a positive integer.")
        n_steps = int(n_steps)
        t1 = t0 + n_steps * h
        times = t0 + h * np.arange(1, n_steps + 1)
        times[-1] = t1
        sol = solve_ivp(
            self.dynamics, (t0, t1), np.asarray(state, dtype=float),
            args=(psi_override,), method="BDF", t_eval=times,
            rtol=1e-8, atol=1e-10, max_step=min(h, 10.0),
        )
        if not sol.success or sol.y.shape[1] != n_steps or not np.all(np.isfinite(sol.y)):
            raise FloatingPointError(f"ODE window [{t0:g}, {t1:g}] failed: {sol.message}")
        samples = np.maximum(sol.y, self._state_floor()[:, None])
        final = samples[:, -1].copy()
        return (final, samples) if return_samples else final

    def simulate_discrete(self, t_end, h=10.0, psi_override=None, y0=None, t0=0.0):
        """Reference fixed-price continuation sampled every h time units."""
        state = self.initial_state() if y0 is None else np.asarray(y0, dtype=float)
        count = int(np.ceil(t_end / h - 1e-9))
        times = t0 + h * np.arange(count + 1)
        states = [state.copy()]
        for time in times[:-1]:
            state = self.advance(state, time, psi_override, h)
            states.append(state.copy())
        return dict(t=times, y=np.column_stack(states), psi_override=psi_override, success=True)

    def post_process(self, res, psi_override=None):
        out = super().post_process(res, psi_override)
        for name in self.stations:
            out[f"revenue_{name}"] = out[f"psi_{name}"] * out[f"rho_{name}"]
        out["total_revenue"] = sum(
            (out[f"revenue_{name}"] for name in self.stations), np.zeros_like(out["t"]),
        )
        return out
