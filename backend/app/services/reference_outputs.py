"""The supplied CLI's plots and final fixed-price continuation for API runs."""
import uuid
from pathlib import Path

from simulation.pricing.strategic_pricing import SOURCE_LOCK, source

OUTPUTS_DIR = Path(__file__).resolve().parents[2] / ".outputs"


def finish_reference_run(net, outer, options, report_progress=None):
    from app.services.simulation_service import _f, serialize_trajectory

    def report(phase):
        if report_progress:
            report_progress(phase, outer.quality["completed_steps"], outer.quality["maximum_steps"])

    artifacts = []
    if options.save_plots:
        report("Saving original simulation plots")
        run_id = uuid.uuid4().hex
        folder = OUTPUTS_DIR / run_id
        folder.mkdir(parents=True)
        prefix = str(folder / "simulation")
        stations = list(net.stations)
        with SOURCE_LOCK:
            x_idx, y_idx = source._state_index_groups(net)
            source.plot_state_trajectory(net, outer.raw["final_sol"], x_idx, y_idx,
                                         save_prefix=f"{prefix}_final")
            source.plot_convergence_trajectory(
                net, outer.raw["final_sol"], x_idx, y_idx,
                outer.raw["final_sol"].psi_hist, save_prefix=f"{prefix}_final",
            )
            source.plot_convergence(outer.raw, stations, net=net, save_prefix=prefix,
                                    demand_t_end=outer.raw["t_end"])
            source.plot_convergence_summary(outer.raw, stations, net=net, save_prefix=prefix,
                                            demand_t_end=outer.raw["t_end"])
            source.plot_wardrop_grid(outer.raw, save_prefix=prefix)
            source.plot_path_flow_grid(outer.raw, net, save_prefix=prefix)
            source.plot_final_revenue(outer.raw, stations, save_prefix=prefix)
        artifacts = [
            {"name": path.name, "url": f"/api/artifacts/{run_id}/{path.name}"}
            for path in sorted(folder.glob("*.png"))
        ]

    report("Running original final fixed-price traffic summary")
    res = net.simulate_discrete(
        t_end=options.final_t, h=options.h, psi_override=outer.psi,
        y0=outer.state, t0=outer.quality["actual_t_end"],
    )
    post = net.post_process(res, psi_override=outer.psi)
    net.print_final_summary(post)
    final = {
        "requested_duration": options.final_t,
        "actual_duration": _f(res["t"][-1] - res["t"][0]),
        "success": bool(res["success"]),
        "trajectory": serialize_trajectory(net, post),
        "total_user_cost": _f(post["total_user_cost"][-1]),
        "total_profit": _f(post["total_profit"][-1]),
        "total_revenue": _f(sum(post[f"revenue_{s}"][-1] for s in net.stations)),
        "occupancies": {s: _f(post[f"occ_{s}"][-1]) for s in net.stations},
        "throughputs": {s: _f(post[f"rho_{s}"][-1]) for s in net.stations},
        "profits": {s: _f(post[f"profit_{s}"][-1]) for s in net.stations},
    }
    return final, artifacts
