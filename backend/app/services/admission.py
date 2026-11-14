"""One admission policy shared by legacy jobs and streamed requests."""
import threading

from app.services.execution_config import positive_int

_LOCK = threading.Lock()
_ACTIVE = 0


class BusyError(RuntimeError):
    pass


class Lease:
    def __init__(self):
        self._released = False

    def release(self):
        global _ACTIVE
        with _LOCK:
            if not self._released:
                _ACTIVE -= 1
                self._released = True


def acquire() -> Lease:
    global _ACTIVE
    with _LOCK:
        if _ACTIVE >= positive_int("EVCS_MAX_CONCURRENT_RUNS", 1):
            raise BusyError("Another simulation is running. Please try again after it finishes.")
        _ACTIVE += 1
    return Lease()
