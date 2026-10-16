import type { Need, ShadowJev, ShadowRow } from '../types'

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_TIMEOUT_MS = 8000
/** Pinned, not `jev-latest`: a shadow comparison means little if the model moves under it. */
export const JEV_MODEL = 'jev-1.13.0'
/** Below this, Jev's top label is no call at all: an uncertain answer is not read as "complex". */
export const SURE = 0.8
export const SHADOW_KEEP = 200
const SHOWN_DISAGREEMENTS = 5
const ASK_CHARS = 60

// TypeSafe's list price for Jev: $0.042 per million input tokens, output free. Tokens are guessed at four
// characters each, so this is an estimate.
const JEV_INPUT_PER_MILLION = 0.042
const CHARS_PER_TOKEN = 4

export const jevCostOf = (body: string) => (body.length / CHARS_PER_TOKEN) * (JEV_INPUT_PER_MILLION / 1_000_000)

const ORDER: readonly Need[] = ['trivial', 'normal', 'complex']

export function requestBody(brief: string, request: string, previousReply: string, model = JEV_MODEL) {
  return JSON.stringify({
    model,
    state: { request, previous_assistant_reply: previousReply },
    questions: {
      need: {
        type: 'score',
        instructions: brief,
        criteria: [
          'trivial: a lookup, a concept question, a one-line or one-file edit, a rename within one file, a git or shell chore.',
          'normal: everything between trivial and complex, including a rename or find-and-replace across many files.',
          'complex: design, a feature across modules, debugging an unknown cause, a wide refactor, security or concurrency.',
        ],
      },
    },
  })
}

type RawAnswer = { probabilities?: Record<string, number> }

export function parseJev(status: number, text: string, tookMs: number): ShadowJev {
  if (status === 401) return { status: 'failed', reason: 'Jev refused the API key (401)', tookMs }
  if (status < 200 || status >= 300) return { status: 'failed', reason: `Jev answered ${status}`, tookMs }

  let answer: RawAnswer | undefined

  try {
    const parsed: unknown = JSON.parse(text)
    answer =
      typeof parsed === 'object' && parsed !== null && 'answers' in parsed
        ? (parsed.answers as Record<string, RawAnswer>).need
        : undefined
  } catch {
    answer = undefined
  }

  const shares = Object.entries(answer?.probabilities ?? {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, share]) => share)

  if (shares.length !== ORDER.length) return { status: 'failed', reason: 'Jev sent an answer model-fit could not read', tookMs }

  const top = shares.indexOf(Math.max(...shares))
  const confidence = shares[top] ?? 0
  const label = confidence >= SURE ? ORDER[top] : undefined

  return { status: 'judged', ...(label === undefined ? {} : { label }), confidence, shares, tookMs }
}

export const keep = (rows: ShadowRow[], row: ShadowRow) => [...rows, row].slice(-SHADOW_KEEP)

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)

  return sorted.length === 0 ? 0 : (sorted[Math.floor(sorted.length / 2)] ?? 0)
}

const askOf = (ask: string) => (ask.length > ASK_CHARS ? `${ask.slice(0, ASK_CHARS - 1)}…` : ask)

/** What the shadow comparison has found so far: agreement, Jev's doubts and failures, its speed and its cost. */
export function shadowReport(rows: ShadowRow[]) {
  if (rows.length === 0) return ['Jev shadow: on, nothing compared yet.']

  const judged = rows.filter(row => row.jev.status === 'judged')
  const sure = judged.filter(row => row.jev.status === 'judged' && row.jev.label !== undefined)
  const agreed = sure.filter(row => row.jev.status === 'judged' && row.jev.label === row.haiku)
  const failures = rows.flatMap(row => (row.jev.status === 'failed' ? [row.jev.reason] : []))
  const disagreements = sure.flatMap(row =>
    row.jev.status === 'judged' && row.jev.label !== row.haiku
      ? [`  "${askOf(row.ask)}": Haiku ${row.haiku}, Jev ${row.jev.label} (${Math.round(row.jev.confidence * 100)}%)`]
      : [],
  )
  const spent = rows.reduce((sum, row) => sum + row.jevUsd, 0)
  const agreement = sure.length === 0 ? 'no sure answers yet' : `agree on ${agreed.length} of ${sure.length} sure answers`
  const cost = spent < 0.01 ? 'under $0.01' : `≈ $${spent.toFixed(2)}`

  return [
    `Jev shadow (Haiku still drives the advice): ${rows.length} ${rows.length === 1 ? 'ask' : 'asks'} compared, ${agreement}.`,
    `  Jev unsure on ${judged.length - sure.length}, failed on ${failures.length}; median ${(median(rows.map(row => row.jev.tookMs)) / 1000).toFixed(1)}s; ${cost} in all.`,
    ...(failures.length > 0 ? [`  Last failure: ${failures.at(-1)}.`] : []),
    ...(disagreements.length > 0 ? ['  Recent disagreements (neither is ground truth):'] : []),
    ...disagreements.slice(-SHOWN_DISAGREEMENTS),
  ]
}
