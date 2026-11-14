from fastapi import APIRouter, Query, Request

from app.services import paper_service
from app.services.streaming import dispatch

router = APIRouter(prefix="/paper", tags=["paper-reproduction"])


@router.post("/experiment1")
def experiment1(request: Request, n_steps: int = Query(40, ge=1, le=200)):
    def work(report_progress):
        return paper_service.run_experiment1(n_steps=n_steps, report_progress=report_progress)
    return dispatch(request, "experiment1", {"n_steps": n_steps}, work)


@router.post("/experiment2")
def experiment2(request: Request, n_steps: int = Query(25, ge=1, le=200)):
    def work(report_progress):
        return paper_service.run_experiment2(n_steps=n_steps, report_progress=report_progress)
    return dispatch(request, "experiment2", {"n_steps": n_steps}, work)


@router.post("/experiment3")
def experiment3(request: Request, n_steps: int = Query(25, ge=1, le=200)):
    def work(report_progress):
        return paper_service.run_experiment3(n_steps=n_steps, report_progress=report_progress)
    return dispatch(request, "experiment3", {"n_steps": n_steps}, work)
