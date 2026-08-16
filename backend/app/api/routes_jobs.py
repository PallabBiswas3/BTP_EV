from fastapi import APIRouter, HTTPException

from app.services import jobs

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("/{job_id}")
def job_status(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job id (it may have expired)")
    return jobs.to_dict(job)
