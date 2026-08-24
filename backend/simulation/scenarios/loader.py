"""
Network construction from a JSON-schema dict, plus the bundled scenario
registry. `build_network_from_json(path)` from the original
`simulator_paper_generalised.py` is kept as a thin backward-compatible
wrapper around the new `build_network_from_data(dict)`.
"""
import hashlib
import json
from pathlib import Path

from simulation.core.network_engine import ChargingNetwork

NETWORKS_DIR = Path(__file__).resolve().parents[2] / "networks"

DEFAULT_DEFAULTS = dict(
    l0=0.25, L=2.0, a=1.0,
    mu_s=2.0, a_s=0.5, c_s=0.2, phi0=0.1,
    alpha=0.3, gamma=1.0, eta=0.05,
)

SCENARIO_DESCRIPTIONS = {
    "i": {
        "label": "Base network",
        "description": (
            "Three OD pairs, each with a private station (S1/S2/S3) and access "
            "to one of two shared stations (Sshared1/Sshared2) on cross-linking "
            "shortcuts. Mirrors the paper's shared-vs-private competitive setup, "
            "extended to three ODs."
        ),
    },
    "i2": {
        "label": "Demand-stress network",
        "description": (
            "Base network plus four additional pure-EV OD pairs (O1->D2, O2->D1, "
            "O2->D3, O3->D2) that only reach their destination via a shared "
            "station, increasing utilization and queueing pressure on the shared "
            "infrastructure."
        ),
    },
    "i3": {
        "label": "Expanded-connectivity network",
        "description": (
            "Base network plus extra cross-links (O1<->M2, O3<->M1, and their "
            "return legs) so OD1 and OD3 can reach both shared stations, "
            "widening each traveler's strategy set and intensifying station "
            "competition."
        ),
    },
}


def build_network_from_data(data: dict, path_settings=None) -> ChargingNetwork:
    defaults = data.get("defaults", DEFAULT_DEFAULTS)
    classes = data.get("classes", ["EV", "NEV"])

    net = ChargingNetwork(
        classes=classes, defaults=defaults, path_settings=path_settings,
    )
    fingerprint_payload = {
        "network": data,
        "path_settings": path_settings or {},
        "builder_version": "bounded-routes-v3",
    }
    net.cache_fingerprint = hashlib.sha256(
        json.dumps(
            fingerprint_payload, sort_keys=True, separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()

    for road in data.get("roads", []):
        net.add_road(
            u=road["u"],
            v=road["v"],
            classes=road.get("classes", None),
            l0=road.get("l0", None),
            L=road.get("L", None),
            a=road.get("a", None),
        )

    for st in data.get("stations", []):
        net.add_station(
            u=st["u"],
            v=st["v"],
            name=st["name"],
            classes=st.get("classes", None),
            mu_s=st.get("mu_s", None),
            a_s=st.get("a_s", None),
            c_s=st.get("c_s", None),
            phi0=st.get("phi0", None),
        )

    for od in data.get("ods", []):
        net.add_od(
            name=od["name"],
            origin=od["origin"],
            dest=od["dest"],
            lam_fn=lambda t, val=od["lam"]: val,
            class_shares=od["shares"],
        )

    net.build(verbose=False)
    return net


def build_network_from_json(path) -> ChargingNetwork:
    """Backward-compatible file-path wrapper around build_network_from_data."""
    with open(path, "r") as f:
        data = json.load(f)
    return build_network_from_data(data)


def list_scenarios() -> list[dict]:
    out = []
    for f in sorted(NETWORKS_DIR.glob("*.json")):
        sid = f.stem
        meta = SCENARIO_DESCRIPTIONS.get(sid, {"label": sid, "description": ""})
        out.append({"id": sid, **meta})
    return out


def load_scenario_data(scenario_id: str) -> dict:
    path = NETWORKS_DIR / f"{scenario_id}.json"
    if not path.exists():
        raise FileNotFoundError(f"Unknown scenario '{scenario_id}'")
    with open(path, "r") as f:
        return json.load(f)
