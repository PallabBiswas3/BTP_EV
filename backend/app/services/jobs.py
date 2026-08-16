"""
Minimal in-memory background-job runner.

The gradient-flow outer loop is a chain of ODE solves and, even after the
performance work in `simulation/pricing/equilibrium.py`, a full run on a
several-station custom network can take 15-60+ seconds -- too long for a
plain synchronous POST (and past the hard request timeout most hosting
platforms, including the Heroku deployment target, enforce at ~30s). This
module runs each expensive request in a background thread and hands the
caller a job id to poll, with step-level progress -- exactly what the
"Performance" requirements ask for (a status like "Pricing iteration k/N"
instead of a frozen UI).

This is intentionally a simple in-process dict, not Celery/Redis/RQ: it's
enough for a single-process deployment (one uvicorn worker) and keeps the
deployment story to "one web dyno, no extra infra". If you scale to
multiple workers/dynos, swap this for a real job queue -- the interface
(`submit`, `get`) is small on purpose so that's a contained change.
"""
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

_LOCK = threading.Lock()
_JOBS: dict[str, "Job"] = {}
_MAX_JOBS = 200  # simple bound so a long-running server doesn't leak memory
_JOB_TTL_SECONDS = 3600


@dataclass
class Job:
    id: str
    status: str = "running"  # running | done | error
    phase: str = "Preparing network"
    step: int = 0
    n_steps: int = 0
    result: Optional[dict] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)


def _prune_locked():
    if len(_JOBS) <= _MAX_JOBS:
        return
    now = time.time()
    for jid in list(_JOBS):
        if now - _JOBS[jid].created_at > _JOB_TTL_SECONDS:
            del _JOBS[jid]


def submit(fn: Callable[[Callable[[str, int, int], None]], dict]) -> str:
    """Run `fn(report_progress)` in a background thread. `fn` must call
    `report_progress(phase, step, n_steps)` periodically and return the
    (JSON-serializable) result dict on success, or raise on failure."""
    job_id = uuid.uuid4().hex
    job = Job(id=job_id)
    with _LOCK:
        _prune_locked()
        _JOBS[job_id] = job

    def report_progress(phase: str, step: int, n_steps: int):
        with _LOCK:
            job.phase = phase
            job.step = step
            job.n_steps = n_steps

    def run():
        try:
            result = fn(report_progress)
            with _LOCK:
                job.result = result
                job.status = "done"
                job.phase = "Complete"
        except Exception as exc:  # noqa: BLE001
            with _LOCK:
                job.status = "error"
                job.error = f"{exc}"
                job.phase = "Failed"
            traceback.print_exc()

    threading.Thread(target=run, daemon=True).start()
    return job_id


def get(job_id: str) -> Optional[Job]:
    with _LOCK:
        return _JOBS.get(job_id)


def to_dict(job: Job) -> dict[str, Any]:
    return {
        "job_id": job.id,
        "status": job.status,
        "phase": job.phase,
        "step": job.step,
        "n_steps": job.n_steps,
        "result": job.result if job.status == "done" else None,
        "error": job.error,
    }
