export type SnagKind = 'search' | 'fix-loop' | 'big-output'
export type FixKind = 'pointer' | 'check' | 'standard' | 'info' | 'economy'
export type SnagStatus = 'watching' | 'judging' | 'proposed' | 'quiet' | 'done' | 'skipped'

export type Signal = { kind: SnagKind; area: string }

export type Snag = Signal & {
  id: string
  project: string
  sessions: string[]
  status: SnagStatus
  fix?: { kind: FixKind; text: string }
  lastAt: number
}

declare module 'claude-code' {
  interface PluginState {
    hindsight: { shown: Snag | null }
  }
}
