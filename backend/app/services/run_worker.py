"""A supervised process running the existing service functions unchanged.

An append-only journal carries progress; atomic files carry completion.
Solver stdout remains logs.
This also prevents process-pool diagnostic prints corrupting the HTTP stream.
"""
import json
import os
from pathlib import Path
import sys
import traceback

from app.services.execution_config import result_limit


def write_json(path: Path, value, limit=None):
    data = json.dumps(value, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if limit is not None and len(data) > limit:
        raise ValueError("Result exceeds the configured response-size limit.")
    temporary = path.with_suffix(".tmp")
    temporary.write_bytes(data)
    temporary.replace(path)


def execute(spec: dict, report):
    from app.schemas.network import SimulationOptions
    from app.services import paper_service, simulation_service

    operation = spec["operation"]
    args = spec["arguments"]
    if operation.startswith("experiment"):
        functions = {
            "experiment1": paper_service.run_experiment1,
            "experiment2": paper_service.run_experiment2,
            "experiment3": paper_service.run_experiment3,
        }
        return functions[operation](n_steps=args["n_steps"], report_progress=report)
    if operation == "energy-simulate":
        from app.services import energy_service
        return energy_service.run_energy(args["scenario"], args["simulation_options"],
                                         report_progress=report)
    options = SimulationOptions(**args["simulation_options"])
    network = args["network"]
    functions = {
        "simulate": simulation_service.run_simulate,
        "equilibrium": simulation_service.run_equilibrium,
        "compare-pricing": simulation_service.run_compare_pricing,
    }
    if operation == "beta-sweep":
        return simulation_service.run_beta_sweep(
            network, options, args["beta_min"], args["beta_max"], args["beta_step"],
            report_progress=report,
        )
    result = functions[operation](network, options, report_progress=report)
    return {"network": network, **result} if operation in {"simulate", "equilibrium"} else result


def main():
    folder = Path(sys.argv[1]).resolve()
    os.environ["EVCS_CACHE_PATH"] = str(folder / "cache" / "equilibria.sqlite3")
    os.environ.setdefault("MPLCONFIGDIR", str(folder / "matplotlib"))
    try:
        # Imports and all expensive numerical work happen in this child process.
        from app.services import reference_outputs
        reference_outputs.OUTPUTS_DIR = folder / "plots"
        spec = json.loads((folder / "request.json").read_text(encoding="utf-8"))

        def report(phase, step, n_steps):
            event = {
                "type": "progress", "phase": phase, "step": step, "n_steps": n_steps,
            }
            # Keep each iteration even if several finish between stream checks.
            # Closing after each append flushes it for the supervising process.
            with (folder / "progress.ndjson").open("ab") as journal:
                journal.write(json.dumps(event, allow_nan=False, separators=(",", ":")).encode("utf-8") + b"\n")

        result = execute(spec, report)
        write_json(folder / "result.json", result, result_limit())
        write_json(folder / "status.json", {"status": "done"})
    except Exception as exc:
        traceback.print_exc()
        write_json(folder / "status.json", {
            "status": "error", "code": "simulation_error", "message": str(exc),
        })
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
