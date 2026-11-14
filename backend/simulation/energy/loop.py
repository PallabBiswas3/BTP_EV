"""Pricing loop for sites with fast/slow chargers, solar, battery and grid supply.

Per step of length h:
  1. each site plans its energy for the next day (battery.plan_energy);
  2. each strategic site estimates its profit gradient for every charger
     price by central differences on a traffic forecast, valuing energy at
     the plan's marginal cost, and takes a gradient step;
  3. traffic advances one step under the new prices (unchanged engine);
  4. the BMS dispatch serves the actual load and updates stored energy.

The battery plan is separate from the traffic forecast because travellers
react only to prices and queues, never to the energy source.
"""
import os
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, dataclass

import numpy as np

from simulation.energy.battery import dispatch, plan_energy
from simulation.energy.forecaster import ODEForecaster
from simulation.energy.profiles import slot_of_day


@dataclass
class EnergyOptions:
    t_end: float = 72.0            # simulated hours
    h: float = 0.5                 # pricing step (hours)
    horizon: int = 2               # price look-ahead, in steps of h
    kappa: float = 4.0             # price gradient gain
    delta: float = 5.0             # price perturbation
    profit_mode: str = "mean"      # "mean" over the look-ahead, or "end"
    revenue_on: str = "arrival"    # customers pay on "arrival", or count revenue at "departure"
    substeps: int = 2              # traffic samples per step, for average load
    price_cap: float | None = None
    max_price_change: float | None = 15.0   # per step
    load_memory: float = 0.5       # weight on the previous day's load in the forecast
    min_route_share: float = 0.02  # share of travellers who keep trying each option
    parallel: bool = False
    n_workers: int | None = None

    def validate(self, day_length):
        if self.t_end <= 0 or self.h <= 0 or self.kappa <= 0 or self.delta <= 0:
            raise ValueError("t_end, h, kappa and delta must be positive.")
        if int(self.horizon) < 1 or int(self.substeps) < 1:
            raise ValueError("horizon and substeps must be at least 1.")
        if self.profit_mode not in ("mean", "end"):
            raise ValueError("profit_mode must be 'mean' or 'end'.")
        if self.revenue_on not in ("arrival", "departure"):
            raise ValueError("revenue_on must be 'arrival' or 'departure'.")
        if not 0 <= self.load_memory < 1:
            raise ValueError("load_memory must be in [0, 1).")
        if not 0 <= self.min_route_share < 0.5:
            raise ValueError("min_route_share must be in [0, 0.5).")
        slots = day_length / self.h
        if abs(slots - round(slots)) > 1e-9 or round(slots) < 1:
            raise ValueError("The day length must be a whole number of steps h.")
        if round(self.t_end / self.h) < 1:
            raise ValueError("t_end/h must round to at least one step.")
        for name in ("price_cap", "max_price_change"):
            value = getattr(self, name)
            if value is not None and value <= 0:
                raise ValueError(f"{name} must be positive when given.")
        if self.n_workers is not None and self.n_workers < 1:
            raise ValueError("n_workers must be at least 1.")


_WORKER_FORECASTER = None


def _init_worker(forecaster):
    global _WORKER_FORECASTER
    _WORKER_FORECASTER = forecaster


def _forecast_job(key, state, t0, prices, h, n_steps):
    return key, _WORKER_FORECASTER.forecast(state, t0, prices, h, n_steps)


def keep_exploring(net, state, share):
    """Hold every route option at a minimum share of its group's travellers.

    Replicator dynamics alone can drive an option's share to (numerically)
    zero, after which it cannot recover within a day even when it becomes the
    cheapest. A small exploring share keeps every charger discoverable.
    """
    if share <= 0:
        return state
    state = state.copy()
    for pids in net.game_groups.values():
        index = [net.IDX[("y", pid)] for pid in pids]
        values = state[index]
        state[index] = np.maximum(values, share * values.sum())
    return state


def site_profit(site, prices, forecast, marginal_cost, energy_per_vehicle, mode, revenue_on):
    """Forecast operating profit rate of one site, summed over its chargers:
    price x paying vehicles - marginal energy cost per vehicle x throughput."""
    series = 0.0
    for edge in site.edges:
        served = forecast[edge]["throughput"]
        paying = forecast[edge]["arrivals"] if revenue_on == "arrival" else served
        series = series + prices[edge] * paying - marginal_cost[:len(served)] * energy_per_vehicle * served
    return float(series[-1]) if mode == "end" else float(np.mean(series))


def run_energy_pricing(scenario, options: EnergyOptions | None = None, progress_cb=None,
                       forecaster=None) -> dict:
    opts = options or EnergyOptions()
    opts.validate(scenario.day_length)
    net, sites = scenario.net, scenario.sites
    h, per_vehicle = opts.h, scenario.energy_per_vehicle
    horizon, substeps = int(opts.horizon), int(opts.substeps)
    n_steps = int(round(opts.t_end / h))
    slots = int(round(scenario.day_length / h))
    engine = ODEForecaster(net)            # the simulated world always uses the engine
    forecaster = forecaster or engine      # the controller's forecaster can be replaced

    prices = {c.edge: float(c.initial_price) for s in sites for c in s.chargers}
    stored = {s.name: s.battery.e_init for s in sites}
    # Load forecast per slot of the day; starts as a guess and is replaced by observed load.
    load_profile = {s.name: np.full(slots, 0.5 * sum(c.count * c.power_kw for c in s.chargers))
                    for s in sites}
    seen = {s.name: np.zeros(slots, dtype=bool) for s in sites}

    state = keep_exploring(net, net.initial_state(), opts.min_route_share)
    t_now, grid_total = 0.0, 0.0
    hist_t, hist_tariff = [], []
    edge_hist = {e: dict(price=[], arrivals=[], throughput=[], occupancy=[], queue=[]) for e in prices}
    site_keys = ("load_kw", "solar_available_kw", "solar_to_load_kw", "solar_to_battery_kw",
                 "solar_curtailed_kw", "grid_to_load_kw", "grid_to_battery_kw", "battery_to_load_kw",
                 "stored_kwh", "marginal_cost", "revenue_rate", "energy_cost_rate", "profit_rate")
    site_hist = {s.name: {k: [] for k in site_keys} for s in sites}

    strategic = [(s, c) for s in sites if s.strategic for c in s.chargers]
    # Half the logical CPUs by default: one process per logical CPU exhausted memory in testing.
    workers = opts.n_workers or max(1, min(2 * len(strategic), (os.cpu_count() or 2) // 2))
    pool = (ProcessPoolExecutor(max_workers=workers, initializer=_init_worker, initargs=(forecaster,))
            if opts.parallel and strategic else None)
    started = time.perf_counter()
    if progress_cb:
        progress_cb(0, n_steps)
    try:
        for step in range(n_steps):
            slot = slot_of_day(t_now, scenario.day_length, slots)
            window = [(t_now + k * h, t_now + (k + 1) * h) for k in range(slots)]
            # Stations are price takers: the load surcharge uses the last observed grid draw.
            surcharge = scenario.grid_load_coefficient * grid_total
            tariff = np.array([scenario.tariff.mean(a, b) for a, b in window]) + surcharge

            plans = {}
            for s in sites:
                order = (slot + np.arange(slots)) % slots
                solar = np.array([s.solar.mean(a, b) for a, b in window])
                plans[s.name] = plan_energy(load_profile[s.name][order], solar, tariff,
                                            s.battery, h, stored[s.name])

            jobs = []
            for s, c in strategic:
                for sign in (+1, -1):
                    trial = dict(prices)
                    trial[c.edge] = max(prices[c.edge] + sign * opts.delta, 0.0)
                    jobs.append(((s.name, c.edge, sign), state, t_now, trial, h, horizon))
            if pool is not None:
                outs = [f.result() for f in [pool.submit(_forecast_job, *j) for j in jobs]]
            else:
                # Serial runs call the forecaster directly, so concurrent runs share no global.
                outs = [(j[0], forecaster.forecast(*j[1:])) for j in jobs]
            trials = {j[0]: j[3] for j in jobs}
            forecasts = dict(outs)

            new_prices = dict(prices)
            for s, c in strategic:
                marginal = plans[s.name].marginal_cost
                up, down = (s.name, c.edge, +1), (s.name, c.edge, -1)
                gap = trials[up][c.edge] - trials[down][c.edge]
                gradient = 0.0 if gap <= 1e-9 else (
                    site_profit(s, trials[up], forecasts[up], marginal, per_vehicle,
                                opts.profit_mode, opts.revenue_on)
                    - site_profit(s, trials[down], forecasts[down], marginal, per_vehicle,
                                  opts.profit_mode, opts.revenue_on)
                ) / gap
                change = opts.kappa * gradient
                if opts.max_price_change is not None:
                    change = float(np.clip(change, -opts.max_price_change, opts.max_price_change))
                value = max(prices[c.edge] + change, 0.0)
                new_prices[c.edge] = min(value, opts.price_cap) if opts.price_cap is not None else value
            prices = new_prices

            before, occupancy_before = engine.rates(state), engine.occupancy(state)
            new_state, samples = net.advance(state, t_now, prices, h / substeps, substeps,
                                             return_samples=True)
            after = engine.rates(samples)
            # Trapezoidal average of throughput over the step (end value when substeps == 1).
            mean_rate = {
                e: float(after[e][-1]) if substeps == 1 else float(
                    (0.5 * before[e][0] + after[e][:-1].sum() + 0.5 * after[e][-1]) / substeps)
                for e in prices
            }
            occupancy_after = engine.occupancy(new_state)
            # Vehicle balance over the step: arrivals = change in occupancy + departures.
            mean_arrivals = {
                e: max((occupancy_after[e][0] - occupancy_before[e][0]) / h + mean_rate[e], 0.0)
                for e in prices
            }
            paying = mean_arrivals if opts.revenue_on == "arrival" else mean_rate
            state = keep_exploring(net, new_state, opts.min_route_share)
            t_prev, t_now = t_now, t_now + h

            tariff_now = float(tariff[0])
            grid_total = 0.0
            for s in sites:
                load = per_vehicle * sum(mean_rate[e] for e in s.edges)
                solar = s.solar.mean(t_prev, t_now)
                plan = plans[s.name]
                d = dispatch(load, solar, float(plan.grid_charge[0]), float(plan.discharge[0]),
                             s.battery, h, stored[s.name])
                stored[s.name] = d.energy_after
                grid_kw = d.grid_to_load + d.grid_to_battery
                grid_total += grid_kw
                revenue = sum(prices[e] * paying[e] for e in s.edges)
                energy_cost = tariff_now * grid_kw + s.battery.degradation_cost * d.battery_to_load
                fixed = (s.fixed_cost_per_day + s.maintenance_per_day) / scenario.day_length

                memory = opts.load_memory if seen[s.name][slot] else 0.0
                load_profile[s.name][slot] = memory * load_profile[s.name][slot] + (1 - memory) * load
                seen[s.name][slot] = True

                row = site_hist[s.name]
                for key, value in (
                    ("load_kw", load), ("solar_available_kw", solar),
                    ("solar_to_load_kw", d.solar_to_load), ("solar_to_battery_kw", d.solar_to_battery),
                    ("solar_curtailed_kw", d.solar_curtailed), ("grid_to_load_kw", d.grid_to_load),
                    ("grid_to_battery_kw", d.grid_to_battery), ("battery_to_load_kw", d.battery_to_load),
                    ("stored_kwh", d.energy_after), ("marginal_cost", float(plan.marginal_cost[0])),
                    ("revenue_rate", revenue), ("energy_cost_rate", energy_cost),
                    ("profit_rate", revenue - energy_cost - fixed),
                ):
                    row[key].append(float(value))

            unpacked = net._unpack(state)
            for name, edge in net.stations.items():
                attrs = net.G.edges[edge]
                occupancy = float(unpacked["xs"][edge])
                edge_hist[name]["price"].append(prices[name])
                edge_hist[name]["arrivals"].append(mean_arrivals[name])
                edge_hist[name]["throughput"].append(mean_rate[name])
                edge_hist[name]["occupancy"].append(occupancy)
                edge_hist[name]["queue"].append(max(occupancy - attrs["mu_s"] / attrs["a_s"], 0.0))
            hist_t.append(t_now)
            hist_tariff.append(tariff_now)
            if progress_cb:
                progress_cb(step + 1, n_steps)
    finally:
        if pool is not None:
            pool.shutdown()

    return _result(scenario, opts, hist_t, hist_tariff, edge_hist, site_hist, state,
                   time.perf_counter() - started, len(strategic))


def _totals(site, rows, edges, h, start, per_vehicle, day_length):
    """Money and energy totals for one site over steps [start, end)."""
    def total(key):
        return h * float(np.sum(rows[key][start:]))

    steps = len(rows["load_kw"]) - start
    load = total("load_kw")
    fixed = (site.fixed_cost_per_day + site.maintenance_per_day) * steps * h / day_length
    revenue, energy_cost = total("revenue_rate"), total("energy_cost_rate")
    share = (lambda key: total(key) / load) if load > 1e-12 else (lambda key: 0.0)
    return {
        "hours": steps * h,
        "revenue": revenue, "energy_cost": energy_cost, "fixed_cost": fixed,
        "profit": revenue - energy_cost - fixed,
        "vehicles_served": load / per_vehicle,
        "energy_delivered_kwh": load,
        "grid_energy_bought_kwh": total("grid_to_load_kw") + total("grid_to_battery_kw"),
        "solar_curtailed_kwh": total("solar_curtailed_kw"),
        "share_solar_direct": share("solar_to_load_kw"),
        "share_battery": share("battery_to_load_kw"),
        "share_grid_direct": share("grid_to_load_kw"),
        "average_price": {
            edges[e]["mode"]: float(np.mean(edges[e]["price"][start:])) for e in site.edges
        },
    }


def _result(scenario, opts, hist_t, hist_tariff, edge_hist, site_hist, state, elapsed, n_strategic):
    slots = int(round(scenario.day_length / opts.h))
    n = len(hist_t)
    last_day = max(n - slots, 0)
    chargers = {}
    for s in scenario.sites:
        for c in s.chargers:
            chargers[c.edge] = dict(site=s.name, mode=c.mode, count=c.count, power_kw=c.power_kw,
                                    **edge_hist[c.edge])
    sites = {}
    for s in scenario.sites:
        rows = site_hist[s.name]
        capacity = s.battery.capacity_kwh
        sites[s.name] = dict(
            strategic=s.strategic, has_solar=s.has_solar, has_storage=s.has_storage,
            chargers=s.edges, solar_peak_kw=s.solar.base, battery_capacity_kwh=capacity,
            soc=[e / capacity if capacity > 0 else 0.0 for e in rows["stored_kwh"]],
            **rows,
            summary=_totals(s, rows, chargers, opts.h, 0, scenario.energy_per_vehicle, scenario.day_length),
            last_day=_totals(s, rows, chargers, opts.h, last_day, scenario.energy_per_vehicle,
                             scenario.day_length),
        )
    warnings = []
    if n < 2 * slots:
        warnings.append("The first simulated day uses a guessed load forecast; run at least two "
                        "days and read the last-day summary.")
    return {
        "model": "energy-pricing",
        "units": {"time": "hour", "power": "kW", "energy": "kWh", "currency": scenario.currency,
                  "price": f"{scenario.currency} per vehicle"},
        "time": hist_t,
        "hour_of_day": [float(np.fmod(t, scenario.day_length)) for t in hist_t],
        "tariff": hist_tariff,
        "chargers": chargers,
        "sites": sites,
        "settings": dict(asdict(opts), day_length=scenario.day_length, steps=n, steps_per_day=slots,
                         energy_per_vehicle_kwh=scenario.energy_per_vehicle,
                         grid_load_coefficient=scenario.grid_load_coefficient,
                         forecasts_per_step=2 * n_strategic, state_count=net_states(scenario),
                         wall_time_seconds=elapsed),
        "final_state": [float(v) for v in state],
        "warnings": warnings,
    }


def net_states(scenario):
    return int(scenario.net.N_STATES)
