export type ChangedFile = {
  path: string
  added: number
  removed: number
  isNew: boolean
  usedBy?: number
}

export type Blast = {
  files: ChangedFile[]
  lines: number
  areas: string[]
  risky: string[]
  widest?: ChangedFile
}

export type Judgment = {
  key: string
  label: string
  value: number
}

export type Jev =
  | { status: 'off' }
  | { status: 'failed'; note: string }
  | { status: 'judged'; judgments: Judgment[]; hardToRead: number }

export type Verdict = 'pass' | 'read' | 'hold'

export type Triage = {
  fingerprint: string
  verdict: Verdict
  points: number
  reasons: string[]
  blast: Blast
  jev: Jev
  isPatchCut: boolean
}

export type Scope = 'tree' | 'tracked' | 'staged'

export type Finding = {
  priority: string
  title: string
  at: string
  body: string
}

export type Review =
  | { status: 'idle' }
  | { status: 'running'; covers: string; tookMs: number; doing?: string; brief?: string }
  | {
      status: 'done'
      covers: string
      summary: string
      findings: Finding[]
      tookMs: number
      isClean: boolean
      fingerprint?: string
      brief?: string
    }

export type TurnTally = {
  lines: number
  files: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'triage-gate': {
      triage: Triage | null
      approved: string[]
      review: Review
      turn: TurnTally
      sizeLevel: number
      asks: string[]
    }
  }
}
