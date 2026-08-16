"""Per-station and aggregate metrics, extracted from the duplicated copies
in the original simulator scripts. Logic is unchanged."""
import numpy as np
from simulation.core.network_engine import station_throughput


def station_metrics(net, psi, state):
    d = net._unpack(state)
    profit, rho, occ = {}, {}, {}
    for name, e in net.stations.items():
        attrs = net.G.edges[e]
        x = d["xs"][e]
        r = station_throughput(x, attrs["a_s"], attrs["mu_s"])
        rho[name] = r
        occ[name] = x
        profit[name] = (psi[name] - attrs["c_s"]) * r
    return profit, rho, occ


def total_user_cost(net, psi, state):
    d = net._unpack(state)
    cost = net._path_costs(d, 0.0, psi)
    total = 0.0
    for (od, c), pids in net.groups.items():
        lam_od = next(o for o in net.ods if o["name"] == od)
        lam_tot = lam_od["class_shares"][c] * lam_od["lam_fn"](0.0)
        if len(pids) == 1:
            total += lam_tot * cost[pids[0]]
        else:
            ys = np.array([d["y"][pid] for pid in pids])
            tot_y = ys.sum()
            fracs = ys / tot_y if tot_y > 1e-12 else np.full(len(pids), 1 / len(pids))
            for pid, fr in zip(pids, fracs):
                total += fr * lam_tot * cost[pid]
    return total
