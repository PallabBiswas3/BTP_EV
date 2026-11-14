"""Daily profiles (demand, solar, tariff) in physical time.

Profiles are piecewise constant with ``len(values)`` equal slots per day.
Classes live at module level so networks holding them can be pickled for
process-parallel forecasts.
"""
import math

_EPS = 1e-9


def slot_of_day(t: float, day_length: float, n_slots: int) -> int:
    """Index of the profile slot containing time ``t`` (boundaries belong to the later slot)."""
    frac = math.fmod(t, day_length) / day_length
    if frac < 0:
        frac += 1.0
    return min(int(frac * n_slots + _EPS), n_slots - 1)


def day_index(t: float, day_length: float) -> int:
    return int(math.floor(t / day_length + _EPS))


class DailyProfile:
    """value(t) = base * values[slot of day]."""

    def __init__(self, values, day_length: float, base: float = 1.0):
        self.values = [float(v) for v in values]
        if not self.values:
            raise ValueError("A daily profile needs at least one value.")
        self.day_length = float(day_length)
        self.base = float(base)

    def __call__(self, t: float) -> float:
        return self.base * self.values[slot_of_day(t, self.day_length, len(self.values))]

    def mean(self, t0: float, t1: float, samples: int = 4) -> float:
        """Average over [t0, t1] by midpoint sampling (exact when slots align with steps)."""
        width = (t1 - t0) / samples
        return sum(self(t0 + (i + 0.5) * width) for i in range(samples)) / samples


class SolarProfile(DailyProfile):
    """Daily shape scaled by peak power and a per-day weather factor in [0, 1]."""

    def __init__(self, values, day_length: float, peak_kw: float, weather=None):
        super().__init__(values, day_length, base=peak_kw)
        self.weather = [float(w) for w in (weather or [])]

    def __call__(self, t: float) -> float:
        factor = 1.0
        if self.weather:
            # Weather repeats after the listed days.
            factor = self.weather[day_index(t, self.day_length) % len(self.weather)]
        return factor * super().__call__(t)
