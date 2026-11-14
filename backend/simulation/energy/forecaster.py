"""The one question the pricing step asks about traffic.

"If these prices are posted, how many vehicles per hour will arrive at each
charger, and how many will it serve, over the next few steps?" Today the
traffic ODE answers it. A reduced network, a surrogate fitted to simulator
output, or a demand model learned from station history can answer it later
by implementing the same method.
"""
from typing import Protocol

import numpy as np


class TrafficForecaster(Protocol):
    def forecast(self, state, t0: float, prices: dict, h: float, n_steps: int) -> dict:
        """Return {charger edge name: {"arrivals": array, "throughput": array}}.

        Both arrays have n_steps entries in vehicles/hour: average arrivals
        during each step of length h from t0, and throughput at its end.
        """


class ODEForecaster:
    """Forecast by integrating the unchanged traffic engine."""

    def __init__(self, net):
        self.net = net

    def occupancy(self, samples) -> dict:
        """Vehicles at each charger from engine state samples (state index x sample)."""
        return {name: np.atleast_1d(samples[self.net.IDX[("xs", edge)]]).astype(float)
                for name, edge in self.net.stations.items()}

    def rates(self, samples) -> dict:
        """Charger throughput from engine state samples."""
        out = {}
        for name, occupancy in self.occupancy(samples).items():
            attrs = self.net.G.edges[self.net.stations[name]]
            out[name] = np.minimum(attrs["a_s"] * occupancy, attrs["mu_s"])
        return out

    def forecast(self, state, t0, prices, h, n_steps):
        _, samples = self.net.advance(state, t0, prices, h, n_steps, return_samples=True)
        x0, r0 = self.occupancy(state), self.rates(state)
        x, r = self.occupancy(samples), self.rates(samples)
        out = {}
        for name in x:
            occupancy = np.concatenate([x0[name], x[name]])
            rate = np.concatenate([r0[name], r[name]])
            # Vehicle balance over each step: arrivals = change in occupancy + departures.
            arrivals = np.diff(occupancy) / h + 0.5 * (rate[:-1] + rate[1:])
            out[name] = {"arrivals": np.maximum(arrivals, 0.0), "throughput": r[name]}
        return out
