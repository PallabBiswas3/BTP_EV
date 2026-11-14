"""Predictive simulation endpoints with shared execution admission.

Each price update requires two traffic forecasts per station and one actual
physical-time advancement. Cloud mode streams progress and final output through
one active request; local/Render mode retains job submission and polling.
The historical /equilibrium URL returns the predictive endpoint summary.
"""
from fastapi import APIRouter, HTTPException, Request

from app.schemas.network import (
    BetaSweepRequest, ComparePricingRequest, EquilibriumRequest, SimulateRequest,
)
from app.services import simulation_service as svc
from app.services.streaming import dispatch
from simulation.scenarios.validation import validate_network_data

router = APIRouter(tags=["simulation"])


def _network_dict(network) -> dict:
    return network.model_dump(exclude_none=True)


def _check_buildable(network: dict, accuracy_mode: str, psi0=None):
    """Reject malformed inputs and source-unsupported states before queuing."""
    try:
        errors, _warnings = validate_network_data(network)
        if errors:
            raise ValueError("; ".join(errors))
        svc.build_network(network, accuracy_mode)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/simulate")
def simulate(req: SimulateRequest, request: Request):
    network = _network_dict(req.network)
    _check_buildable(network, req.simulation_options.accuracy_mode, req.simulation_options.psi0)
    options = req.simulation_options

    def work(report_progress):
        result = svc.run_simulate(network, options, report_progress=report_progress)
        return {"network": network, **result}

    return dispatch(request, "simulate", {"network": network, "simulation_options": options.model_dump()}, work)


@router.post("/equilibrium")
def equilibrium(req: EquilibriumRequest, request: Request):
    network = _network_dict(req.network)
    _check_buildable(network, req.simulation_options.accuracy_mode, req.simulation_options.psi0)
    options = req.simulation_options

    def work(report_progress):
        result = svc.run_equilibrium(network, options, report_progress=report_progress)
        return {"network": network, **result}

    return dispatch(request, "equilibrium", {"network": network, "simulation_options": options.model_dump()}, work)


@router.post("/beta-sweep")
def beta_sweep(req: BetaSweepRequest, request: Request):
    network = _network_dict(req.network)
    _check_buildable(network, req.simulation_options.accuracy_mode, req.simulation_options.psi0)
    options = req.simulation_options

    def work(report_progress):
        return svc.run_beta_sweep(
            network, options, req.beta_min, req.beta_max, req.beta_step,
            report_progress=report_progress,
        )

    return dispatch(request, "beta-sweep", {
        "network": network, "simulation_options": options.model_dump(),
        "beta_min": req.beta_min, "beta_max": req.beta_max, "beta_step": req.beta_step,
    }, work)


@router.post("/compare-pricing")
def compare_pricing(req: ComparePricingRequest, request: Request):
    network = _network_dict(req.network)
    _check_buildable(network, req.simulation_options.accuracy_mode, req.simulation_options.psi0)
    options = req.simulation_options

    def work(report_progress):
        report_progress("Simulating strategic and fixed-price policies", 0, 2)
        return svc.run_compare_pricing(network, options, report_progress=report_progress)

    return dispatch(request, "compare-pricing", {"network": network, "simulation_options": options.model_dump()}, work)
