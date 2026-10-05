/** One finished turn: a ride, from prompt to answer. */
export type Trip = {
  /** What the ride cost, USD. */
  fare: number
  /** How long it took, ms. */
  ms: number
  /** When it ended, epoch ms. */
  at: number
  /** The first words of the prompt that hailed it. */
  prompt: string
  /** The model that drove it. */
  model: string
  /** How many times the meter jumped during it. */
  jumps: number
}

/** What the meter shows now: the pane draws from it. */
export type Live = {
  phase: 'idle' | 'hired' | 'waiting'
  /** Cents (or fen) on the drum. */
  units: number
  flash: number
  /** This ride's fare, or the last ride's while idle, in units. */
  trip: number | null
  /** Units a minute over the last minute. */
  rate: number
  tool: string | null
  isLit: boolean
  /** How long this ride has run, ms; 0 while idle. */
  rideMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'taxi-meter': {
      trips: Trip[]
      /** The highest milestone (USD) already rung this session. */
      milestone: number
      /** Meter jumps this session. */
      jumps: number
      /** This session's fare limit, USD; 0 for none. */
      budgetUsd: number
      /** The last budget warning given: 0, 80 or 100 (percent). */
      budgetWarned: number
      /** Whether the status line entry is hidden. */
      isHidden: boolean
      /** Whether the meter pane is open, so the tick feeds it. */
      isPaneOpen: boolean
      /** The meter as drawn, for the pane. */
      live: Live
      /** The ledger over time: [epoch ms, USD]. */
      history: [number, number][]
    }
  }
}
