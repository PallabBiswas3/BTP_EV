"""Orchestrates: build network -> run solver(s) -> serialize to plain JSON.

Every NumPy scalar/array is converted to native Python float/list before
leaving this module, per the "avoid returning NumPy objects directly"
requirement.
"""
import math
from typing import Any

import numpy as np

from simulation.core.network_engine import latency, station_throughput
from simulation.pricing.equilibrium import solve_equilibrium
from simulation.pricing.metrics import station_metrics, total_user_cost
from simulation.pricing.strategic_pricing import outer_loop
from simulation.scenarios.loader import build_network_from_data


def _f(x) -> float:
    """NumPy/np.float64 -> plain Python float, with NaN/Inf made JSON-safe."""
    v = float(x)
    if math.isnan(v) or math.isinf(v):
        return None
    return v


def _arr(a) -> list:
    return [_f(v) for v in np.asarray(a).tolist()]


def _network_options_to_kwargs(opts) -> dict:
    return dict(
        n_steps=opts.n_steps, kappa=opts.kappa, delta=opts.delta,
        dt_outer=opts.dt_outer, psi_max=opts.psi_max, grad_clip=opts.grad_clip,
    )


def build_network(network_config: dict):
    return build_network_from_data(network_config)


def serialize_equilibrium(net, eq_result) -> dict:
    profit, rho, occ = eq_result.profit, eq_result.rho, eq_result.occ
    psi = eq_result.psi
    uc = total_user_cost(net, psi, eq_result.state)
    return {
        "prices": {s: _f(v) for s, v in psi.items()},
        "occupancies": {s: _f(v) for s, v in occ.items()},
        "throughputs": {s: _f(v) for s, v in rho.items()},
        "profits": {s: _f(v) for s, v in profit.items()},
        "total_profit": _f(sum(profit.values())) if profit else 0.0,
        "total_user_cost": _f(uc),
        "converged": bool(eq_result.converged),
        "warnings": list(eq_result.warnings),
    }


def serialize_outer_history(net, hist: dict) -> dict:
    stations = list(net.stations.keys())
    n = len(hist[stations[0]]["psi"]) if stations else 0
    return {
        "step": list(range(n)),
        "stations": {
            s: {
                "price": _arr(hist[s]["psi"]),
                "occupancy": _arr(hist[s]["occ"]),
                "throughput": _arr(hist[s]["rho"]),
                "profit": _arr(hist[s]["profit"]),
            }
            for s in stations
        },
    }


def serialize_trajectory(net, res_pp: dict) -> dict:
    T = res_pp["t"]
    time = _arr(T)

    roads: dict[str, Any] = {}
    labels = sorted({net.G.edges[e]["label"] for e in [k[0] for k in net.road_state_keys]})
    for lbl in labels:
        # Find one representative edge with this label to read static attrs.
        e = next(ek for ek in [k[0] for k in net.road_state_keys] if net.G.edges[ek]["label"] == lbl)
        attrs = net.G.edges[e]
        ev = res_pp.get(f"x_{lbl}_EV")
        nev = res_pp.get(f"x_{lbl}_NEV")
        total = res_pp.get(f"x_{lbl}")
        total_arr = np.asarray(total) if total is not None else np.zeros_like(T)
        lat = np.array([latency(x, attrs["l0"], attrs["L"], attrs["a"]) for x in total_arr])
        cap_ratio = np.clip(attrs["a"] * total_arr / attrs["L"], 0.0, 1.0)
        roads[lbl] = {
            "u": e[0], "v": e[1],
            "classes": sorted(attrs["classes"]),
            "capacity_L": _f(attrs["L"]),
            "ev_density": _arr(ev) if ev is not None else [0.0] * len(time),
            "nev_density": _arr(nev) if nev is not None else [0.0] * len(time),
            "total_density": _arr(total_arr),
            "latency": _arr(lat),
            "capacity_ratio": _arr(cap_ratio),
        }

    stations: dict[str, Any] = {}
    for name, e in net.stations.items():
        attrs = net.G.edges[e]
        Ks = attrs["mu_s"] / attrs["a_s"]
        occ = np.asarray(res_pp[f"occ_{name}"])
        queue = np.maximum(occ - Ks, 0.0)
        wait = queue / attrs["mu_s"]
        stations[name] = {
            "saturation_K": _f(Ks),
            "occupancy": _arr(occ),
            "queue": _arr(queue),
            "waiting_time": _arr(wait),
            "throughput": _arr(res_pp[f"rho_{name}"]),
            "price": _arr(res_pp[f"psi_{name}"]),
            "profit": _arr(res_pp[f"profit_{name}"]),
        }

    paths: dict[str, Any] = {}
    for pid in net.path_edges:
        paths[pid] = {
            "od": net.path_od[pid],
            "vehicle_class": net.path_class[pid],
            "nodes": _path_nodes(net, pid),
            "stations_used": [
                net.G.edges[e]["name"] for e in net.path_edges[pid]
                if net.G.edges[e]["kind"] == "station"
            ],
            "flow": _arr(res_pp[f"y_{pid}"]),
            "cost": _arr(res_pp[f"cost_{pid}"]),
        }

    return {
        "time": time,
        "roads": roads,
        "stations": stations,
        "paths": paths,
        "total_profit": _arr(res_pp["total_profit"]),
        "total_user_cost": _arr(res_pp["total_user_cost"]),
    }


def _path_nodes(net, pid) -> list[str]:
    edges = net.path_edges[pid]
    nodes = [edges[0][0]]
    for e in edges:
        nodes.append(e[1])
    return nodes


def run_simulate(network_config: dict, options, report_progress=None) -> dict:
    def _report(phase, step, n_steps):
        if report_progress:
            report_progress(phase, step, n_steps)

    _report("Preparing network", 0, options.n_steps)
    net = build_network(network_config)
    kwargs = _network_options_to_kwargs(options)
    outer = outer_loop(
        net, psi0=options.psi0,
        progress_cb=lambda step, n: _report(f"Pricing iteration {step}/{n}", step, n),
        **kwargs,
    )

    _report("Generating trajectory", options.n_steps, options.n_steps)
    sim_res = net.simulate(t_end=options.t_end, psi_override=outer.psi, y0=outer.state)
    post = net.post_process(sim_res, psi_override=outer.psi)

    return {
        "equilibrium": serialize_equilibrium(net, outer),
        "outer_history": serialize_outer_history(net, outer.hist),
        "trajectory": serialize_trajectory(net, post),
    }


def run_equilibrium(network_config: dict, options, report_progress=None) -> dict:
    def _report(phase, step, n_steps):
        if report_progress:
            report_progress(phase, step, n_steps)

    _report("Preparing network", 0, options.n_steps)
    net = build_network(network_config)
    kwargs = _network_options_to_kwargs(options)
    outer = outer_loop(
        net, psi0=options.psi0,
        progress_cb=lambda step, n: _report(f"Pricing iteration {step}/{n}", step, n),
        **kwargs,
    )
    return {
        "equilibrium": serialize_equilibrium(net, outer),
        "outer_history": serialize_outer_history(net, outer.hist),
    }


def run_beta_sweep(network_config: dict, options, beta_min: float, beta_max: float,
                    beta_step: float, report_progress=None) -> dict:
    betas = []
    b = beta_min
    while b <= beta_max + 1e-9:
        betas.append(round(b, 6))
        b += beta_step

    stations_ref: list[str] = []
    records: dict[str, dict[str, list]] = {"prices": {}, "throughputs": {}, "occupancies": {}, "profits": {}}
    total_profit, total_user_cost_series = [], []
    warnings: list[str] = []
    kwargs = _network_options_to_kwargs(options)

    for bi, beta in enumerate(betas):
        if report_progress:
            report_progress(f"beta={beta:.2f} ({bi + 1}/{len(betas)})", bi, len(betas))
        cfg = _with_beta(network_config, beta)
        net = build_network(cfg)
        stations = list(net.stations.keys())
        if not stations_ref:
            stations_ref[:] = stations
            for k in records:
                records[k] = {s: [] for s in stations}
        outer = outer_loop(net, psi0={s: 0.4 for s in stations}, **kwargs)
        if outer.warnings:
            warnings.extend([f"beta={beta}: {w}" for w in outer.warnings])
        for s in stations:
            records["prices"][s].append(_f(outer.psi[s]))
            records["throughputs"][s].append(_f(outer.rho[s]))
            records["occupancies"][s].append(_f(outer.occ[s]))
            records["profits"][s].append(_f(outer.profit[s]))
        total_profit.append(_f(sum(outer.profit.values())))
        total_user_cost_series.append(_f(total_user_cost(net, outer.psi, outer.state)))

    return {
        "beta": betas,
        "stations": stations_ref,
        "prices": records["prices"],
        "throughputs": records["throughputs"],
        "occupancies": records["occupancies"],
        "profits": records["profits"],
        "total_profit": total_profit,
        "total_user_cost": total_user_cost_series,
        "warnings": warnings,
    }


def run_compare_pricing(network_config: dict, options) -> dict:
    net_strategic = build_network(network_config)
    kwargs = _network_options_to_kwargs(options)
    outer = outer_loop(net_strategic, psi0=options.psi0, **kwargs)
    stations = list(net_strategic.stations.keys())

    avg_price = sum(outer.psi.values()) / len(outer.psi) if outer.psi else 0.0
    fixed_psi = {s: avg_price for s in stations}

    net_fixed = build_network(network_config)
    eq_fixed = solve_equilibrium(net_fixed, fixed_psi)
    profit_fixed, rho_fixed, occ_fixed = station_metrics(net_fixed, fixed_psi, eq_fixed.state)
    uc_fixed = total_user_cost(net_fixed, fixed_psi, eq_fixed.state)
    uc_strategic = total_user_cost(net_strategic, outer.psi, outer.state)

    return {
        "stations": stations,
        "average_price": _f(avg_price),
        "strategic": {
            "prices": {s: _f(outer.psi[s]) for s in stations},
            "throughputs": {s: _f(outer.rho[s]) for s in stations},
            "occupancies": {s: _f(outer.occ[s]) for s in stations},
            "profits": {s: _f(outer.profit[s]) for s in stations},
            "total_profit": _f(sum(outer.profit.values())),
            "total_user_cost": _f(uc_strategic),
        },
        "fixed": {
            "prices": {s: _f(avg_price) for s in stations},
            "throughputs": {s: _f(rho_fixed[s]) for s in stations},
            "occupancies": {s: _f(occ_fixed[s]) for s in stations},
            "profits": {s: _f(profit_fixed[s]) for s in stations},
            "total_profit": _f(sum(profit_fixed.values())),
            "total_user_cost": _f(uc_fixed),
        },
        "warnings": outer.warnings + ([eq_fixed.message] if not eq_fixed.converged else []),
    }


def _with_beta(network_config: dict, beta: float) -> dict:
    cfg = dict(network_config)
    cfg["ods"] = []
    for od in network_config["ods"]:
        shares = dict(od["shares"])
        if shares.get("EV", 0) > 0 and shares.get("NEV", 0) > 0:
            shares = {**shares, "EV": beta, "NEV": 1 - beta}
        cfg["ods"].append({**od, "shares": shares})
    return cfg
