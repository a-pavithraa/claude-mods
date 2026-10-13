import type { Blast, Jev, Judgment, Place } from '../types'
import { tagHunks } from './hunks'
import type { Hunk } from './hunks'

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

/** What each signal measures, in the words the pane shows under it. */
export const MEANS: Record<string, string> = {
  behaviour: 'Whether a user or caller would notice a difference: inputs, outputs, errors, side effects.',
  security: 'Code that decides who may do what, handles credentials, or validates untrusted input.',
  data: 'How data is stored or migrated, its schema, or deleting it.',
  money: 'Charging, refunds, prices or sums of money.',
  concurrency: 'Ordering, locks, retries, caches or timeouts.',
  publicApi: 'Something other code or people depend on: an exported signature, endpoint, CLI flag or file format.',
  tested: 'Whether test files in the diff exercise the behaviour it changes.',
  untested: 'A user or caller would notice a difference, and no test in the diff exercises it.',
  mixed: 'Several unrelated changes that would be easier to review apart.',
  readability: 'How much effort a reviewer needs to follow the diff.',
}

/** The signals worth a "where": each gets a choice among the diff's hunks, asked in the same request. */
const WHERE_KEYS = ['behaviour', 'security', 'data', 'money', 'concurrency', 'publicApi'] as const
const NO_HUNK = 'none'
/** Weight spreads over hunks on a wide diff: on a 45-hunk one, a clear public-interface hunk drew 0.44 for its file. */
const WHERE_SURE = 0.4

/**
 * No "no single hunk" option: given one, Jev took it on a wide diff even for signals it rated likely. A nudge
 * towards code over docs spread the answers further, so it was left out.
 */
const whereQuestion = (premise: string, hunks: Hunk[]) => ({
  type: 'choice',
  instructions: `Suppose this holds for the diff: ${premise} Each hunk in \`diff\` starts with a tag such as H01|. Which hunk shows it most clearly?`,
  criteria: { ...Object.fromEntries(hunks.map(hunk => [hunk.id, null])), [NO_HUNK]: 'Nothing in the diff does this.' },
})

/**
 * The questions for this change: the fixed ones, plus a "which hunk" for each signal and for readability. They ride
 * in the same request: only input is billed, and the options are tags, so a "where" adds little. Options keep diff
 * order, since Jev leans toward the first option. A one-hunk change needs none.
 */
export function questionsOf(hunks: Hunk[]) {
  if (hunks.length < 2) {
    return QUESTIONS
  }

  const wheres = WHERE_KEYS.map(key => [`${key}At`, whereQuestion(QUESTIONS[key].criteria.true, hunks)])

  return {
    ...QUESTIONS,
    ...Object.fromEntries(wheres),
    hardestAt: whereQuestion('Some of it is hard for a reviewer to read and understand.', hunks),
  }
}

/** The request, and the hunks its tags stand for, to read the answers back with. */
export function askOf(blast: Blast, patch: string) {
  const { tagged, hunks } = tagHunks(patch)
  const body = JSON.stringify({
    model: 'jev-latest',
    state: {
      changed_files: blast.files.map(file => file.path),
      diff: tagged,
    },
    questions: questionsOf(hunks),
  })

  return { body, hunks }
}

type RawAnswer = { type?: string; noul?: number; choice?: string; probabilities?: Record<string, number> }

/**
 * Where a "which hunk" answer points: the file that holds at least `WHERE_SURE` across its hunks and more than "none"
 * does, and the line of its top hunk when that hunk holds more than half the file's weight. With one hunk there was
 * no question to ask.
 */
function placeOf(answer: RawAnswer | undefined, hunks: Hunk[]): Place | undefined {
  const [only] = hunks

  if (hunks.length === 1 && only !== undefined) {
    return { path: only.path, line: only.line }
  }

  const shares = answer?.probabilities ?? {}
  const byFile = new Map<string, { weight: number; top?: Hunk; topShare: number }>()

  for (const hunk of hunks) {
    const share = shares[hunk.id] ?? 0
    const file = byFile.get(hunk.path) ?? { weight: 0, topShare: 0 }
    byFile.set(hunk.path, {
      weight: file.weight + share,
      ...(share > file.topShare ? { top: hunk, topShare: share } : { top: file.top, topShare: file.topShare }),
    })
  }

  const [path, best] = [...byFile].sort(([, a], [, b]) => b.weight - a.weight)[0] ?? []

  if (path === undefined || best === undefined || best.weight < WHERE_SURE || best.weight <= (shares[NO_HUNK] ?? 0)) {
    return undefined
  }

  return best.top !== undefined && best.topShare > best.weight / 2 ? { path, line: best.top.line } : { path }
}

/** A place as a reviewer types it: `path:line`, or the path alone. */
export const placeText = (at: Place) => (at.line === undefined ? at.path : `${at.path}:${at.line}`)

const tokensOf = (value: unknown) => {
  const usage = typeof value === 'object' && value !== null && 'usage' in value ? value.usage : undefined
  const input = typeof usage === 'object' && usage !== null && 'input_tokens' in usage ? usage.input_tokens : undefined

  return typeof input === 'number' ? input : undefined
}

const asAnswers = (value: unknown): Record<string, RawAnswer> | undefined =>
  typeof value === 'object' && value !== null && 'answers' in value
    ? (value.answers as Record<string, RawAnswer>)
    : undefined

export function parseJev(status: number, text: string, hunks: Hunk[] = []): Exclude<Jev, { status: 'off' }> {
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
  let tokens: number | undefined

  try {
    const parsed: unknown = JSON.parse(text)
    answers = asAnswers(parsed)
    tokens = tokensOf(parsed)
  } catch {
    answers = undefined
  }

  if (answers === undefined) {
    return { status: 'failed', note: 'Jev sent an answer triage could not read.' }
  }

  const judgments: Judgment[] = Object.keys(LABELS).flatMap(key => {
    const value = answers?.[key]?.noul
    const at = placeOf(answers?.[`${key}At`], hunks)

    return typeof value === 'number' ? [{ key, label: LABELS[key] ?? key, value, ...(at === undefined ? {} : { at }) }] : []
  })
  const levels = Object.entries(answers.readability?.probabilities ?? {}).sort(
    ([a], [b]) => Number(a) - Number(b),
  )
  const hardToRead = levels.slice(-2).reduce((sum, [, share]) => sum + share, 0)
  const hardestAt = placeOf(answers.hardestAt, hunks)

  return {
    status: 'judged',
    judgments,
    hardToRead,
    ...(hardestAt === undefined ? {} : { hardestAt }),
    ...(tokens === undefined ? {} : { tokens }),
  }
}
