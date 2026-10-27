export default function ModelExplanation() {
  return (
    <div className="explain-section">
      <p>
        This simulator couples traffic conservation, evolutionary route choice, and competitive
        charging prices. Stations predict the response to candidate prices from the current state.
        They update simultaneously, then traffic and queues advance one physical-time interval.
      </p>
      <div className="loop-diagram">
        <div className="loop-step">Current traffic and route allocation</div>
        <div className="loop-arrow">↓ two price forecasts per station</div>
        <div className="loop-step">Predicted throughput and profit</div>
        <div className="loop-arrow">↓ estimate own-price profit gradient</div>
        <div className="loop-step">Simultaneous price updates</div>
        <div className="loop-arrow">↓ advance traffic one interval h</div>
        <div className="loop-step">New traffic and station state</div>
      </div>
      <h3>Traffic and station dynamics</h3>
      <p>Road and station occupancy change by arrivals minus departures. Station service saturates at its maximum rate.</p>
      <div className="formula-line">dx_road/dt = arrivals − a · x_road</div>
      <div className="formula-line">dx_station/dt = arrivals − min(a_s · x_station, μ_s)</div>
      <div className="formula-line">Road cost = l0 · (x_total / L) / (1 − x_total / L)</div>
      <div className="formula-line">Queue = max(x_station − μ_s/a_s, 0); waiting time = queue/μ_s</div>
      <div className="formula-line">Station cost = φ0 + α · waiting time + γ · price</div>
      <h3>Route adaptation and changing demand</h3>
      <p>
        Cheaper-than-average paths gain allocation through replicator dynamics.
        Current demand scales these allocations into physical route flows. A demand schedule
        can change arrivals during both forecasts and the actual simulation.
      </p>
      <div className="formula-line">dy_p/dt = η · y_p · (average cost − path cost)</div>
      <div className="formula-line">q_p(t) = demand(t) · y_p / sum(y)</div>
      <p>
        The strategy set contains up to five road routes and one charging route per reachable
        station, subject to the reference cost cutoff. Equal costs among used paths are a
        diagnostic; they do not by themselves certify equilibrium.
      </p>
      <h3>Forecasts and the pricing game</h3>
      <div className="formula-line">Profit = (price − operating cost) · throughput</div>
      <p>
        A station forecasts profit at its price plus and minus a small perturbation, holding
        competitors' prices fixed. Finite-horizon mode uses endpoint profit or the mean of
        profits sampled once per interval. Equilibrium mode instead forecasts a fixed-price
        steady state. Both modes advance the actual traffic only one interval after updating.
      </p>
      <div className="formula-line">Gradient ≈ (forecast profit+ − forecast profit−)/(price+ − price−)</div>
      <div className="formula-line">New price = max(0, price + dt_outer · κ · gradient)</div>
      <p>
        Prices have a zero lower bound; gradient clipping is optional. Each station optimizes its own profit;
        stable prices do not establish a Nash equilibrium or minimum citywide waiting time.
      </p>
      <h3>Reading the dashboard</h3>
      <p>
        Network, station and route charts use physical simulation time t. Pricing charts use
        update index k. The last frame is the final simulated state, rather than an equilibrium
        snapshot. The run performs round(t_end/h) updates; all forecast scenarios start from
        the same current traffic state.
      </p>
      <p>
        Routing follows the supplied scripts exactly: class labels do not filter roads, and
        OD pairs without a road-only connection are skipped. Initial pricing uses one uniform
        value, regardless of station initial_psi entries. After pricing, a separate fixed-price
        continuation produces the original final traffic summary. Its results and the original
        PNG plots are available in Raw Data.
      </p>
    </div>
  )
}
