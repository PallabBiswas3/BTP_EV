"""
Core traffic / charging-station / pricing simulation engine.

This module is preserved from the original research code almost verbatim.
The mathematics (traffic dynamics, replicator routing, station buffer
dynamics, path costs, equilibrium solving) is unchanged from the supplied
`network_engine.py`.

ONE deliberate correction was made, documented at the point of change:
see `latency()` below. Everything else is byte-for-byte the same logic
as the original file.
"""
import numpy as np
import scipy.sparse as sp
import networkx as nx
from collections import defaultdict
from scipy.integrate import solve_ivp


def latency(x_total, l0, L, a=1.0):
    """Road latency phi_i(x_i) = l0 * (f_i/L) / (1 - f_i/L), f_i = a_i * x_i.

    FIX vs. the originally supplied code: the original implementation used
    `ratio = x_total / L`, omitting the outflow-rate factor `a_i` that the
    paper's latency definition (Sec. IV-A: "f_i = a_i x_i") requires. Under
    every supplied scenario (i.json/i2.json/i3.json) and the paper's own
    network, a_i = 1.0 everywhere, so this made no numerical difference.
    It would silently diverge from the paper for any custom network with
    a != 1, so the `a` factor is restored here. Passing a=1.0 (the default)
    reproduces the original behavior exactly.
    """
    f = a * x_total
    ratio = np.clip(f / L, 0.0, 0.999999)
    return l0 * ratio / (1.0 - ratio)


def waiting_time(x, Ks, mu_s):
    return max(x - Ks, 0.0) / mu_s


def station_cost(x, psi_s, phi0, alpha, gamma, Ks, mu_s):
    return phi0 + alpha * waiting_time(x, Ks, mu_s) + gamma * psi_s


def station_throughput(x, a_s, mu_s):
    return min(a_s * x, mu_s)


class ChargingNetwork:
    K_PER_SEGMENT = 4
    K_PER_STATION = 2
    MAX_PATHS_PER_GROUP = 8

    def __init__(self, classes, defaults=None, path_settings=None):
        self.classes = list(classes)
        self.defaults = dict(
            l0=0.25, L=2.0, a=1.0,
            mu_s=2.0, a_s=0.5, c_s=0.2, phi0=0.1,
            alpha=0.3, gamma=1.0, eta=0.05,
        )
        if defaults:
            self.defaults.update(defaults)

        path_settings = path_settings or {}
        self.k_per_segment = int(path_settings.get("k_per_segment", self.K_PER_SEGMENT))
        self.k_per_station = int(path_settings.get("k_per_station", self.K_PER_STATION))
        self.max_paths_per_group = int(
            path_settings.get("max_paths_per_group", self.MAX_PATHS_PER_GROUP)
        )

        self.G = nx.MultiDiGraph()
        self.stations = {}
        self.ods = []
        self._built = False

    def add_road(self, u, v, classes=None, l0=None, L=None, a=None, label=None):
        d = self.defaults
        key = self.G.add_edge(
            u, v, kind="road",
            classes=set(classes) if classes else set(self.classes),
            l0=l0 if l0 is not None else d["l0"],
            L=L if L is not None else d["L"],
            a=a if a is not None else d["a"],
            label=label or f"{u}->{v}",
        )
        return (u, v, key)

    def add_station(self, u, v, name, classes=None, mu_s=None, a_s=None,
                     c_s=None, phi0=None, psi=0.0, label=None):
        d = self.defaults
        key = self.G.add_edge(
            u, v, kind="station", name=name,
            classes=set(classes) if classes else {"EV"},
            mu_s=mu_s if mu_s is not None else d["mu_s"],
            a_s=a_s if a_s is not None else d["a_s"],
            c_s=c_s if c_s is not None else d["c_s"],
            phi0=phi0 if phi0 is not None else d["phi0"],
            psi=psi,
            label=label or name,
        )
        e = (u, v, key)
        self.stations[name] = e
        return e

    def add_od(self, name, origin, dest, lam_fn, class_shares):
        self.ods.append(dict(name=name, origin=origin, dest=dest,
                              lam_fn=lam_fn, class_shares=dict(class_shares)))

    def _as_simple_digraph(self, graph):
        """Collapse road multiedges for NetworkX's k-shortest-path search."""
        simple = nx.DiGraph()
        edge_key = {}
        for u, v, key, attrs in graph.edges(keys=True, data=True):
            weight = float(attrs.get("l0", 1.0))
            current = simple.get_edge_data(u, v)
            if current is None or weight < current["weight"]:
                simple.add_edge(u, v, weight=weight)
                edge_key[(u, v)] = key
        return simple, edge_key

    def _k_shortest_edge_paths(self, graph, origin, dest, limit):
        if origin == dest:
            return [[]]
        simple, edge_key = self._as_simple_digraph(graph)
        if origin not in simple or dest not in simple:
            return []
        paths = []
        try:
            for nodes in nx.shortest_simple_paths(simple, origin, dest, weight="weight"):
                paths.append([
                    (nodes[i], nodes[i + 1], edge_key[(nodes[i], nodes[i + 1])])
                    for i in range(len(nodes) - 1)
                ])
                if len(paths) > limit:
                    self._path_search_truncated = True
                    break
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            return []
        return paths[:limit]

    def _free_flow_path_cost(self, edges):
        total = 0.0
        for edge in edges:
            attrs = self.G.edges[edge]
            total += float(attrs["l0"] if attrs["kind"] == "road" else attrs["phi0"])
        return total

    def _bounded_feasible_paths(self, od, vehicle_class):
        """Return a small, ranked route set conforming to the paper.

        NEV paths contain no station links. EV paths contain exactly one.
        Keeping only realistic shortest alternatives avoids the exponential
        all-simple-path explosion on cyclic road networks.
        """
        allowed = [
            (u, v, key) for u, v, key, attrs in self.G.edges(keys=True, data=True)
            if vehicle_class in attrs["classes"]
        ]
        roads = [edge for edge in allowed if self.G.edges[edge]["kind"] == "road"]
        stations = [edge for edge in allowed if self.G.edges[edge]["kind"] == "station"]
        road_graph = self.G.edge_subgraph(roads)

        if not stations:
            return self._k_shortest_edge_paths(
                road_graph, od["origin"], od["dest"], self.max_paths_per_group,
            )

        candidates_by_station = []
        for station_edge in stations:
            u_station, v_station, _ = station_edge
            before = self._k_shortest_edge_paths(
                road_graph, od["origin"], u_station, self.k_per_segment,
            )
            after = self._k_shortest_edge_paths(
                road_graph, v_station, od["dest"], self.k_per_segment,
            )
            candidates = []
            seen = set()
            for prefix in before:
                prefix_nodes = {u_station, *(edge[0] for edge in prefix)}
                for suffix in after:
                    suffix_nodes = {v_station, *(edge[1] for edge in suffix)}
                    if prefix_nodes & suffix_nodes:
                        continue
                    path = prefix + [station_edge] + suffix
                    signature = tuple(path)
                    if signature not in seen:
                        seen.add(signature)
                        candidates.append(path)
            candidates.sort(key=self._free_flow_path_cost)
            if candidates:
                if len(candidates) > self.k_per_station:
                    self._path_search_truncated = True
                candidates_by_station.append(candidates[:self.k_per_station])

        # Preserve station diversity first, then fill the remaining route
        # budget with the best alternatives across all reachable stations.
        selected = [paths[0] for paths in candidates_by_station]
        remaining = [path for paths in candidates_by_station for path in paths[1:]]
        remaining.sort(key=self._free_flow_path_cost)
        remaining_slots = max(0, self.max_paths_per_group - len(selected))
        if len(remaining) > remaining_slots:
            self._path_search_truncated = True
        selected.extend(remaining[:remaining_slots])
        return selected[:self.max_paths_per_group]

    def build(self, max_path_length=None, verbose=True):
        G = self.G
        self.path_edges = {}
        self.path_class = {}
        self.path_od = {}
        self.groups = {}
        self.route_limit_hits = []

        for od in self.ods:
            for c in self.classes:
                if c not in od["class_shares"] or od["class_shares"][c] == 0:
                    continue
                self._path_search_truncated = False
                paths = self._bounded_feasible_paths(od, c)
                if not paths:
                    raise ValueError(
                        f"No feasible path found for OD '{od['name']}' "
                        f"class '{c}' ({od['origin']} -> {od['dest']}). "
                        f"Check link 'classes' assignments."
                    )
                if self._path_search_truncated:
                    self.route_limit_hits.append((od["name"], c))
                pids = []
                used_names = set()
                for edges in paths:
                    stations_on_path = [
                        G.edges[e]["name"] for e in edges
                        if G.edges[e]["kind"] == "station"
                    ]
                    base = f"{od['name']}_{c}_" + (
                        "_".join(stations_on_path) if stations_on_path else "direct")
                    pid = base
                    k = 2
                    while pid in used_names:
                        pid = f"{base}#{k}"
                        k += 1
                    used_names.add(pid)
                    self.path_edges[pid] = edges
                    self.path_class[pid] = c
                    self.path_od[pid] = od["name"]
                    pids.append(pid)
                self.groups[(od["name"], c)] = pids

        self.edge_users = defaultdict(list)
        self.edge_injects = defaultdict(list)
        self.transitions = defaultdict(list)
        for pid, edges in self.path_edges.items():
            for e in edges:
                self.edge_users[e].append(pid)
            self.edge_injects[edges[0]].append(pid)
            for i in range(len(edges) - 1):
                self.transitions[edges[i]].append((edges[i + 1], pid))

        road_state_keys = set()
        station_edges = set(self.stations.values())
        for pid, edges in self.path_edges.items():
            c = self.path_class[pid]
            for e in edges:
                if G.edges[e]["kind"] == "road":
                    road_state_keys.add((e, c))
                else:
                    station_edges.add(e)
        self.road_state_keys = sorted(road_state_keys, key=lambda k: (k[0], k[1]))
        self.station_edges = sorted(station_edges)
        self.game_groups = {k: v for k, v in self.groups.items() if len(v) > 1}
        self.path_state_keys = [pid for pids in self.game_groups.values() for pid in pids]

        # Path costs are evaluated at every ODE right-hand-side call.  The
        # previous implementation recomputed a link's latency/cost once for
        # every path containing it, even though that value is identical for
        # all paths at a given (t, state).  Build a path-link incidence matrix
        # once so each unique link cost can be evaluated once and distributed
        # to all paths with a sparse matrix-vector product.
        #
        # Keep links in first-use order and keep each row's column indices in
        # path traversal order.  Besides making the structure deterministic,
        # this retains the old summation order as closely as SciPy's sparse
        # matrix-vector kernel permits.  Raw CSR construction also preserves
        # duplicate edge occurrences should a future path generator allow
        # them.
        self._path_cost_ids = tuple(self.path_edges)
        cost_edges = []
        cost_edge_index = {}
        incidence_indices = []
        incidence_indptr = [0]
        for pid in self._path_cost_ids:
            for edge in self.path_edges[pid]:
                idx = cost_edge_index.get(edge)
                if idx is None:
                    idx = len(cost_edges)
                    cost_edge_index[edge] = idx
                    cost_edges.append(edge)
                incidence_indices.append(idx)
            incidence_indptr.append(len(incidence_indices))
        self._path_cost_edges = tuple(cost_edges)
        self._path_cost_incidence = sp.csr_matrix(
            (
                np.ones(len(incidence_indices), dtype=float),
                np.asarray(incidence_indices, dtype=np.int32),
                np.asarray(incidence_indptr, dtype=np.int32),
            ),
            shape=(len(self._path_cost_ids), len(self._path_cost_edges)),
        )

        # Roads/stations that exist in the topology but carry no feasible-path
        # traffic (e.g. an isolated NEV-only link nobody uses) still deserve
        # to be reported to the frontend for a complete network picture, so we
        # keep a full edge index alongside the state-bearing one.
        self.all_road_edges = sorted(
            (u, v, k) for u, v, k, a in G.edges(keys=True, data=True) if a["kind"] == "road"
        )
        self.all_station_edges = sorted(self.stations.values())

        keys = (
            [("xr", e, c) for (e, c) in self.road_state_keys]
            + [("xs", e) for e in self.station_edges]
            + [("y", pid) for pid in self.path_state_keys]
        )
        self.IDX = {k: i for i, k in enumerate(keys)}
        self.N_STATES = len(keys)
        self.STATE_NAMES = [self._name_key(k) for k in keys]
        self._built = True

        if verbose:
            self._print_build_summary()
        return self

    def jacobian_sparsity(self):
        """Detect and cache the structural Jacobian sparsity for BDF."""
        cached = getattr(self, "_jac_sparsity_cache", None)
        if cached is not None:
            return cached

        reference_psi = {name: 0.5 for name in self.stations}
        n_states = self.N_STATES
        pattern = np.zeros((n_states, n_states), dtype=bool)
        rng = np.random.default_rng(0)
        initial = self.initial_state()
        probes = [initial, np.abs(initial) + 0.05 * rng.random(n_states)]

        for state in probes:
            base = self.dynamics(0.0, state, psi_override=reference_psi)
            for column in range(n_states):
                step = 1e-6 * max(1.0, abs(state[column]))
                perturbed = state.copy()
                perturbed[column] += step
                changed = self.dynamics(0.0, perturbed, psi_override=reference_psi)
                pattern[:, column] |= (np.abs(changed - base) / step) > 1e-8

        np.fill_diagonal(pattern, True)
        self._jac_sparsity_cache = sp.csr_matrix(pattern)
        return self._jac_sparsity_cache

    def _name_key(self, k):
        if k[0] == "xr":
            _, e, c = k
            return f"x_{self.G.edges[e]['label']}_{c}"
        if k[0] == "xs":
            _, e = k
            return f"x_{self.G.edges[e]['name']}"
        _, pid = k
        return f"y_{pid}"

    def _print_build_summary(self):
        print(f"[network_engine] {len(self.ods)} OD pair(s), "
              f"{len(self.stations)} station(s), "
              f"{sum(1 for _, _, a in self.G.edges(data=True) if a['kind'] == 'road')} road link(s)")
        for (od, c), pids in self.groups.items():
            tag = "route-choice game" if len(pids) > 1 else "single feasible path"
            print(f"  OD='{od}' class='{c}': {len(pids)} path(s) [{tag}] -> {pids}")
        print(f"  Total ODE states: {self.N_STATES} "
              f"({len(self.road_state_keys)} link, {len(self.station_edges)} station, "
              f"{len(self.path_state_keys)} route-choice)")

    def _unpack(self, state):
        xr = {(e, c): state[self.IDX[("xr", e, c)]] for (e, c) in self.road_state_keys}
        xs = {e: state[self.IDX[("xs", e)]] for e in self.station_edges}
        y = {pid: state[self.IDX[("y", pid)]] for pid in self.path_state_keys}
        return dict(xr=xr, xs=xs, y=y)

    def _get_psi(self, e, t, psi_override):
        name = self.G.edges[e]["name"]
        if psi_override and name in psi_override:
            val = psi_override[name]
        else:
            val = self.G.edges[e]["psi"]
        return val(t) if callable(val) else val

    def initial_state(self):
        state = np.zeros(self.N_STATES)
        for (od_name, c), pids in self.game_groups.items():
            od = next(o for o in self.ods if o["name"] == od_name)
            lam0 = od["class_shares"][c] * od["lam_fn"](0.0)
            for pid in pids:
                state[self.IDX[("y", pid)]] = lam0 / len(pids)
        return state

    def dynamics(self, t, state, psi_override=None):
        if not self._built:
            raise RuntimeError("Call .build() before simulating.")
        G = self.G
        d = self._unpack(state)
        p = self.defaults

        lam = {}
        for od in self.ods:
            L = od["lam_fn"](t)
            for c, share in od["class_shares"].items():
                lam[(od["name"], c)] = share * L

        q = {}
        for key, pids in self.groups.items():
            total_lam = lam[key]
            if len(pids) == 1:
                q[pids[0]] = total_lam
            else:
                ys = np.array([d["y"][pid] for pid in pids])
                tot_y = ys.sum()
                fracs = ys / tot_y if tot_y > 1e-12 else np.full(len(pids), 1.0 / len(pids))
                for pid, fr in zip(pids, fracs):
                    q[pid] = fr * total_lam

        outflow_road = {}
        for (e, c) in self.road_state_keys:
            outflow_road[(e, c)] = G.edges[e]["a"] * d["xr"][(e, c)]
        outflow_station = {}
        for e in self.station_edges:
            a_s, mu_s = G.edges[e]["a_s"], G.edges[e]["mu_s"]
            outflow_station[e] = station_throughput(d["xs"][e], a_s, mu_s)

        arrival_road = defaultdict(float)
        arrival_station = defaultdict(float)
        for e, pids in self.edge_injects.items():
            kind = G.edges[e]["kind"]
            for pid in pids:
                if kind == "road":
                    arrival_road[(e, self.path_class[pid])] += q[pid]
                else:
                    arrival_station[e] += q[pid]

        for e_from, targets in self.transitions.items():
            kind_from = G.edges[e_from]["kind"]
            if kind_from == "road":
                by_class = defaultdict(list)
                for e_to, pid in targets:
                    by_class[self.path_class[pid]].append((e_to, pid))
                for c, lst in by_class.items():
                    denom = sum(q[pid] for pid in self.edge_users[e_from]
                                if self.path_class[pid] == c)
                    outf = outflow_road[(e_from, c)]
                    if denom < 1e-12:
                        continue
                    for e_to, pid in lst:
                        frac = q[pid] / denom
                        if G.edges[e_to]["kind"] == "road":
                            arrival_road[(e_to, c)] += outf * frac
                        else:
                            arrival_station[e_to] += outf * frac
            else:
                denom = sum(q[pid] for pid in self.edge_users[e_from])
                outf = outflow_station[e_from]
                if denom < 1e-12:
                    continue
                for e_to, pid in targets:
                    frac = q[pid] / denom
                    c = self.path_class[pid]
                    if G.edges[e_to]["kind"] == "road":
                        arrival_road[(e_to, c)] += outf * frac
                    else:
                        arrival_station[e_to] += outf * frac

        out = np.zeros(self.N_STATES)
        for (e, c) in self.road_state_keys:
            out[self.IDX[("xr", e, c)]] = arrival_road[(e, c)] - outflow_road[(e, c)]
        for e in self.station_edges:
            out[self.IDX[("xs", e)]] = arrival_station[e] - outflow_station[e]

        if self.game_groups:
            cost = self._path_costs(d, t, psi_override)
            eta = p["eta"]
            for key, pids in self.game_groups.items():
                total_lam = lam[key]
                ys = np.array([d["y"][pid] for pid in pids])
                costs = np.array([cost[pid] for pid in pids])
                avg = np.dot(ys, costs) / total_lam if total_lam > 1e-12 else 0.0
                for pid, y_val, c_val in zip(pids, ys, costs):
                    out[self.IDX[("y", pid)]] = eta * y_val * (avg - c_val)
        return out

    def _path_costs(self, d, t, psi_override):
        G, p = self.G, self.defaults
        link_costs = np.empty(len(self._path_cost_edges), dtype=float)
        for idx, e in enumerate(self._path_cost_edges):
            attrs = G.edges[e]
            if attrs["kind"] == "road":
                xtot = sum(d["xr"].get((e, cc), 0.0) for cc in self.classes)
                link_costs[idx] = latency(
                    xtot, attrs["l0"], attrs["L"], attrs["a"],
                )
            else:
                psi_val = self._get_psi(e, t, psi_override)
                Ks = attrs["mu_s"] / attrs["a_s"]
                link_costs[idx] = station_cost(
                    d["xs"][e], psi_val, attrs["phi0"], p["alpha"],
                    p["gamma"], Ks, attrs["mu_s"],
                )

        totals = self._path_cost_incidence.dot(link_costs)
        return dict(zip(self._path_cost_ids, totals))

    def simulate(self, t_end, pts_per_unit=4.0, psi_override=None,
                 method="RK45", rtol=1e-9, atol=1e-11, y0=None):
        if not self._built:
            self.build()
        state0 = y0 if y0 is not None else self.initial_state()
        n_eval = max(int(t_end * pts_per_unit), 10)
        t_eval = np.linspace(0.0, t_end, n_eval)
        sol = solve_ivp(
            self.dynamics, (0.0, t_end), state0, args=(psi_override,),
            method=method, t_eval=t_eval, rtol=rtol, atol=atol, dense_output=False,
        )
        if not sol.success:
            print(f"[network_engine] WARNING: solver stopped early at t={sol.t[-1]:.3f} "
                  f"(requested t_end={t_end}): {sol.message}. "
                  f"Results after this point are NOT available.")
        return dict(t=sol.t, y=sol.y, psi_override=psi_override, success=sol.success)

    def post_process(self, res, psi_override=None):
        psi_override = psi_override if psi_override is not None else res.get("psi_override")
        T, Y = res["t"], res["y"]
        out = {"t": T}

        def row(key):
            return Y[self.IDX[key], :]

        combined_edge = defaultdict(lambda: np.zeros_like(T))
        for (e, c) in self.road_state_keys:
            lbl = self.G.edges[e]["label"]
            series = row(("xr", e, c))
            out[f"x_{lbl}_{c}"] = series
            combined_edge[lbl] += series
        for lbl, series in combined_edge.items():
            out[f"x_{lbl}"] = series

        lam_od = {}
        for od in self.ods:
            lam_od[od["name"]] = np.array([od["lam_fn"](tt) for tt in T])
        out["lam_od"] = lam_od

        for name, e in self.stations.items():
            occ = row(("xs", e))
            attrs = self.G.edges[e]
            rho = np.array([station_throughput(v, attrs["a_s"], attrs["mu_s"]) for v in occ])
            psi_series = np.array([self._get_psi(e, tt, psi_override) for tt in T])
            out[f"occ_{name}"] = occ
            out[f"rho_{name}"] = rho
            out[f"psi_{name}"] = psi_series
            out[f"profit_{name}"] = (psi_series - attrs["c_s"]) * rho

        cost_series = {pid: np.zeros_like(T) for pid in self.path_edges}
        flow_series = {pid: np.zeros_like(T) for pid in self.path_edges}
        for k in range(len(T)):
            state_k = Y[:, k]
            d = self._unpack(state_k)
            lam_k = {}
            for od in self.ods:
                Lval = od["lam_fn"](T[k])
                for c, share in od["class_shares"].items():
                    lam_k[(od["name"], c)] = share * Lval
            cost_k = self._path_costs(d, T[k], psi_override)
            for key, pids in self.groups.items():
                total_lam = lam_k[key]
                if len(pids) == 1:
                    flow_series[pids[0]][k] = total_lam
                else:
                    ys = np.array([d["y"][pid] for pid in pids])
                    tot_y = ys.sum()
                    fracs = ys / tot_y if tot_y > 1e-12 else np.full(len(pids), 1.0 / len(pids))
                    for pid, fr in zip(pids, fracs):
                        flow_series[pid][k] = fr * total_lam
            for pid, cval in cost_k.items():
                cost_series[pid][k] = cval
        for pid in self.path_edges:
            out[f"y_{pid}"] = flow_series[pid]
            out[f"cost_{pid}"] = cost_series[pid]

        out["total_profit"] = sum(out[f"profit_{s}"] for s in self.stations) \
            if self.stations else np.zeros_like(T)
        out["total_user_cost"] = sum(
            out[f"y_{pid}"] * out[f"cost_{pid}"] for pid in self.path_edges
        )
        return out
