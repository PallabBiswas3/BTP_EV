"""Day-ahead energy plan (linear programme) and the BMS dispatch that executes it.

The battery never affects traffic, so the plan needs only a load forecast,
the solar forecast and the grid tariff. It is solved in milliseconds and
redone at every pricing step (receding horizon).
"""
from dataclasses import dataclass

import numpy as np
from scipy.optimize import linprog
from scipy.sparse import lil_matrix


@dataclass
class EnergyPlan:
    grid_charge: np.ndarray    # planned grid -> battery power per slot (kW)
    discharge: np.ndarray      # planned battery -> chargers power per slot (kW)
    marginal_cost: np.ndarray  # cost of one more kWh of charger load per slot
    cost: float                # planned energy cost over the horizon


def plan_energy(load, solar, price, battery, dt, e_now) -> EnergyPlan:
    """Minimise energy cost over the horizon subject to the BMS limits.

    load, solar, price: arrays over the horizon slots (kW, kW, money/kWh).
    dt: slot length in hours. e_now: stored energy now (kWh).
    """
    load = np.asarray(load, dtype=float)
    solar = np.asarray(solar, dtype=float)
    price = np.asarray(price, dtype=float)
    n = len(load)

    if battery.capacity_kwh <= 0:
        # No storage: solar first, grid for the shortfall. Extra load is free only below solar output.
        shortfall = np.maximum(load - solar, 0.0)
        marginal = np.where(load < solar, 0.0, price)
        return EnergyPlan(np.zeros(n), np.zeros(n), marginal, float(dt * price @ shortfall))

    # Variables per slot: solar->load, grid->load, battery->load, solar->battery, grid->battery; then E[1..n].
    SL, GL, D, CS, CG, E = (k * n for k in range(6))
    n_var = 6 * n
    cost = np.zeros(n_var)
    cost[GL:GL + n] = dt * price
    cost[CG:CG + n] = dt * price
    cost[D:D + n] = dt * battery.degradation_cost

    a_eq = lil_matrix((2 * n, n_var))
    b_eq = np.zeros(2 * n)
    for k in range(n):
        a_eq[k, SL + k] = a_eq[k, GL + k] = a_eq[k, D + k] = 1.0     # load balance
        b_eq[k] = load[k]
        row = n + k                                                   # stored-energy balance
        a_eq[row, E + k] = 1.0
        a_eq[row, CS + k] = a_eq[row, CG + k] = -dt * battery.eta_c
        a_eq[row, D + k] = dt / battery.eta_d
        if k == 0:
            b_eq[row] = e_now
        else:
            a_eq[row, E + k - 1] = -1.0

    a_ub = lil_matrix((2 * n + 1, n_var))
    b_ub = np.zeros(2 * n + 1)
    for k in range(n):
        a_ub[k, SL + k] = a_ub[k, CS + k] = 1.0                       # solar available
        b_ub[k] = solar[k]
        a_ub[n + k, CS + k] = a_ub[n + k, CG + k] = 1.0               # charger power limit
        b_ub[n + k] = battery.max_charge_kw
    # End the horizon no emptier than it began, so the plan cannot simply drain the battery.
    a_ub[2 * n, E + n - 1] = -1.0
    b_ub[2 * n] = -e_now

    lo, hi = min(battery.e_min, e_now), max(battery.e_max, e_now)
    bounds = ([(0, None)] * (2 * n) + [(0, battery.max_discharge_kw)] * n
              + [(0, None)] * (2 * n) + [(lo, hi)] * n)
    res = linprog(cost, A_ub=a_ub.tocsr(), b_ub=b_ub, A_eq=a_eq.tocsr(), b_eq=b_eq,
                  bounds=bounds, method="highs")
    if res.status != 0:
        raise RuntimeError(f"Energy plan failed: {res.message}")
    marginal = np.maximum(res.eqlin.marginals[:n] / dt, 0.0)
    return EnergyPlan(res.x[CG:CG + n].copy(), res.x[D:D + n].copy(), marginal, float(res.fun))


@dataclass
class Dispatch:
    solar_to_load: float
    solar_to_battery: float
    solar_curtailed: float
    grid_to_load: float
    grid_to_battery: float
    battery_to_load: float
    energy_after: float


def dispatch(load, solar, plan_grid_charge, plan_discharge, battery, dt, e_now) -> Dispatch:
    """Serve the actual load for one step; the BMS limits override the plan.

    Solar always serves the chargers first and its surplus charges the
    battery; the plan only decides battery discharge and grid charging.
    """
    solar_to_load = min(solar, load)
    shortfall = load - solar_to_load
    surplus = solar - solar_to_load

    if battery.capacity_kwh <= 0:
        return Dispatch(solar_to_load, 0.0, surplus, shortfall, 0.0, 0.0, 0.0)

    deliverable = max(e_now - battery.e_min, 0.0) * battery.eta_d / dt
    discharge_kw = max(min(plan_discharge, shortfall, battery.max_discharge_kw, deliverable), 0.0)
    energy = e_now - dt * discharge_kw / battery.eta_d

    room = max(battery.e_max - energy, 0.0) / (battery.eta_c * dt)
    solar_to_battery = max(min(surplus, battery.max_charge_kw, room), 0.0)
    # The BMS never charges and discharges in the same step.
    grid_to_battery = 0.0 if discharge_kw > 0 else max(
        min(plan_grid_charge, battery.max_charge_kw - solar_to_battery, room - solar_to_battery), 0.0)
    energy += dt * battery.eta_c * (solar_to_battery + grid_to_battery)

    return Dispatch(
        solar_to_load, solar_to_battery, surplus - solar_to_battery,
        shortfall - discharge_kw, grid_to_battery, discharge_kw, energy,
    )
