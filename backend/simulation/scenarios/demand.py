"""Picklable constant and step demands matching the reference CSV schedules."""
from bisect import bisect_right
import math


class ConstantDemand:
    def __init__(self, value):
        self.value = value

    def __call__(self, _time):
        return self.value


class StepDemand:
    def __init__(self, base_value, switches):
        switches = sorted(switches)
        self.times = [0.0] + [time for time, _ in switches]
        self.values = [base_value] + [value for _, value in switches]

    def __call__(self, time):
        return self.values[max(0, bisect_right(self.times, time) - 1)]

    @classmethod
    def from_spec(cls, base_value, specification):
        switches = []
        for chunk in str(specification).split(";"):
            if not chunk.strip():
                continue
            try:
                time, value = map(float, chunk.split(":"))
            except ValueError as exc:
                raise ValueError("Demand schedule must use time:value;time:value syntax") from exc
            if not math.isfinite(time) or not math.isfinite(value) or time < 0 or value < 0:
                raise ValueError("Demand schedule times and values must be finite and nonnegative")
            switches.append((time, value))
        if len({time for time, _ in switches}) != len(switches):
            raise ValueError("Demand schedule contains duplicate switch times")
        return cls(base_value, switches)
