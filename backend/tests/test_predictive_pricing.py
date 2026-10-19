"""Numerical and API regression tests for predictive pricing.

Optional reference parity tests load the user's unchanged source files from
EVCS_REFERENCE_DIR. The normal suite has no dependency on those external files.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import time
import unittest

import numpy as np
from fastapi.testclient import TestClient

from app.main import app
from app.schemas.network import SimulationOptions
from app.services.simulation_service import (
    run_beta_sweep, run_compare_pricing, run_equilibrium, run_simulate,
)
from simulation.core.legacy_network_engine import ChargingNetwork as LegacyNetwork
from simulation.core.network_engine import ChargingNetwork, latency
from simulation.experiments.paper_experiments import build_paper_network
from simulation.pricing.strategic_pricing import outer_loop
from simulation.scenarios.demand import StepDemand
from simulation.scenarios.loader import build_network_from_data, load_scenario_data


def config(schedule=""):
    return {
        "classes": ["EV", "NEV"],
        "defaults": {"eta": 0.05},
        "roads": [
            {"u": "O", "v": "A", "l0": 0.25, "L": 4.0, "a": 0.7},
            {"u": "A", "v": "D", "l0": 0.25, "L": 4.0},
            {"u": "O", "v": "B", "l0": 0.3, "L": 4.0},
            {"u": "B", "v": "D", "l0": 0.3, "L": 4.0},
        ],
        "stations": [
            {"u": "A", "v": "D", "name": "S1", "mu_s": 0.5},
            {"u": "B", "v": "D", "name": "S2", "mu_s": 0.8},
        ],
        "ods": [{
            "name": "OD", "origin": "O", "dest": "D", "lam": 1.0,
            "shares": {"EV": 0.6, "NEV": 0.4}, "demand_schedule": schedule,
        }],
    }


def options(**overrides):
    return SimulationOptions(t_end=4.0, h=2.0, ctrl_horizon=2, parallel=False, **overrides)


class PredictiveTests(unittest.TestCase):
    def test_defaults_match_reference_cli(self):
        opts = SimulationOptions()
        self.assertEqual((opts.t_end, opts.h, opts.ctrl_horizon, opts.profit_mode),
                         (75000.0, 1500.0, 10, "end"))
        self.assertIsNone(opts.psi_max)
        self.assertIsNone(opts.grad_clip)
        self.assertIsNone(opts.parallel)

    def test_physical_time_and_summary_alignment(self):
        result = run_simulate(config(), options())
        self.assertEqual(result["trajectory"]["time"], [0.0, 2.0, 4.0])
        self.assertEqual(result["outer_history"]["time"], [2.0, 4.0])
        self.assertEqual(result["equilibrium"]["result_kind"], "dynamic_endpoint")
        self.assertFalse(result["equilibrium"]["quality"]["certified"])
        self.assertEqual(result["equilibrium"]["quality"]["forecast_solve_count"], 8)
        for name, station in result["trajectory"]["stations"].items():
            self.assertEqual(len(station["price"]), 3)
            self.assertAlmostEqual(station["price"][-1], result["equilibrium"]["prices"][name])
            self.assertAlmostEqual(station["occupancy"][-1], result["equilibrium"]["occupancies"][name])
            self.assertAlmostEqual(station["profit"][-1], result["equilibrium"]["profits"][name])
        json.dumps(result, allow_nan=False)

    def test_step_demand_uses_physical_time_in_routes_and_user_cost(self):
        result = run_simulate(config("2:2"), options())
        paths = result["trajectory"]["paths"].values()
        for index, demand in enumerate((1.0, 2.0, 2.0)):
            self.assertAlmostEqual(sum(path["flow"][index] for path in paths), demand)
        self.assertAlmostEqual(result["equilibrium"]["total_user_cost"],
                               result["trajectory"]["total_user_cost"][-1])

    def test_step_demand_validation(self):
        demand = StepDemand.from_spec(1.0, "4:3;2:2")
        self.assertEqual([demand(t) for t in (0, 2, 3, 4)], [1, 2, 2, 3])
        for value in ("broken", "1:-2", "-1:2", "nan:2", "1:2;1:3"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                StepDemand.from_spec(1.0, value)

    def test_mean_and_endpoint_are_distinct_objectives(self):
        net = build_network_from_data(config())
        end = outer_loop(net, t_end=2, h=2, ctrl_horizon=2, profit_mode="end", parallel=False)
        mean = outer_loop(net, t_end=2, h=2, ctrl_horizon=2, profit_mode="mean", parallel=False)
        self.assertGreater(abs(end.psi["S1"] - mean.psi["S1"]), 1e-5)

    def test_price_caps_zero_boundary_and_clipping(self):
        net = build_network_from_data(config())
        result = outer_loop(net, psi0=0.0, t_end=4, h=2, ctrl_horizon=1,
                            psi_max=0.01, grad_clip=0.001, parallel=False)
        for prices in result.price_history:
            for value in prices.values():
                self.assertGreaterEqual(value, 0)
                self.assertLessEqual(value, 0.01)
        self.assertLessEqual(result.psi["S1"], 0.0002 + 1e-12)

    def test_unused_station_is_reported(self):
        data = config()
        data["stations"].append({"u": "X", "v": "Y", "name": "Unused"})
        result = run_simulate(data, options())
        self.assertEqual(result["equilibrium"]["occupancies"]["Unused"], 0)
        self.assertEqual(result["equilibrium"]["throughputs"]["Unused"], 0)

    def test_ev_demand_requires_a_charging_route(self):
        data = config()
        data["stations"] = []
        with self.assertRaises(ValueError):
            build_network_from_data(data)

    def test_road_only_network_has_pricing_time_history(self):
        data = config()
        data["stations"] = []
        data["ods"][0]["shares"] = {"NEV": 1.0}
        result = run_simulate(data, options())
        self.assertEqual(result["outer_history"]["step"], [0, 1])
        self.assertEqual(result["trajectory"]["time"], [0, 2, 4])
        self.assertEqual(result["equilibrium"]["quality"]["forecast_solve_count"], 0)

    def test_explicit_class_permissions_are_honored(self):
        data = config()
        data["roads"][0]["classes"] = ["NEV"]
        net = build_network_from_data(data)
        ev_stations = [net.G.edges[e]["name"] for pid in net.groups[("OD", "EV")]
                       for e in net.path_edges[pid] if net.G.edges[e]["kind"] == "station"]
        self.assertEqual(ev_stations, ["S2"])

    def test_bundled_networks_retain_all_demand_groups(self):
        for scenario in ("i", "i2", "i3"):
            data = load_scenario_data(scenario)
            net = build_network_from_data(data)
            for od in data["ods"]:
                for cls, share in od["shares"].items():
                    if share > 0:
                        self.assertIn((od["name"], cls), net.groups)
            self.assertTrue(net.N_STATES > 0)

    def test_latency_is_reference_occupancy_formula(self):
        self.assertAlmostEqual(latency(1.0, 0.25, 4.0, a=3.0), 0.25 / 3.0)

    def test_comparison_sweep_and_summary_endpoints(self):
        for result in (
            run_compare_pricing(config(), options()),
            run_beta_sweep(config(), options(), 0.4, 0.6, 0.2),
            run_equilibrium(config(), options()),
        ):
            json.dumps(result, allow_nan=False)
        summary = run_equilibrium(config(), options())
        self.assertEqual(summary["equilibrium"]["quality"]["actual_t_end"], 4.0)

    def test_legacy_paper_model_preserved(self):
        self.assertIsInstance(build_paper_network(), LegacyNetwork)
        self.assertNotIsInstance(build_paper_network(), ChargingNetwork)

    def test_async_api_and_invalid_options(self):
        with TestClient(app) as client:
            response = client.post("/api/simulate", json={
                "network": config(), "simulation_options": options().model_dump(),
            })
            self.assertEqual(response.status_code, 200, response.text)
            job_id = response.json()["job_id"]
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                job = client.get(f"/api/jobs/{job_id}").json()
                if job["status"] != "running":
                    break
                time.sleep(0.02)
            self.assertEqual(job["status"], "done", job.get("error"))
            self.assertEqual(job["result"]["trajectory"]["time"], [0, 2, 4])
            for overrides in (
                {"ctrl_horizon": 0}, {"ctrl_horizon": 1.5}, {"h": 0},
                {"h": 20, "t_end": 1}, {"psi0": {"Unknown": 0.5}},
            ):
                response = client.post("/api/simulate", json={
                    "network": config(), "simulation_options": {**options().model_dump(), **overrides},
                })
                self.assertEqual(response.status_code, 422, response.text)

    def test_process_parallel_forecasts_match_serial(self):
        net = build_network_from_data(config())
        serial = outer_loop(net, t_end=2, h=2, ctrl_horizon=2, parallel=False)
        parallel = outer_loop(net, t_end=2, h=2, ctrl_horizon=2, parallel=True, n_workers=2)
        self.assertEqual(parallel.quality["gradient_execution"], "process-parallel",
                         parallel.quality["gradient_fallback_reason"])
        np.testing.assert_allclose(list(serial.psi.values()), list(parallel.psi.values()), atol=1e-10)
        np.testing.assert_allclose(serial.state, parallel.state, atol=1e-10)


REFERENCE_DIR = os.environ.get("EVCS_REFERENCE_DIR")


@unittest.skipUnless(REFERENCE_DIR, "Set EVCS_REFERENCE_DIR for supplied-script parity tests")
class ReferenceParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        def load(name, filename):
            spec = importlib.util.spec_from_file_location(name, Path(REFERENCE_DIR) / filename)
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            spec.loader.exec_module(module)
            return module
        cls.engine = load("reference_network_engine", "network_engine.py")
        previous = sys.modules.get("network_engine")
        sys.modules["network_engine"] = cls.engine
        try:
            cls.sim = load("reference_sim", "sim.py")
        finally:
            if previous is None:
                sys.modules.pop("network_engine", None)
            else:
                sys.modules["network_engine"] = previous

    def reference_net(self, data):
        net = self.engine.ChargingNetwork(classes=data["classes"], defaults=data["defaults"])
        for road in data["roads"]:
            net.add_road(**road)
        for station in data["stations"]:
            net.add_station(**station)
        for od in data["ods"]:
            schedule = od.get("demand_schedule")
            demand = (self.sim.StepDemand.from_spec(od["lam"], schedule)
                      if schedule else self.sim.ConstantDemand(od["lam"]))
            net.add_od(od["name"], od["origin"], od["dest"], demand, od["shares"])
        net.build(verbose=False)
        return net

    @staticmethod
    def state_map(net):
        mapping = {("xr", edge, cls): net.IDX[("xr", edge, cls)] for edge, cls in net.road_state_keys}
        mapping.update({("xs", edge): net.IDX[("xs", edge)] for edge in net.station_edges})
        mapping.update({
            ("y", net.path_od[pid], net.path_class[pid], tuple(net.path_edges[pid])): net.IDX[("y", pid)]
            for pid in net.path_state_keys
        })
        return mapping

    def compare(self, horizon, mode, schedule=""):
        data = config(schedule)
        net = build_network_from_data(data)
        reference = self.reference_net(data)
        kwargs = dict(t_end=4, h=2, ctrl_horizon=horizon, profit_mode=mode,
                      parallel=False, eq_t_max=20)
        actual = outer_loop(net, **kwargs)
        with contextlib.redirect_stdout(io.StringIO()):
            expected = self.sim.outer_loop(reference, **kwargs)
        for station in net.stations:
            self.assertAlmostEqual(actual.psi[station], expected["psi"][station], places=7)
            for metric in ("psi", "rho", "occ", "profit", "queue", "revenue"):
                np.testing.assert_allclose(actual.hist[station][metric],
                                           expected["hist"][station][metric], rtol=1e-6, atol=1e-8)
        ours, theirs = self.state_map(net), self.state_map(reference)
        self.assertEqual(set(ours), set(theirs))
        for key in ours:
            np.testing.assert_allclose(
                np.column_stack(actual.state_history)[ours[key]],
                expected["final_sol"].y[theirs[key]], rtol=1e-6, atol=1e-8,
            )
        np.testing.assert_array_equal(actual.time_history, expected["final_sol"].t)

    def test_reference_endpoint_profit(self):
        self.compare(2, "end")

    def test_reference_mean_profit(self):
        self.compare(2, "mean")

    def test_reference_step_demand(self):
        self.compare(2, "end", "2:1.5")

    def test_reference_equilibrium_forecasts(self):
        self.compare("eq", "end")


if __name__ == "__main__":
    unittest.main()

