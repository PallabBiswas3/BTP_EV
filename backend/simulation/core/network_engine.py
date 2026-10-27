"""Compatibility imports for the unchanged supplied network engine.

The complete implementation lives in backend/network_engine.py. Do not
change route selection, equations or numerical behavior in this adapter.
"""
from network_engine import (
    ChargingNetwork, latency, station_cost, station_throughput, waiting_time,
)

__all__ = [
    "ChargingNetwork", "latency", "station_cost", "station_throughput", "waiting_time",
]
