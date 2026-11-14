import type { CSSProperties } from 'react'

interface Props {
  /** Number of charger bays to draw. */
  bays: number
  /** Vehicles at the station, charging or waiting. */
  occupancy: number
  /** Vehicles waiting for a free bay. */
  queue: number
  /** Vehicles arriving and leaving per unit time. */
  arrivalRate: number
  departureRate: number
  /** Service rate when every bay is busy; sets how busy the lanes look. */
  capacity: number
  /** Seconds one visual charge cycle takes (slower chargers fill more slowly). */
  chargeSeconds?: number
  color?: string
  rateUnit?: string
}

const MAX_BAYS = 8
const MAX_QUEUE = 6
const MAX_LANE_CARS = 3

function Car({ color, style, className }: { color: string; style?: CSSProperties; className?: string }) {
  return (
    <svg className={className} style={style} width="20" height="12" viewBox="0 0 20 12" aria-hidden="true">
      <path d="M2.5 8.5V6.2c0-.7.5-1.3 1.2-1.4l1.5-.3 1.4-2.4c.3-.5.8-.8 1.4-.8h4.3c.6 0 1.1.3 1.4.8l1.3 2.3 1.7.4c.7.2 1.2.8 1.2 1.5v2.2c0 .4-.3.7-.7.7H3.2c-.4 0-.7-.3-.7-.7Z" fill={color} />
      <circle cx="6" cy="9.4" r="1.9" fill="#24221d" stroke="#fff" strokeWidth=".8" />
      <circle cx="14.4" cy="9.4" r="1.9" fill="#24221d" stroke="#fff" strokeWidth=".8" />
    </svg>
  )
}

/** How many cars to show moving in a lane, from the flow relative to capacity. */
function laneCars(rate: number, capacity: number) {
  if (!(rate > 0) || !(capacity > 0)) return 0
  const share = rate / capacity
  if (share < 0.03) return 0
  return Math.max(1, Math.min(MAX_LANE_CARS, Math.round(share * MAX_LANE_CARS)))
}

/**
 * A small animated picture of one charger group: vehicles drive in on the
 * left, wait if every bay is busy, charge, and drive out on the right.
 * The motion is illustrative; the numbers underneath are the data.
 */
export default function ChargingScene({
  bays, occupancy, queue, arrivalRate, departureRate, capacity,
  chargeSeconds = 3, color = '#2a78d6', rateUnit = '/h',
}: Props) {
  const shownBays = Math.max(1, Math.min(MAX_BAYS, Math.round(bays)))
  const charging = Math.min(Math.max(occupancy - Math.max(queue, 0), 0), bays)
  const waiting = Math.max(queue, 0)
  const waitingCars = Math.min(MAX_QUEUE, Math.ceil(waiting - 0.05))
  const arriving = laneCars(arrivalRate, capacity)
  const leaving = laneCars(departureRate, capacity)
  const laneSeconds = 2.6

  return (
    <div className="scene">
      <div className="scene-track">
        <div className="scene-lane" title="Arriving">
          {Array.from({ length: arriving }, (_, i) => (
            <Car key={i} color="#4a463e" className="scene-car moving"
                 style={{ animationDuration: `${laneSeconds}s`, animationDelay: `${(-i * laneSeconds) / arriving}s` }} />
          ))}
        </div>

        <div className={`scene-queue${waiting > 0.05 ? ' active' : ''}`} title="Waiting for a charger">
          {Array.from({ length: waitingCars }, (_, i) => {
            const fill = Math.min(Math.max(waiting - i, 0), 1)
            return <Car key={i} color="#e34948" className="scene-car waiting" style={{ opacity: 0.35 + 0.65 * fill, animationDelay: `${i * 0.18}s` }} />
          })}
          {waiting > MAX_QUEUE && <span className="scene-more">+{(waiting - MAX_QUEUE).toFixed(0)}</span>}
        </div>

        <div className="scene-bays">
          {Array.from({ length: shownBays }, (_, i) => {
            // Spread fractional occupancy across the drawn bays.
            const fill = Math.min(Math.max((charging * shownBays) / Math.max(bays, 1e-9) - i, 0), 1)
            return (
              <div className={`scene-bay${fill > 0.05 ? ' busy' : ''}`} key={i}>
                <svg className="scene-plug" width="9" height="11" viewBox="0 0 9 11" aria-hidden="true">
                  <path d="M5.4 0 .6 6.2h3L3 11l5.4-6.6h-3.1L5.4 0Z" fill={fill > 0.05 ? color : '#c9c2b3'} />
                </svg>
                {fill > 0.05 && <Car color={color} className="scene-car parked" style={{ opacity: 0.35 + 0.65 * fill }} />}
                <div className="scene-charge">
                  {fill > 0.05 && <span style={{ background: color, animationDuration: `${chargeSeconds}s`, animationDelay: `${-i * 0.7}s` }} />}
                </div>
              </div>
            )
          })}
        </div>

        <div className="scene-lane" title="Leaving after charging">
          {Array.from({ length: leaving }, (_, i) => (
            <Car key={i} color={color} className="scene-car moving"
                 style={{ animationDuration: `${laneSeconds}s`, animationDelay: `${(-i * laneSeconds) / leaving - 0.9}s` }} />
          ))}
        </div>
      </div>

      <div className="scene-caption">
        <span><b>{arrivalRate.toFixed(arrivalRate < 10 ? 2 : 1)}</b> arriving{rateUnit}</span>
        <span className={waiting > 0.05 ? 'warn' : ''}><b>{waiting.toFixed(waiting < 10 ? 2 : 1)}</b> waiting</span>
        <span><b>{charging.toFixed(2)}</b> of {Number.isInteger(bays) ? bays : bays.toFixed(1)} charging</span>
        <span><b>{departureRate.toFixed(departureRate < 10 ? 2 : 1)}</b> leaving{rateUnit}</span>
      </div>
    </div>
  )
}
