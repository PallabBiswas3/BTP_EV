"""Compatibility imports for the supplied equilibrium forecast and diagnostics."""
from simulation.pricing.strategic_pricing import source

solve_equilibrium = source.solve_equilibrium
compute_derivative_trajectory = source.compute_derivative_trajectory
plot_convergence_trajectory = source.plot_convergence_trajectory
