"""Download plots produced by the supplied simulation functions."""
import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.services.reference_outputs import OUTPUTS_DIR

router = APIRouter(tags=["simulation"])


@router.get("/artifacts/{run_id}/{filename}")
def download_artifact(run_id: str, filename: str):
    if not re.fullmatch(r"[0-9a-f]{32}", run_id) or not re.fullmatch(r"simulation_[a-z_]+\.png", filename):
        raise HTTPException(status_code=404, detail="Unknown simulation artifact")
    path = OUTPUTS_DIR / run_id / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Unknown simulation artifact")
    return FileResponse(path, media_type="image/png", filename=filename)
