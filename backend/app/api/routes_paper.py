from fastapi import APIRouter

from app.services import jobs, paper_service

router = APIRouter(prefix="/paper", tags=["paper-reproduction"])


@router.post("/experiment1")
def experiment1(n_steps: int = 40):
    def work(report_progress):
        return paper_service.run_experiment1(n_steps=n_steps, report_progress=report_progress)
    return {"job_id": jobs.submit(work)}


@router.post("/experiment2")
def experiment2(n_steps: int = 25):
    def work(report_progress):
        return paper_service.run_experiment2(n_steps=n_steps, report_progress=report_progress)
    return {"job_id": jobs.submit(work)}


@router.post("/experiment3")
def experiment3(n_steps: int = 25):
    def work(report_progress):
        return paper_service.run_experiment3(n_steps=n_steps, report_progress=report_progress)
    return {"job_id": jobs.submit(work)}
