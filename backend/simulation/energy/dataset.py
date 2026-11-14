"""Turn a run into a station-history table.

One row per (pricing step, site): what the site could observe and what
happened. This is the training-table format for the learned forecasters
described in docs/ml_forecaster_plan.md; real station logs would be put in
the same columns.
"""
import csv
import math


def history_rows(result: dict) -> list[dict]:
    chargers, sites = result["chargers"], result["sites"]
    day = result["settings"]["day_length"]
    h = result["settings"]["h"]
    modes = sorted({c["mode"] for c in chargers.values()})
    rows = []
    for k, t in enumerate(result["time"]):
        start = t - h
        hour = math.fmod(start, day)
        for name, site in sites.items():
            row = {
                "time": start, "day": int(start // day), "hour_of_day": hour,
                "hour_sin": math.sin(2 * math.pi * hour / day),
                "hour_cos": math.cos(2 * math.pi * hour / day),
                "site": name, "tariff": result["tariff"][k],
                "solar_available_kw": site["solar_available_kw"][k],
                "stored_kwh": site["stored_kwh"][k], "load_kw": site["load_kw"][k],
            }
            for mode in modes:
                own = next((e for e in site["chargers"] if chargers[e]["mode"] == mode), None)
                rivals = [c["price"][k] for e, c in chargers.items()
                          if c["mode"] == mode and c["site"] != name]
                row[f"price_{mode}"] = chargers[own]["price"][k] if own else ""
                row[f"rival_min_price_{mode}"] = min(rivals) if rivals else ""
                row[f"rival_mean_price_{mode}"] = sum(rivals) / len(rivals) if rivals else ""
                # Queue at the start of the step is what the site can see when it sets the price.
                row[f"queue_start_{mode}"] = (chargers[own]["queue"][k - 1] if k else 0.0) if own else ""
                row[f"arrivals_{mode}"] = chargers[own]["arrivals"][k] if own else ""
                row[f"throughput_{mode}"] = chargers[own]["throughput"][k] if own else ""
            rows.append(row)
    return rows


def write_history_csv(result: dict, path) -> int:
    rows = history_rows(result)
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)
