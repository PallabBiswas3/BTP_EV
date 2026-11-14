"""Scenario parsing for the energy model, in physical units.

Units: time in hours, power in kW, energy in kWh, money in one currency
(the bundled scenario uses rupees). Prices are per vehicle charged.

Each *site* is one owner. Each charger type at a site becomes one station
edge of the unchanged traffic engine, named ``<site>_<mode>``, so travellers
choose between fast and slow through the engine's own route choice.
"""
from dataclasses import dataclass, field

from simulation.core.network_engine import ChargingNetwork
from simulation.energy.profiles import DailyProfile, SolarProfile

FLAT = [1.0] * 24


@dataclass
class Charger:
    mode: str
    count: int
    power_kw: float
    time_weight: float = 1.0      # how strongly travellers dislike this mode's charging time
    initial_price: float = 0.0
    edge: str = ""                # engine station name, "<site>_<mode>"


@dataclass
class Battery:
    capacity_kwh: float = 0.0
    max_charge_kw: float = 0.0
    max_discharge_kw: float = 0.0
    eta_c: float = 0.95
    eta_d: float = 0.95
    soc_min: float = 0.1
    soc_max: float = 0.9
    soc_init: float = 0.5
    degradation_cost: float = 0.0  # money per kWh discharged

    @property
    def e_min(self):
        return self.soc_min * self.capacity_kwh

    @property
    def e_max(self):
        return self.soc_max * self.capacity_kwh

    @property
    def e_init(self):
        return min(max(self.soc_init * self.capacity_kwh, self.e_min), self.e_max)


@dataclass
class Site:
    name: str
    u: str
    v: str
    chargers: list
    solar: SolarProfile
    battery: Battery
    strategic: bool = True
    fixed_cost_per_day: float = 0.0
    maintenance_per_day: float = 0.0

    @property
    def edges(self):
        return [c.edge for c in self.chargers]

    @property
    def has_storage(self):
        return self.battery.capacity_kwh > 0

    @property
    def has_solar(self):
        return self.solar.base > 0


@dataclass
class EnergyScenario:
    net: ChargingNetwork
    sites: list
    tariff: DailyProfile
    day_length: float
    energy_per_vehicle: float
    grid_load_coefficient: float
    currency: str
    raw: dict = field(default_factory=dict)

    @property
    def charger_by_edge(self):
        return {c.edge: c for s in self.sites for c in s.chargers}


def _positive(value, label):
    value = float(value)
    if not value > 0:
        raise ValueError(f"{label} must be positive (got {value}).")
    return value


def _unit_interval(value, label):
    value = float(value)
    if not 0 <= value <= 1:
        raise ValueError(f"{label} must be between 0 and 1 (got {value}).")
    return value


def parse_scenario(data: dict) -> EnergyScenario:
    """Build the traffic network and the per-site energy systems from a scenario dict."""
    day = _positive(data.get("day_length", 24.0), "day_length")
    energy = _positive(data.get("energy_per_vehicle_kwh", 20.0), "energy_per_vehicle_kwh")
    profiles = data.get("profiles", {})
    solar_shape = profiles.get("solar", [0.0] * 24)
    tariff_values = profiles.get("tariff", FLAT)
    demand_shapes = profiles.get("demand", {})
    if any(v < 0 for v in tariff_values) or any(v < 0 for v in solar_shape):
        raise ValueError("Tariff and solar profiles must be non-negative.")

    defaults = dict(l0=0.25, L=40.0, a=6.0, alpha=1.0, gamma=1 / 150.0, eta=5.0)
    defaults.update(data.get("defaults", {}))
    # Station defaults are unused: every station edge sets its own parameters.
    net = ChargingNetwork(classes=["EV", "NEV"], defaults=dict(
        defaults, mu_s=1.0, a_s=1.0, c_s=0.0, phi0=0.0,
    ))

    for road in data.get("roads", []):
        net.add_road(road["u"], road["v"], classes=road.get("classes"),
                     l0=road.get("l0"), L=road.get("L"), a=road.get("a"))

    sites, service_cost, names = [], {}, set()
    for entry in data.get("sites", []):
        name = str(entry["name"])
        if name in names:
            raise ValueError(f"Duplicate site name '{name}'.")
        names.add(name)
        chargers = []
        for spec in entry.get("chargers", []):
            mode = str(spec["mode"])
            count = int(spec["count"])
            if count < 1:
                raise ValueError(f"Site '{name}' mode '{mode}': count must be at least 1.")
            power = _positive(spec["power_kw"], f"Site '{name}' mode '{mode}' power_kw")
            charger = Charger(
                mode=mode, count=count, power_kw=power,
                time_weight=float(spec.get("time_weight", 1.0)),
                initial_price=float(spec.get("initial_price", 0.0)),
                edge=f"{name}_{mode}",
            )
            if charger.initial_price < 0 or charger.time_weight < 0:
                raise ValueError(f"Site '{name}' mode '{mode}': price and time_weight must be non-negative.")
            if charger.edge in service_cost:
                raise ValueError(f"Site '{name}' lists mode '{mode}' twice.")
            rate = power / energy            # vehicles per hour finished by one charger
            # The engine's detour filter counts phi0, so charging time is applied after build().
            net.add_station(entry["u"], entry["v"], charger.edge, classes=["EV"],
                            mu_s=count * rate, a_s=rate, c_s=0.0, phi0=0.0,
                            psi=charger.initial_price)
            service_cost[charger.edge] = charger.time_weight / rate
            chargers.append(charger)
        if not chargers:
            raise ValueError(f"Site '{name}' has no chargers.")

        b = entry.get("battery") or {}
        battery = Battery(
            capacity_kwh=float(b.get("capacity_kwh", 0.0)),
            max_charge_kw=float(b.get("max_charge_kw", 0.0)),
            max_discharge_kw=float(b.get("max_discharge_kw", 0.0)),
            eta_c=float(b.get("eta_c", 0.95)), eta_d=float(b.get("eta_d", 0.95)),
            soc_min=_unit_interval(b.get("soc_min", 0.1), f"Site '{name}' soc_min"),
            soc_max=_unit_interval(b.get("soc_max", 0.9), f"Site '{name}' soc_max"),
            soc_init=_unit_interval(b.get("soc_init", 0.5), f"Site '{name}' soc_init"),
            degradation_cost=float(b.get("degradation_cost", 0.0)),
        )
        if battery.capacity_kwh < 0 or battery.max_charge_kw < 0 or battery.max_discharge_kw < 0:
            raise ValueError(f"Site '{name}': battery sizes must be non-negative.")
        if not (0 < battery.eta_c <= 1 and 0 < battery.eta_d <= 1):
            raise ValueError(f"Site '{name}': battery efficiencies must be in (0, 1].")
        if battery.soc_min > battery.soc_max:
            raise ValueError(f"Site '{name}': soc_min exceeds soc_max.")
        if battery.degradation_cost < 0:
            raise ValueError(f"Site '{name}': degradation_cost must be non-negative.")

        s = entry.get("solar") or {}
        peak = float(s.get("peak_kw", 0.0))
        if peak < 0:
            raise ValueError(f"Site '{name}': solar peak_kw must be non-negative.")
        weather = s.get("weather", data.get("weather"))
        if weather and any(not 0 <= w <= 1 for w in weather):
            raise ValueError("Weather factors must be between 0 and 1.")
        sites.append(Site(
            name=name, u=entry["u"], v=entry["v"], chargers=chargers,
            solar=SolarProfile(solar_shape, day, peak, weather), battery=battery,
            strategic=bool(entry.get("strategic", True)),
            fixed_cost_per_day=float(entry.get("fixed_cost_per_day", 0.0)),
            maintenance_per_day=float(entry.get("maintenance_per_day", 0.0)),
        ))
    if not sites:
        raise ValueError("The scenario has no charging sites.")

    for od in data.get("ods", []):
        shape = od.get("demand_profile")
        if shape is not None and shape not in demand_shapes:
            raise ValueError(f"OD '{od['name']}': unknown demand profile '{shape}'.")
        lam = float(od["lam"])
        if lam < 0:
            raise ValueError(f"OD '{od['name']}': lam must be non-negative.")
        net.add_od(od["name"], od["origin"], od["dest"],
                   DailyProfile(demand_shapes[shape] if shape else FLAT, day, base=lam),
                   od["shares"])
    if not net.ods:
        raise ValueError("The scenario has no OD pairs.")

    net.build(verbose=False)
    unused = [name for name, edge in net.stations.items() if edge not in net.station_edges]
    if unused:
        raise ValueError("No route uses these chargers: " + ", ".join(unused))
    for edge_name, cost in service_cost.items():
        net.G.edges[net.stations[edge_name]]["phi0"] = cost

    grid = data.get("grid", {})
    coefficient = float(grid.get("load_coefficient", 0.0))
    if coefficient < 0:
        raise ValueError("grid.load_coefficient must be non-negative.")
    return EnergyScenario(
        net=net, sites=sites, tariff=DailyProfile(tariff_values, day),
        day_length=day, energy_per_vehicle=energy, grid_load_coefficient=coefficient,
        currency=str(data.get("units", {}).get("currency", "INR")), raw=data,
    )
