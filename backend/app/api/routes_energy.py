"""Endpoints for the solar + battery + fast/slow charger pricing model."""
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app.services import energy_service
from app.services.streaming import dispatch

router = APIRouter(prefix="/energy", tags=["energy-pricing"])


class EnergyOptionsModel(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")
    t_end: float = Field(72.0, gt=0, le=24 * 14)
    h: float = Field(0.5, gt=0)
    horizon: int = Field(2, ge=1, le=48)
    kappa: float = Field(4.0, gt=0)
    delta: float = Field(5.0, gt=0)
    profit_mode: Literal["mean", "end"] = "mean"
    revenue_on: Literal["arrival", "departure"] = "arrival"
    substeps: int = Field(2, ge=1, le=12)
    price_cap: Optional[float] = Field(None, gt=0)
    max_price_change: Optional[float] = Field(15.0, gt=0)
    load_memory: float = Field(0.5, ge=0, lt=1)
    min_route_share: float = Field(0.02, ge=0, lt=0.5)
    parallel: bool = False
    n_workers: Optional[int] = Field(None, ge=1)


class EnergySimulateRequest(BaseModel):
    scenario: dict
    simulation_options: EnergyOptionsModel = Field(default_factory=EnergyOptionsModel)


@router.get("/scenarios")
def scenarios():
    return energy_service.list_scenarios()


@router.get("/scenarios/{scenario_id}")
def scenario(scenario_id: str):
    try:
        return energy_service.load_scenario(scenario_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/simulate")
def simulate(req: EnergySimulateRequest, request: Request):
    options = req.simulation_options.model_dump()
    try:
        energy_service.check_scenario(req.scenario, options)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    def work(report_progress):
        return energy_service.run_energy(req.scenario, options, report_progress=report_progress)

    return dispatch(request, "energy-simulate",
                    {"scenario": req.scenario, "simulation_options": options}, work)
