import type { Blast, Jev, Judgment } from '../types'

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const PATCH_CHARS = 60_000

const yesNo = (instructions: string, yes: string, no: string) => ({
  type: 'noul',
  instructions,
  criteria: { true: yes, false: no },
})

export const QUESTIONS = {
  behaviour: yesNo(
    'Does this diff change behaviour that a user or a caller of this code can observe?',
    'Inputs, outputs, errors, side effects or what a person sees differ after this diff.',
    'Only refactoring, renaming, formatting, comments or documentation.',
  ),
  security: yesNo(
    'Does this diff change authentication, authorization, secrets, input validation or other security-relevant code?',
    'Code that decides who may do what, handles credentials, or validates untrusted input changed.',
    'No security-relevant code changed.',
  ),
  data: yesNo(
    'Does this diff change how data is stored, migrated, deleted or what its schema is?',
    'Persistence, schemas, migrations or deletion of stored data changed.',
    'Stored data and its shape are untouched.',
  ),
  money: yesNo(
    'Does this diff change payments, billing, prices or monetary calculations?',
    'Code that charges, refunds, prices or sums money changed.',
    'No code that handles money changed.',
  ),
  concurrency: yesNo(
    'Does this diff change concurrency, locking, retries, caching or timing?',
    'Threads, async ordering, locks, retries, caches or timeouts changed.',
    'Nothing about ordering, timing or caching changed.',
  ),
  publicApi: yesNo(
    'Does this diff change an interface other code depends on: an exported signature, an HTTP endpoint, a CLI flag or a file format?',
    'Something other code or other people call or read changed shape.',
    'Only internal code changed.',
  ),
  tested: yesNo(
    'Does this diff add or change tests that exercise the behaviour it changes?',
    'Test files in the diff cover the changed behaviour.',
    'The diff has no tests for what it changes.',
  ),
  mixed: yesNo(
    'Does this diff mix unrelated changes that would be easier to review separately?',
    'It holds several unrelated changes.',
    'It is one coherent change.',
  ),
  readability: {
    type: 'score',
    instructions: 'How hard is this diff for a reviewer to read and understand?',
    criteria: [
      'Clear: small steps, good names, intent obvious from the code.',
      'Mostly clear: a few spots need a second look.',
      'Effortful: dense logic or unclear names; the intent needs explaining.',
      'Hard: tangled control flow, several concerns interleaved, intent unclear.',
    ],
  },
} as const

export const LABELS: Record<string, string> = {
  behaviour: 'changes behaviour',
  security: 'security',
  data: 'stored data',
  money: 'money',
  concurrency: 'concurrency',
  publicApi: 'public interface',
  tested: 'has tests',
  mixed: 'mixes changes',
}

export function requestBody(blast: Blast, patch: string) {
  return JSON.stringify({
    model: 'jev-latest',
    state: {
      changed_files: blast.files.map(file => file.path),
      diff: patch,
    },
    questions: QUESTIONS,
  })
}

type RawAnswer = { type?: string; noul?: number; probabilities?: Record<string, number> }

const asAnswers = (value: unknown): Record<string, RawAnswer> | undefined =>
  typeof value === 'object' && value !== null && 'answers' in value
    ? (value.answers as Record<string, RawAnswer>)
    : undefined

export function parseJev(status: number, text: string): Jev {
  if (status === 401) {
    return { status: 'failed', note: 'Jev refused the API key (401).' }
  }

  if (status === 429 || status === 529) {
    return { status: 'failed', note: `Jev is busy (${status}); triage used blast radius only.` }
  }

  if (status < 200 || status >= 300) {
    return { status: 'failed', note: `Jev answered ${status}.` }
  }

  let answers: Record<string, RawAnswer> | undefined

  try {
    answers = asAnswers(JSON.parse(text))
  } catch {
    answers = undefined
  }

  if (answers === undefined) {
    return { status: 'failed', note: 'Jev sent an answer triage could not read.' }
  }

  const judgments: Judgment[] = Object.keys(LABELS).flatMap(key => {
    const value = answers?.[key]?.noul

    return typeof value === 'number' ? [{ key, label: LABELS[key] ?? key, value }] : []
  })
  const levels = Object.entries(answers.readability?.probabilities ?? {}).sort(
    ([a], [b]) => Number(a) - Number(b),
  )
  const hardToRead = levels.slice(-2).reduce((sum, [, share]) => sum + share, 0)

  return { status: 'judged', judgments, hardToRead }
}
