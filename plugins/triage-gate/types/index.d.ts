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

/** `tookMs`: how long Jev took to answer, shown in the pane's diagnostics. */
export type Jev =
  | { status: 'off' }
  | { status: 'failed'; note: string; tookMs?: number }
  | { status: 'judged'; judgments: Judgment[]; hardToRead: number; tookMs?: number }

export type Verdict = 'pass' | 'read' | 'hold'

/** Which change a triage judged: the commit's scope, its folder, and the paths its `git add` named. */
export type Subject = { scope: Scope; cwd?: string; paths?: string[] }

export type Triage = {
  fingerprint: string
  subject?: Subject
  verdict: Verdict
  points: number
  reasons: string[]
  blast: Blast
  jev: Jev
  isPatchCut: boolean
  assessedAt?: number
  /** The change moved on after this assessment: Claude edited a file, or an approval found it changed. */
  isEdited?: boolean
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
      isTimedOut?: boolean
      /** Claude edited a file after the review; set by the Edit and Write hooks. */
      isEdited?: boolean
      fingerprint?: string
      /** subjectKey of the triage the review was run on; a later triage of another change hides its findings. */
      subject?: string
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
      /** The pane's Detailed signals section is open. */
      details: boolean
    }
  }
}
