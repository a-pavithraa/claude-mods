import type { Review, Subject, Triage, Verdict } from '../types'
import { startWith } from './blast'
import { PATCH_CHARS } from './jev'
import { likelihood, percent } from './verdict'

/** One string per judged change, so a Codex review can tell whether a later triage is of the same change. */
export const subjectKey = (subject: Subject | undefined) =>
  subject === undefined ? undefined : [subject.scope, subject.cwd ?? '', ...(subject.paths ?? [])].join('\n')

const SHOWN_REASONS = 3

/** A pass only means no trigger fired, not that the change is safe, so it is not drawn in green. */
export const BADGE: Record<Verdict, { mark: string; word: string; means: string; tone: 'suggestion' | 'warning' | 'error' }> = {
  pass: {
    mark: '○',
    word: 'No review trigger',
    means: 'Nothing here called for a review. This is not a safety check.',
    tone: 'suggestion',
  },
  read: {
    mark: '◐',
    word: 'Review recommended',
    means: "Claude's commits go through; read the files below before you build on this.",
    tone: 'warning',
  },
  hold: {
    mark: '■',
    word: 'Hold: review before commit',
    means: "Claude's commit is blocked until you approve this exact change.",
    tone: 'error',
  },
}

/** What this verdict rests on, so a pass from local checks alone is not read as a full one. */
export function coverageOf(judged: Triage) {
  const { jev } = judged

  if (jev.status === 'off') {
    return 'Assessed with local checks only: size, spread and file paths. Add a TypeSafe key for Jev.'
  }
  if (jev.status === 'failed') return `Assessed with local checks only: Jev gave no judgement. ${jev.note}`
  if (judged.isPatchCut) return `Assessed on part of the diff: Jev read only the first ${PATCH_CHARS / 1000}k characters.`

  return 'Assessed on the whole diff: local checks and Jev.'
}

export function reviewHeadline(done: Extract<Review, { status: 'done' }>) {
  if (done.findings.length > 0) return `Codex found ${done.findings.length} ${done.findings.length === 1 ? 'problem' : 'problems'}`
  if (done.isTimedOut === true) return 'Codex review timed out; it listed no findings'
  if (!done.isClean) return 'Codex review failed; it listed no findings'

  return 'Codex review finished with no findings listed'
}

/** The `/gate` reply: the verdict, the change, the top reasons, and where the rest is. */
export function summaryOf(judged: Triage) {
  const { reasons } = judged
  const more = reasons.length - SHOWN_REASONS

  return [
    `${BADGE[judged.verdict].word}. ${changeLine(judged)}.`,
    ...reasons.slice(0, SHOWN_REASONS).map(reason => `- ${reason}`),
    ...(more > 0 ? [`- and ${more} more`] : []),
    'The Triage pane lists the files to read first; /gate details prints everything.',
  ].join('\n')
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

export function changeLine(judged: Triage) {
  const { files, areas } = judged.blast
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)

  const named = areas.map(area => (area === '.' ? 'root' : area)).join(', ')

  return `${plural(files.length, 'file')} · +${added} −${removed} lines · ${plural(areas.length, 'area')}: ${named}`
}

const agoOf = (at: number | undefined) => {
  if (at === undefined) return undefined

  const minutes = Math.floor((Date.now() - at) / 60_000)

  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`
}

/** Who judged, how fast, on what and when: never the key. */
export function diagnosticsOf(judged: Triage) {
  const { jev } = judged
  const took = jev.status !== 'off' && jev.tookMs !== undefined ? ` in ${(jev.tookMs / 1000).toFixed(1)}s` : ''
  const provider =
    jev.status === 'judged'
      ? `Jev (TypeSafe) answered${took}`
      : jev.status === 'failed'
        ? `Jev (TypeSafe) failed${took}; fell back to local checks`
        : 'Jev off; local checks only'
  const ago = agoOf(judged.assessedAt)

  return [provider, ago === undefined ? undefined : `assessed ${ago}`, judged.isEdited === true ? 'stale' : undefined]
    .filter(Boolean)
    .join(' · ')
}

/** The pane's detail, as text: for `/gate details` where the pane cannot be shown. */
export function detailsText(judged: Triage) {
  const { jev } = judged
  const signals =
    jev.status === 'judged'
      ? [
          ...jev.judgments.map(one => `${one.label}: ${likelihood(one.value)} (${percent(one.value)})`),
          `hard to follow: ${likelihood(jev.hardToRead)} (${percent(jev.hardToRead)})`,
        ]
      : []
  const files = startWith(judged.blast).map(({ file, why }) => `${file.path} (+${file.added} −${file.removed}): ${why}`)

  return [
    `${BADGE[judged.verdict].word}. ${changeLine(judged)}.`,
    coverageOf(judged),
    ...(judged.reasons.length > 0 ? ['', 'Why:', ...judged.reasons.map(reason => `- ${reason}`)] : []),
    '',
    'Start with:',
    ...files.map(line => `- ${line}`),
    ...(signals.length > 0 ? ['', "Jev's signals:", ...signals.map(line => `- ${line}`)] : []),
    '',
    diagnosticsOf(judged),
  ].join('\n')
}
