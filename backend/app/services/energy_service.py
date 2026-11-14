"""API service for the solar + battery + fast/slow charger pricing model."""
import json
import re
from pathlib import Path

from simulation.energy.config import parse_scenario
from simulation.energy.loop import EnergyOptions, run_energy_pricing

SCENARIOS_DIR = Path(__file__).resolve().parents[2] / "energy_networks"


def list_scenarios() -> list[dict]:
    out = []
    for path in sorted(SCENARIOS_DIR.glob("*.json")):
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        out.append({"id": path.stem, "label": data.get("label", path.stem),
                    "description": data.get("description", "")})
    return out


def load_scenario(scenario_id: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", scenario_id):
        raise FileNotFoundError(f"Unknown energy scenario '{scenario_id}'")
    path = SCENARIOS_DIR / f"{scenario_id}.json"
    if not path.is_file():
        raise FileNotFoundError(f"Unknown energy scenario '{scenario_id}'")
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def check_scenario(scenario: dict, options: dict):
    """Raise ValueError for a scenario or options the model cannot run."""
    try:
        parsed = parse_scenario(scenario)
    except (KeyError, TypeError) as exc:
        raise ValueError(f"Malformed energy scenario: {exc!r}") from exc
    EnergyOptions(**options).validate(parsed.day_length)


def run_energy(scenario: dict, options: dict, report_progress=None) -> dict:
    parsed = parse_scenario(scenario)

    def progress(step, total):
        if report_progress:
            report_progress("Pricing step" if step else "Planning energy and prices", step, total)

    result = run_energy_pricing(parsed, EnergyOptions(**options), progress_cb=progress)
    return {"scenario": scenario, **result}
