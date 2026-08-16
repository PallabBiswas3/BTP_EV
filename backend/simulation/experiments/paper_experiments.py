"""
The exact two-OD / three-station network from `simulator_paper.py`
(Fig. 2 of the paper), kept separate from the general custom-network
scenarios so "Paper Reproduction" always uses the network the paper's
numbers were computed on, regardless of what i.json/i2.json/i3.json contain.
"""
from simulation.core.network_engine import ChargingNetwork

PAPER_DEFAULTS = dict(
    l0=0.25, L=2.0, a=1.0,
    mu_s=2.0, a_s=0.5, c_s=0.2, phi0=0.1,
    alpha=0.3, gamma=1.0, eta=0.05,
)


def build_paper_network(beta: float = 0.6, lam: float = 1.0) -> ChargingNetwork:
    net = ChargingNetwork(classes=["EV", "NEV"], defaults=PAPER_DEFAULTS)

    net.add_road("O1", "A1")
    net.add_road("A1", "D1", classes=["NEV"])
    net.add_road("O2", "A2")
    net.add_road("A2", "D2", classes=["NEV"])

    net.add_road("O1", "M", l0=0.25)
    net.add_road("O2", "M", l0=0.25)
    net.add_road("N", "D1", l0=0.25)
    net.add_road("N", "D2", l0=0.25)

    net.add_station("A1", "D1", "S1")
    net.add_station("A2", "D2", "S2")
    net.add_station("M", "N", "Sshared")

    net.add_od("OD1", "O1", "D1", lambda t: lam, {"EV": beta, "NEV": 1 - beta})
    net.add_od("OD2", "O2", "D2", lambda t: lam, {"EV": beta, "NEV": 1 - beta})

    net.build(verbose=False)
    return net


# The paper's three named initial-price conditions for Experiment 1.
PAPER_INITIAL_CONDITIONS = {
    "IC-A (uniform low)": {"S1": 0.2, "S2": 0.2, "Sshared": 0.2},
    "IC-B (uniform high)": {"S1": 0.8, "S2": 0.8, "Sshared": 0.8},
    "IC-C (asymmetric)": {"S1": 0.2, "S2": 0.5, "Sshared": 0.35},
}

PAPER_BETA_SWEEP = (0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8)
