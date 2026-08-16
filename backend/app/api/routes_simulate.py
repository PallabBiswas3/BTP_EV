"""
Simulation endpoints.

NOTE on the async pattern: each of these solves a coupled ODE system
repeatedly (an outer gradient-flow pricing loop, each step of which needs
several inner equilibrium solves -- see simulation/pricing/equilibrium.py's
module docstring for the performance work that went into making this as
fast as it is). Even so, a full run on a multi-station custom network can
take 15-60+ seconds, well past what a synchronous POST should block on and
past the hard timeout most hosts (including the Heroku deployment target)
enforce. So instead of returning the result directly, these endpoints start
a background job and return `{job_id}` immediately; poll
`GET /api/jobs/{job_id}` for progress and the final result. This directly
implements the spec's performance requirement ("Preparing network / Solving
inner equilibrium / Pricing iteration k/N ... proper loading state").
"""
from fastapi import APIRouter, HTTPException

from app.schemas.network import (
    BetaSweepRequest, ComparePricingRequest, EquilibriumRequest, SimulateRequest,
)
from app.services import jobs
from app.services import simulation_service as svc
from simulation.scenarios.loader import build_network_from_data

router = APIRouter(tags=["simulation"])


def _network_dict(network) -> dict:
    return network.model_dump(exclude_none=True)


def _check_buildable(network: dict):
    """Fail fast with a 422 (not a 500 from inside a background thread) if
    the network can't even be built -- e.g. an OD pair with no feasible
    path for its class."""
    try:
        build_network_from_data(network)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/simulate")
def simulate(req: SimulateRequest):
    network = _network_dict(req.network)
    _check_buildable(network)
    options = req.simulation_options

    def work(report_progress):
        result = svc.run_simulate(network, options, report_progress=report_progress)
        return {"network": network, **result}

    return {"job_id": jobs.submit(work)}


@router.post("/equilibrium")
def equilibrium(req: EquilibriumRequest):
    network = _network_dict(req.network)
    _check_buildable(network)
    options = req.simulation_options

    def work(report_progress):
        result = svc.run_equilibrium(network, options, report_progress=report_progress)
        return {"network": network, **result}

    return {"job_id": jobs.submit(work)}


@router.post("/beta-sweep")
def beta_sweep(req: BetaSweepRequest):
    network = _network_dict(req.network)
    _check_buildable(network)
    options = req.simulation_options

    def work(report_progress):
        return svc.run_beta_sweep(
            network, options, req.beta_min, req.beta_max, req.beta_step,
            report_progress=report_progress,
        )

    return {"job_id": jobs.submit(work)}


@router.post("/compare-pricing")
def compare_pricing(req: ComparePricingRequest):
    network = _network_dict(req.network)
    _check_buildable(network)
    options = req.simulation_options

    def work(report_progress):
        report_progress("Solving strategic and fixed-price equilibria", 0, 2)
        return svc.run_compare_pricing(network, options)

    return {"job_id": jobs.submit(work)}
