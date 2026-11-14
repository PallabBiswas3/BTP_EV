"""Resource policy for the request-scoped demo runner."""
import os


def cloud_mode() -> bool:
    return os.getenv("EVCS_RUNTIME_PROFILE", "").lower() == "cloud-run" or bool(os.getenv("K_SERVICE"))


def streaming_enabled() -> bool:
    return cloud_mode() or os.getenv("EVCS_STREAM_JOBS", "").lower() in {"1", "true", "yes"}


def positive_int(name: str, default: int) -> int:
    value = int(os.getenv(name, str(default)))
    if value < 1:
        raise ValueError(f"{name} must be positive")
    return value


def timeout_seconds() -> float:
    value = float(os.getenv("EVCS_RUN_TIMEOUT_SECONDS", "240" if cloud_mode() else "3600"))
    maximum = 3540 if cloud_mode() else 86400
    if not 0 < value <= maximum:
        raise ValueError(f"EVCS_RUN_TIMEOUT_SECONDS must be greater than 0 and at most {maximum}")
    return value


def result_limit() -> int:
    return positive_int("EVCS_MAX_RESULT_BYTES", 32 * 1024 * 1024)


def artifact_limit() -> int:
    return positive_int("EVCS_MAX_ARTIFACT_BYTES", 16 * 1024 * 1024)
