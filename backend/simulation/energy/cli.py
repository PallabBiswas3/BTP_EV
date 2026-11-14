"""Run the energy pricing model from the command line.

    cd backend
    python -m simulation.energy.cli energy_networks/two_od_solar_battery.json --t-end 72
"""
import argparse
import json

from simulation.energy.config import parse_scenario
from simulation.energy.dataset import write_history_csv
from simulation.energy.loop import EnergyOptions, run_energy_pricing


def main():
    parser = argparse.ArgumentParser(description="Solar + battery + fast/slow charger pricing")
    parser.add_argument("scenario")
    parser.add_argument("--t-end", type=float, default=72.0, help="simulated hours")
    parser.add_argument("--h", type=float, default=0.5, help="pricing step in hours")
    parser.add_argument("--horizon", type=int, default=2, help="price look-ahead in steps")
    parser.add_argument("--kappa", type=float, default=4.0)
    parser.add_argument("--delta", type=float, default=5.0)
    parser.add_argument("--profit-mode", choices=["mean", "end"], default="mean")
    parser.add_argument("--price-cap", type=float, default=None)
    parser.add_argument("--parallel", action="store_true")
    parser.add_argument("--workers", type=int, default=None)
    parser.add_argument("--out", help="write the full result as JSON")
    parser.add_argument("--history", help="write the station-history table as CSV")
    args = parser.parse_args()

    with open(args.scenario, "r", encoding="utf-8") as handle:
        scenario = parse_scenario(json.load(handle))
    options = EnergyOptions(
        t_end=args.t_end, h=args.h, horizon=args.horizon, kappa=args.kappa, delta=args.delta,
        profit_mode=args.profit_mode, price_cap=args.price_cap, parallel=args.parallel,
        n_workers=args.workers,
    )

    def progress(step, total):
        if step and (step % max(total // 10, 1) == 0 or step == total):
            print(f"  step {step}/{total}")

    result = run_energy_pricing(scenario, options, progress_cb=progress)
    money = result["units"]["currency"]
    print(f"\nWall time {result['settings']['wall_time_seconds']:.1f} s, "
          f"{result['settings']['forecasts_per_step']} forecasts per step")
    for name, site in result["sites"].items():
        day = site["last_day"]
        prices = ", ".join(f"{m} {p:.0f}" for m, p in day["average_price"].items())
        print(f"{name}: last-day profit {day['profit']:.0f} {money} "
              f"(revenue {day['revenue']:.0f}, energy {day['energy_cost']:.0f}, fixed {day['fixed_cost']:.0f}) | "
              f"vehicles {day['vehicles_served']:.1f} | mean price {prices} | "
              f"solar {100 * day['share_solar_direct']:.0f}% battery {100 * day['share_battery']:.0f}% "
              f"grid {100 * day['share_grid_direct']:.0f}%")
    for warning in result["warnings"]:
        print("Warning:", warning)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(result, handle)
    if args.history:
        print(f"Wrote {write_history_csv(result, args.history)} history rows to {args.history}")


if __name__ == "__main__":
    main()
