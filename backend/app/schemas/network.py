from typing import Literal, Optional
from pydantic import BaseModel, Field


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


class ODConfig(BaseModel):
    name: str
    origin: str
    dest: str
    lam: float
    shares: dict[str, float]


class NetworkConfig(BaseModel):
    defaults: Defaults = Field(default_factory=Defaults)
    classes: list[str] = Field(default_factory=lambda: ["EV", "NEV"])
    roads: list[RoadConfig]
    stations: list[StationConfig] = Field(default_factory=list)
    ods: list[ODConfig]


class SimulationOptions(BaseModel):
    accuracy_mode: Literal["preview", "balanced", "research"] = "preview"
    n_steps: int = Field(30, ge=1, le=200)
    max_outer_steps: int = Field(120, ge=1, le=500)
    outer_tolerance: float = Field(1e-4, gt=0, le=0.1)
    stable_outer_steps: int = Field(3, ge=1, le=20)
    kappa: float = Field(0.1, gt=0)
    delta: float = Field(0.02, gt=0)
    dt_outer: float = Field(1.0, gt=0)
    psi_max: float = Field(3.0, gt=0)
    grad_clip: float = Field(5.0, gt=0)
    t_end: float = Field(50.0, gt=0, le=500)
    psi0: Optional[dict[str, float]] = None


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
