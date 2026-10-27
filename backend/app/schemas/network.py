from typing import Literal, Optional
from pydantic import BaseModel, Field, ConfigDict, field_validator, model_validator


class Defaults(BaseModel):
    l0: float = 0.25
    L: float = 2.0
    a: float = 1.0
    mu_s: float = 2.0
    a_s: float = 0.5
    c_s: float = 0.2
    phi0: float = 0.1
    alpha: float = 0.3
    gamma: float = 1.0
    eta: float = 0.05


class RoadConfig(BaseModel):
    u: str
    v: str
    classes: Optional[list[str]] = None
    l0: Optional[float] = None
    L: Optional[float] = None
    a: Optional[float] = None


class StationConfig(BaseModel):
    u: str
    v: str
    name: str
    classes: Optional[list[str]] = None
    mu_s: Optional[float] = None
    a_s: Optional[float] = None
    c_s: Optional[float] = None
    phi0: Optional[float] = None
    initial_psi: Optional[float] = Field(None, ge=0)


class ODConfig(BaseModel):
    name: str
    origin: str
    dest: str
    lam: float = Field(ge=0)
    shares: dict[str, float]
    demand_schedule: str = ""

    @field_validator("demand_schedule")
    @classmethod
    def valid_schedule(cls, value):
        from simulation.scenarios.demand import StepDemand
        StepDemand.from_spec(0.0, value)
        return value


class NetworkConfig(BaseModel):
    defaults: Defaults = Field(default_factory=Defaults)
    classes: list[str] = Field(default_factory=lambda: ["EV", "NEV"])
    roads: list[RoadConfig]
    stations: list[StationConfig] = Field(default_factory=list)
    ods: list[ODConfig]


class SimulationOptions(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    accuracy_mode: Literal["preview", "balanced", "research"] = "preview"
    n_steps: int = Field(30, ge=1, le=200)
    max_outer_steps: int = Field(120, ge=1, le=500)
    outer_tolerance: float = Field(1e-4, gt=0, le=0.1)
    stable_outer_steps: int = Field(3, ge=1, le=20)
    kappa: float = Field(0.1, gt=0)
    delta: float = Field(0.02, gt=0)
    dt_outer: float = Field(1.0, gt=0)
    # Accepted only as null to reject old clients requesting a non-source cap.
    psi_max: None = None
    grad_clip: Optional[float] = Field(None, gt=0)
    t_end: float = Field(75000.0, gt=0)
    h: float = Field(1500.0, gt=0)
    ctrl_horizon: int | Literal["eq"] = 10
    profit_mode: Literal["mean", "end"] = "end"
    eq_t_max: float = Field(75000.0, gt=0)
    parallel: Optional[bool] = None
    n_workers: Optional[int] = Field(None, ge=1)
    psi0: float = Field(0.5, ge=0)
    final_t: float = Field(500.0, gt=0)
    save_plots: bool = True

    @field_validator("ctrl_horizon", mode="before")
    @classmethod
    def valid_horizon(cls, value):
        if value == "eq":
            return value
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise ValueError("ctrl_horizon must be a positive integer or 'eq'")
        return value

    @model_validator(mode="after")
    def valid_step_count(self):
        if round(self.t_end / self.h) < 1:
            raise ValueError("t_end/h must round to at least one pricing step")
        return self


class SimulateRequest(BaseModel):
    network: NetworkConfig
    simulation_options: SimulationOptions = Field(default_factory=SimulationOptions)


class EquilibriumRequest(BaseModel):
    network: NetworkConfig
    simulation_options: SimulationOptions = Field(default_factory=SimulationOptions)


class BetaSweepRequest(BaseModel):
    network: NetworkConfig
    simulation_options: SimulationOptions = Field(default_factory=SimulationOptions)
    beta_min: float = Field(0.2, ge=0, le=1)
    beta_max: float = Field(0.8, ge=0, le=1)
    beta_step: float = Field(0.1, gt=0, le=1)


class ComparePricingRequest(BaseModel):
    network: NetworkConfig
    simulation_options: SimulationOptions = Field(default_factory=SimulationOptions)


class ValidateRequest(BaseModel):
    network: dict
