export type SnagKind = 'search' | 'fix-loop' | 'retry' | 'big-output' | 'slow' | 'denied'
export type FixKind = 'pointer' | 'check' | 'standard' | 'info' | 'economy' | 'setting'
export type SnagStatus = 'watching' | 'judging' | 'proposed' | 'quiet' | 'sent' | 'done' | 'held' | 'skipped'

export type Signal = {
  kind: SnagKind
  area: string
  /** The call that showed the snag, cut short: the evidence a retro starts from. */
  call: string
  /** What the snag cost in that turn, in its kind's unit: searches, failures, tokens, seconds or declines. */
  cost: number
  /** The file a big read came from, so its size can be checked again before proposing. */
  path?: string
}

/** `cost` sums every turn of that session. */
export type Seen = { session: string; call: string; cost?: number }

export type Snag = Omit<Signal, 'call' | 'cost'> & {
  /** The latest calls that showed it, one per session. */
  seen?: Seen[]
  id: string
  project: string
  sessions: string[]
  status: SnagStatus
  fix?: { kind: FixKind; text: string }
  /** The session the fix was saved or sent in; the snag reopens if it comes back in another one. */
  fixedIn?: string
  /** The cost per session when the fix went in, to compare against if the snag comes back. */
  costBefore?: number
  /** Sessions started since the fix without the snag; enough of them make the fix `held`. */
  clean?: string[]
  /** Fixes that were saved or sent before, and the snag came back anyway. */
  tried?: string[]
  lastAt: number
}

declare module 'claude-code' {
  interface PluginState {
    hindsight: { shown: Snag | null }
  }
}
