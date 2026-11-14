"""Request-scoped simulation supervision and NDJSON delivery."""
import asyncio
import base64
import ctypes
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

import anyio
from fastapi import HTTPException, Request
from starlette.responses import StreamingResponse

from app.services import admission, jobs
from app.services.execution_config import (
    artifact_limit, cloud_mode, positive_int, result_limit, streaming_enabled, timeout_seconds,
)

BACKEND = Path(__file__).resolve().parents[2]
_ARTIFACT = re.compile(r"^/api/artifacts/([0-9a-f]{32})/(simulation_[a-z_]+\.png)$")


def record(value) -> bytes:
    return (json.dumps(value, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")


def flush_frame(data: bytes) -> bytes:
    # Legal JSON whitespace helps small updates pass size-buffering proxies.
    # Keep the padding on the same NDJSON line for existing clients.
    return data.rstrip(b"\r\n").ljust(4095, b" ") + b"\n"


def dispatch(request: Request, operation: str, arguments: dict, work):
    wants_stream = "application/x-ndjson" in request.headers.get("accept", "")
    if cloud_mode() and not wants_stream:
        raise HTTPException(406, "This deployment requires the updated streaming client. Reload the dashboard.")
    try:
        if wants_stream and streaming_enabled():
            # Validate settings before sending HTTP success headers.
            duration = timeout_seconds()
            result_limit()
            artifact_limit()
            options = arguments.get("simulation_options")
            if options is not None and cloud_mode():
                available = positive_int("EVCS_SIM_WORKERS", 1)
                requested = options.get("n_workers")
                if requested is not None and requested > available:
                    raise HTTPException(422, f"This deployment supports at most {available} simulation workers.")
                arguments = {**arguments, "simulation_options": {**options, "n_workers": requested or available}}
            if operation == "beta-sweep":
                span = arguments["beta_max"] - arguments["beta_min"]
                if span < 0:
                    raise HTTPException(422, "The sweep maximum must be at least its minimum.")
                intervals = span / arguments["beta_step"]
                if intervals >= positive_int("EVCS_MAX_SWEEP_POINTS", 25):
                    raise HTTPException(422, "The requested sweep exceeds this deployment's point limit.")
            lease = admission.acquire()
            return RunResponse(Supervisor({"operation": operation, "arguments": arguments}, lease, duration))
        return {"job_id": jobs.submit(work)}
    except admission.BusyError as exc:
        raise HTTPException(429, str(exc), headers={"Retry-After": "5"}) from exc


class Supervisor:
    def __init__(self, spec: dict, lease: admission.Lease, duration: float):
        self.spec = spec
        self.lease = lease
        self.duration = duration
        self.process = None
        self.temporary = None
        self.folder = None
        self._closed = False
        self._progress_offset = 0

    def progress_events(self):
        journal = self.folder / "progress.ndjson"
        if not journal.exists():
            return
        with journal.open("rb") as handle:
            handle.seek(self._progress_offset)
            for line in handle:
                # A concurrent append may not yet have written the whole line.
                if not line.endswith(b"\n"):
                    break
                self._progress_offset += len(line)
                yield flush_frame(line)

    async def start(self):
        if sys.platform == "linux":
            # Reap forecast workers orphaned when their solver parent is killed.
            # Limit waitpid below to this run's process group, not other requests.
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
                raise OSError(ctypes.get_errno(), "Cannot supervise simulation descendants")
        self.temporary = tempfile.TemporaryDirectory(prefix="evcs-run-")
        self.folder = Path(self.temporary.name).resolve()
        # Only the private directory created above may be cleaned by this runner.
        if not self.folder.is_relative_to(Path(tempfile.gettempdir()).resolve()):
            raise RuntimeError("Unexpected simulation temporary directory")
        (self.folder / "request.json").write_bytes(record(self.spec))
        environment = os.environ.copy()
        environment.update(PYTHONDONTWRITEBYTECODE="1", MPLBACKEND="Agg",
                           OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1")
        kwargs = {"start_new_session": True} if os.name != "nt" else {
            "creationflags": subprocess.CREATE_NEW_PROCESS_GROUP,
        }
        self.process = await asyncio.create_subprocess_exec(
            sys.executable, "-u", "-m", "app.services.run_worker", str(self.folder),
            cwd=str(BACKEND), env=environment, **kwargs,
        )

    async def close(self):
        with anyio.CancelScope(shield=True):
            await self._close()

    async def _close(self):
        if self._closed:
            return
        self._closed = True
        try:
            if self.process is not None:
                if os.name != "nt":
                    try:
                        os.killpg(self.process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        await asyncio.wait_for(self.process.wait(), 1)
                    except asyncio.TimeoutError:
                        pass
                    # Forecast workers share the session even if the main worker exited.
                    try:
                        os.killpg(self.process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                elif self.process.returncode is None:
                    killer = await asyncio.create_subprocess_exec(
                        "taskkill", "/PID", str(self.process.pid), "/T", "/F",
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    )
                    await killer.wait()
                if self.process.returncode is None:
                    self.process.kill()
                await self.process.wait()
                if sys.platform == "linux":
                    deadline = time.monotonic() + 2
                    while True:
                        try:
                            child, _ = os.waitpid(-self.process.pid, os.WNOHANG)
                        except ChildProcessError:
                            break
                        if child == 0:
                            if time.monotonic() >= deadline:
                                raise RuntimeError("Simulation descendant cleanup did not finish")
                            await asyncio.sleep(0.02)
        finally:
            try:
                if self.temporary is not None:
                    await asyncio.to_thread(self.temporary.cleanup)
            finally:
                self.lease.release()

    async def events(self):
        started = time.monotonic()
        try:
            # Track the spawned process even if the browser disconnects at startup.
            with anyio.CancelScope(shield=True):
                await self.start()
            yield flush_frame(record({"type": "progress", "phase": "Preparing network", "step": 0, "n_steps": 0}))
            last_sent = time.monotonic()
            while self.process.returncode is None:
                if time.monotonic() - started >= self.duration:
                    await self.close()
                    yield record({"type": "error", "code": "execution_timeout",
                                  "message": "The run exceeded this deployment's execution time limit."})
                    return
                for data in self.progress_events():
                    yield data
                    last_sent = time.monotonic()
                if time.monotonic() - last_sent >= 3:
                    yield flush_frame(record({"type": "heartbeat"}))
                    last_sent = time.monotonic()
                await asyncio.sleep(0.1)
            await self.process.wait()
            # Include updates written just before exit, before terminal output.
            for data in self.progress_events():
                yield data
            status_path = self.folder / "status.json"
            status = json.loads(status_path.read_bytes()) if status_path.exists() else {
                "status": "error", "code": "worker_exited",
                "message": f"Simulation worker exited unexpectedly (exit code {self.process.returncode}).",
            }
            if status["status"] != "done" or self.process.returncode != 0:
                yield record({"type": "error", "code": status.get("code", "worker_exited"),
                              "message": status.get("message", "Simulation worker failed.")})
                return
            path = self.folder / "result.json"
            if path.stat().st_size > result_limit():
                raise ValueError("Result exceeds this deployment's response-size limit.")
            result = await asyncio.to_thread(lambda: json.loads(path.read_bytes()))
            artifacts = []
            total = 0
            for item in result.get("artifacts", []):
                match = _ARTIFACT.fullmatch(item["url"])
                if match is None:
                    raise ValueError("Invalid simulation artifact path")
                image = self.folder / "plots" / match[1] / match[2]
                total += image.stat().st_size
                if total > artifact_limit():
                    raise ValueError("Plots exceed this deployment's artifact-size limit.")
                artifacts.append((item, image))
            for item, path in artifacts:
                if time.monotonic() - started >= self.duration:
                    raise TimeoutError("The run exceeded this deployment's execution time limit.")
                data = await asyncio.to_thread(path.read_bytes)
                item["url"] = "inline:" + item["name"]
                yield record({"type": "artifact", "name": item["name"], "url": item["url"],
                              "mime_type": "image/png", "data_base64": base64.b64encode(data).decode("ascii")})
            # No further GET is necessary to retrieve the completed scientific result.
            yield record({"type": "result", "result": result})
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            yield record({"type": "error", "code": "delivery_error", "message": str(exc)})


class RunResponse(StreamingResponse):
    def __init__(self, supervisor: Supervisor):
        self.supervisor = supervisor
        super().__init__(supervisor.events(), media_type="application/x-ndjson",
                         headers={"Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"})

    async def __call__(self, scope, receive, send):
        # One disconnect listener for all ASGI versions, including Uvicorn and tests.
        try:
            async with anyio.create_task_group() as group:
                async def stream():
                    try:
                        await self.stream_response(send)
                    except OSError:
                        # The client disconnected while a response chunk was sent.
                        pass
                    finally:
                        group.cancel_scope.cancel()

                async def disconnect():
                    await self.listen_for_disconnect(receive)
                    group.cancel_scope.cancel()

                group.start_soon(stream)
                group.start_soon(disconnect)
        finally:
            with anyio.CancelScope(shield=True):
                await self.supervisor.close()
