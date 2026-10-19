"""Predictive simulation endpoints using asynchronous background jobs.

Each price update requires two traffic forecasts per station and one actual
physical-time advancement. Return a job ID immediately; clients poll
GET /api/jobs/{job_id} for phase, update progress, and the final JSON result.
The historical /equilibrium URL returns the predictive endpoint summary.
"""
from fastapi import APIRouter, HTTPException

from app.schemas.network import (
    BetaSweepRequest, ComparePricingRequest, EquilibriumRequest, SimulateRequest,
)
from app.services import jobs
from app.services import simulation_service as svc

router = APIRouter(tags=["simulation"])


def _network_dict(network) -> dict:
    return network.model_dump(exclude_none=True)


def _check_buildable(network: dict, accuracy_mode: str, psi0=None):
    """Fail fast with a 422 (not a 500 from inside a background thread) if
    the network can't even be built -- e.g. an OD pair with no feasible
    path for its class."""
    try:
        # Use the same cached builder and route profile as the background job.
        # Besides keeping validation consistent, the job receives an immediate
        # cache hit instead of constructing a large route set twice.
        net = svc.build_network(network, accuracy_mode)
        if psi0 and set(psi0) - set(net.stations):
            raise ValueError(f"Unknown initial-price stations: {sorted(set(psi0) - set(net.stations))}")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/simulate")
def simulate(req: SimulateRequest):
    network = _network_dict(req.network)
    _check_buildable(network, req.simulation_options.accuracy_mode, req.simulation_options.psi0)
    options = req.simulation_options

    def work(report_progress):
        result = svc.run_simulate(network, options, report_progress=report_progress)
        return {"network": network, **result}

    return {"job_id": jobs.submit(work)}


@router.post("/equilibrium")
def equilibrium(req: EquilibriumRequest):
    network = _network_dict(req.network)
    _check_buildable(network, req.simulation_options.accuracy_mode, req.simulation_options.psi0)
    options = req.simulation_options

    def work(report_progress):
        result = svc.run_equilibrium(network, options, report_progress=report_progress)
        return {"network": network, **result}

    return {"job_id": jobs.submit(work)}


@router.post("/beta-sweep")
def beta_sweep(req: BetaSweepRequest):
    network = _network_dict(req.network)
    _check_buildable(network, req.simulation_options.accuracy_mode, req.simulation_options.psi0)
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
    _check_buildable(network, req.simulation_options.accuracy_mode, req.simulation_options.psi0)
    options = req.simulation_options

    def work(report_progress):
        report_progress("Simulating strategic and fixed-price policies", 0, 2)
        return svc.run_compare_pricing(network, options, report_progress=report_progress)

    return {"job_id": jobs.submit(work)}
