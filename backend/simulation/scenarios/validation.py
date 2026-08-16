"""Validation for user-supplied (or edited) network configs, per the
spec's requirement to fail with clear errors rather than crash or silently
produce garbage results."""
from simulation.scenarios.loader import build_network_from_data


def validate_network_data(data: dict) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    roads = data.get("roads", [])
    stations = data.get("stations", [])
    ods = data.get("ods", [])
    defaults = data.get("defaults", {})

    if not roads:
        errors.append("Network has no roads.")
    if not ods:
        errors.append("Network has no OD pairs.")

    station_names = [s.get("name") for s in stations]
    dupes = {n for n in station_names if station_names.count(n) > 1}
    if dupes:
        errors.append(f"Duplicate station name(s): {', '.join(sorted(dupes))}")

    od_names = [o.get("name") for o in ods]
    dupes = {n for n in od_names if od_names.count(n) > 1}
    if dupes:
        errors.append(f"Duplicate OD name(s): {', '.join(sorted(dupes))}")

    for st in stations:
        mu_s = st.get("mu_s", defaults.get("mu_s", 1.0))
        a_s = st.get("a_s", defaults.get("a_s", 1.0))
        if mu_s is not None and mu_s <= 0:
            errors.append(f"Station '{st.get('name')}': mu_s must be > 0 (got {mu_s}).")
        if a_s is not None and a_s <= 0:
            errors.append(f"Station '{st.get('name')}': a_s must be > 0 (got {a_s}).")

    for road in roads:
        L = road.get("L", defaults.get("L", 1.0))
        if L is not None and L <= 0:
            errors.append(f"Road '{road.get('u')}->{road.get('v')}': L must be > 0 (got {L}).")

    for od in ods:
        lam = od.get("lam", 0)
        if lam is not None and lam < 0:
            errors.append(f"OD '{od.get('name')}': lam must be >= 0 (got {lam}).")
        shares = od.get("shares", {})
        if not shares:
            errors.append(f"OD '{od.get('name')}': no class shares given.")
            continue
        for cls, share in shares.items():
            if share < 0 or share > 1:
                errors.append(
                    f"OD '{od.get('name')}' class '{cls}': share must be in [0,1] (got {share})."
                )
        total = sum(shares.values())
        if abs(total - 1.0) > 1e-6:
            warnings.append(
                f"OD '{od.get('name')}': class shares sum to {total:.3f}, not 1.0."
            )

    if errors:
        # Feasible-path checking requires a successful build; skip it if the
        # config is already structurally broken.
        return errors, warnings

    try:
        build_network_from_data(data)
    except ValueError as exc:
        errors.append(str(exc))
    except Exception as exc:  # noqa: BLE001
        errors.append(f"Failed to build network: {exc}")

    return errors, warnings
