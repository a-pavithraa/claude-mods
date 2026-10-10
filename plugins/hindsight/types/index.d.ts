export type SnagKind = 'search' | 'fix-loop' | 'big-output'
export type FixKind = 'pointer' | 'check' | 'standard' | 'info' | 'economy'
export type SnagStatus = 'watching' | 'judging' | 'proposed' | 'quiet' | 'sent' | 'done' | 'skipped'

export type Signal = { kind: SnagKind; area: string }

export type Snag = Signal & {
  id: string
  project: string
  sessions: string[]
  status: SnagStatus
  fix?: { kind: FixKind; text: string }
  /** The session the fix was saved or sent in; the snag reopens if it comes back in another one. */
  fixedIn?: string
  /** Fixes that were saved or sent before, and the snag came back anyway. */
  tried?: string[]
  lastAt: number
}

declare module 'claude-code' {
  interface PluginState {
    hindsight: { shown: Snag | null }
  }
}
