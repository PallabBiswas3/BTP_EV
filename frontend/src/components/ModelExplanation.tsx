export default function ModelExplanation() {
  return (
    <div className="explain-section">
      <p>
        This simulator implements a tri-level closed-loop model of EV charging-station pricing on a
        congested road network, based on Hota (2026), <i>"Game-Theoretic Modeling of Competitive Electric
        Vehicle Charging Stations with Strategic Users on a Traffic Network."</i> Three coupled processes run
        at different timescales: traffic flows and route choice settle quickly for a fixed set of prices
        (the <b>inner loop</b>), while charging stations slowly adjust prices to maximize profit against
        that settled traffic pattern (the <b>outer loop</b>).
      </p>

      <div className="loop-diagram">
        <div className="loop-step">Station price ψ</div>
        <div className="loop-arrow">↓ affects EV path cost</div>
        <div className="loop-step">Route choice y (replicator dynamics)</div>
        <div className="loop-arrow">↓ determines</div>
        <div className="loop-step">Traffic densities x, station occupancy</div>
        <div className="loop-arrow">↓ determines</div>
        <div className="loop-step">Throughput ρ, station profit π</div>
        <div className="loop-arrow">↓ profit gradient</div>
        <div className="loop-step">Updated price ψ</div>
        <div className="loop-arrow">↺ loop repeats</div>
      </div>

      <h3>1. Traffic dynamics</h3>
      <p>
        EV and NEV densities evolve separately on every road link, following a compartmental
        (cell-transmission-style) model: inflow from upstream links minus outflow, where outflow is
        proportional to local density. Road travel time (latency) increases sharply as a link approaches
        its capacity:
      </p>
      <div className="formula-line">φ_i(x_i) = l0 · (x_i / L) / (1 − x_i / L)</div>

      <h3>2. Route-choice dynamics</h3>
      <p>
        Drivers don't jump instantly to the cheapest route — they shift gradually via replicator dynamics,
        the standard model of evolutionary/population games. A path gains a larger share of demand when it's
        cheaper than the population average, and loses share when it's more expensive:
      </p>
      <div className="formula-line">dy_p/dt = η · y_p · (average_cost − cost_p)</div>
      <details className="learn-more">
        <summary>Why this converges to a Wardrop equilibrium</summary>
        <p style={{ marginBottom: 0 }}>
          At any fixed point of the replicator dynamics, every path carrying positive flow must have exactly
          the average cost for its OD/class group — otherwise it would still be gaining or losing share. That
          is precisely the classical Wardrop condition: all used paths have equal, minimal cost.
        </p>
      </details>

      <h3>3. Charging-station dynamics</h3>
      <p>
        Each station is modeled as a finite-capacity buffer. Below its saturation point K_s, every arriving
        EV finds a free charger; above it, a genuine queue forms.
      </p>
      <div className="formula-line">K_s = μ_s / a_s</div>
      <div className="formula-line">q_s = max(x_s − K_s, 0)</div>
      <div className="formula-line">w_s = q_s / μ_s</div>
      <div className="formula-line">ρ_s = min(a_s · x_s, μ_s)</div>
      <p>
        EV users perceive a station's cost as free-flow access time, plus the weighted waiting time, plus the
        monetary price converted into time-equivalent units — this is what feeds back into route choice above.
      </p>

      <h3>4. The pricing game</h3>
      <p>
        Every station is a profit-maximizing player, competing non-cooperatively against every other station.
        Profit is margin times throughput:
      </p>
      <div className="formula-line">π_s = (ψ_s − c_s) · ρ_s</div>
      <p>
        Stations don't solve this in closed form — they perform gradient ascent, nudging price in the
        direction that increases profit, estimated by perturbing price slightly up and down and re-solving
        the inner traffic equilibrium each time (this is why running a simulation takes a moment: every outer
        pricing step requires several inner equilibrium solves).
      </p>
      <div className="formula-line">ψ_s ← projection[ ψ_s + Δt · κ · ∂π_s/∂ψ_s ]</div>
      <details className="learn-more">
        <summary>Why this is a genuine game, not central planning</summary>
        <p style={{ marginBottom: 0 }}>
          Each station only ever sees its own profit gradient — raising its own price and watching how its
          own throughput responds as EVs reroute to competitors. There's no coordinator setting all prices at
          once. The joint outcome (a Nash equilibrium) emerges from every station independently climbing its
          own profit surface while the others do the same, coupled only through the shared traffic network.
        </p>
      </details>

      <h3>Reading the dashboard</h3>
      <p>
        Two different notions of "time" appear throughout: continuous simulation time <b>t</b> (how traffic
        and queues evolve for a fixed price, shown on the network animation and Station Analysis tab), and the
        discrete outer pricing iteration <b>k</b> (how prices themselves evolve, shown on the Pricing Dynamics
        tab). They're deliberately kept separate on every chart's axis label.
      </p>
    </div>
  )
}
