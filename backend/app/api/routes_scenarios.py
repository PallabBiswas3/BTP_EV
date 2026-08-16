from fastapi import APIRouter, HTTPException

from app.schemas.network import ValidateRequest
from simulation.scenarios.loader import list_scenarios, load_scenario_data
from simulation.scenarios.validation import validate_network_data

router = APIRouter(tags=["scenarios"])


@router.get("/health")
def health():
    return {"status": "ok"}


@router.get("/scenarios")
def get_scenarios():
    return list_scenarios()


@router.get("/scenarios/{scenario_id}")
def get_scenario(scenario_id: str):
    try:
        return load_scenario_data(scenario_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/custom-network/validate")
def validate_network(req: ValidateRequest):
    errors, warnings = validate_network_data(req.network)
    return {"valid": len(errors) == 0, "errors": errors, "warnings": warnings}
