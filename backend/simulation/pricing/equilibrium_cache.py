"""Persistent, verified equilibrium-state cache.

Exact price matches may skip integration after the caller rechecks the stored
state's residual. Nearby entries are warm starts only and are never accepted as
solutions without a fresh integration.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path

import numpy as np


CACHE_MODEL_VERSION = "evcs-equilibrium-v2"
MAX_ENTRIES_PER_NETWORK = 512
MAX_NEAREST_CANDIDATES = 128
MAX_NEAREST_RMS_PRICE_DISTANCE = 0.35

_DEFAULT_PATH = Path(__file__).resolve().parents[2] / ".cache" / "equilibria.sqlite3"
_SCHEMA_LOCK = threading.Lock()
_SCHEMA_READY: set[str] = set()


def _cache_path() -> Path:
    return Path(os.environ.get("EVCS_CACHE_PATH", _DEFAULT_PATH))


def _connect() -> sqlite3.Connection:
    path = _cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10.0)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=10000")
    path_key = str(path.resolve())
    if path_key not in _SCHEMA_READY:
        with _SCHEMA_LOCK:
            if path_key not in _SCHEMA_READY:
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS equilibria (
                        network_key TEXT NOT NULL,
                        price_key TEXT NOT NULL,
                        tolerance REAL NOT NULL,
                        prices_json TEXT NOT NULL,
                        n_states INTEGER NOT NULL,
                        state BLOB NOT NULL,
                        residual REAL NOT NULL,
                        conservation_error REAL NOT NULL,
                        elapsed REAL NOT NULL,
                        updated_at REAL NOT NULL,
                        PRIMARY KEY (network_key, price_key, tolerance)
                    )
                    """
                )
                connection.execute(
                    "CREATE INDEX IF NOT EXISTS idx_equilibria_network "
                    "ON equilibria(network_key, updated_at DESC)"
                )
                connection.commit()
                _SCHEMA_READY.add(path_key)
    return connection


def _network_key(net) -> str | None:
    fingerprint = getattr(net, "cache_fingerprint", None)
    return f"{CACHE_MODEL_VERSION}:{fingerprint}" if fingerprint else None


def _prices(psi: dict) -> dict[str, float]:
    return {name: float(psi[name]) for name in sorted(psi)}


def _price_key(psi: dict) -> tuple[str, str]:
    payload = _prices(psi)
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return serialized, serialized


def load_exact(net, psi: dict, tolerance: float):
    network_key = _network_key(net)
    if network_key is None:
        return None
    price_key, _ = _price_key(psi)
    try:
        with _connect() as connection:
            row = connection.execute(
                """
                SELECT state, residual, conservation_error, elapsed
                FROM equilibria
                WHERE network_key = ? AND price_key = ? AND tolerance <= ?
                ORDER BY tolerance ASC LIMIT 1
                """,
                (network_key, price_key, float(tolerance)),
            ).fetchone()
        if row is None:
            return None
        state = np.frombuffer(row[0], dtype=np.float64).copy()
        if state.size != net.N_STATES or not np.all(np.isfinite(state)):
            return None
        return state, float(row[1]), float(row[2]), float(row[3])
    except (OSError, sqlite3.Error, ValueError):
        return None


def load_nearest(net, psi: dict):
    network_key = _network_key(net)
    if network_key is None or not psi:
        return None
    target = _prices(psi)
    try:
        with _connect() as connection:
            rows = connection.execute(
                """
                SELECT prices_json, state
                FROM equilibria
                WHERE network_key = ? AND n_states = ?
                ORDER BY updated_at DESC LIMIT ?
                """,
                (network_key, net.N_STATES, MAX_NEAREST_CANDIDATES),
            ).fetchall()
        best = None
        for prices_json, state_blob in rows:
            candidate_prices = json.loads(prices_json)
            if candidate_prices.keys() != target.keys():
                continue
            distance = float(np.sqrt(np.mean([
                (target[name] - float(candidate_prices[name])) ** 2
                for name in target
            ])))
            if best is None or distance < best[0]:
                state = np.frombuffer(state_blob, dtype=np.float64).copy()
                if state.size == net.N_STATES and np.all(np.isfinite(state)):
                    best = (distance, state)
        if best is None or best[0] > MAX_NEAREST_RMS_PRICE_DISTANCE:
            return None
        return best[1], best[0]
    except (OSError, sqlite3.Error, ValueError, json.JSONDecodeError):
        return None


def store(net, psi: dict, tolerance: float, state, residual: float,
          conservation_error: float, elapsed: float) -> None:
    network_key = _network_key(net)
    state = np.asarray(state, dtype=np.float64)
    if network_key is None or state.size != net.N_STATES or not np.all(np.isfinite(state)):
        return
    price_key, prices_json = _price_key(psi)
    try:
        with _connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO equilibria
                (network_key, price_key, tolerance, prices_json, n_states, state,
                 residual, conservation_error, elapsed, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    network_key, price_key, float(tolerance), prices_json,
                    net.N_STATES, state.tobytes(), float(residual),
                    float(conservation_error), float(elapsed), time.time(),
                ),
            )
            connection.execute(
                """
                DELETE FROM equilibria
                WHERE network_key = ? AND rowid NOT IN (
                    SELECT rowid FROM equilibria WHERE network_key = ?
                    ORDER BY updated_at DESC LIMIT ?
                )
                """,
                (network_key, network_key, MAX_ENTRIES_PER_NETWORK),
            )
    except (OSError, sqlite3.Error, ValueError):
        return
