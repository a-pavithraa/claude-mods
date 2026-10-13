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

/** A file, and the changed line Jev points at in it when one hunk stands out. */
export type Place = { path: string; line?: number }

/** `at`: where Jev places the statement, when it is fairly sure of a file. */
export type Judgment = {
  key: string
  label: string
  value: number
  at?: Place
}

/**
 * `tookMs`: how long Jev took to answer, and `tokens`: the input tokens it billed, both shown in the pane's
 * diagnostics. `hardestAt`: the place hardest to follow.
 */
export type Jev =
  | { status: 'off' }
  | { status: 'failed'; note: string; tookMs?: number }
  | { status: 'judged'; judgments: Judgment[]; hardToRead: number; hardestAt?: Place; tookMs?: number; tokens?: number }

/** A Jev signal that fired, with where to look: what the pane, the reasons and Start with all show. */
export type Flag = {
  key: string
  label: string
  said: string
  isLikely: boolean
  at?: Place
  groups?: { name: string; files: number }[]
}

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
  /** The shell command Claude ran to commit, when the triage came from one: approving asks Claude to run it again. */
  command?: string
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
