import type { Blast, Flag, Jev, Place, Verdict } from '../types'
import { SENSITIVE_PATH, groupsOf } from './blast'
import { placeText } from './jev'

const MANY_LINES = 400
const SOME_LINES = 150
const MANY_FILES = 10
const SOME_FILES = 5
const MANY_AREAS = 4
const WIDE_USE = 10
const SOME_USE = 4
const LIKELY = 0.7
const UNSURE = 0.4
const UNLIKELY = 0.3
const HARD = 0.5
const EFFORTFUL = 0.25
const HOLD_AT = 5
const READ_AT = 2

const SENSITIVE = ['security', 'data', 'money', 'concurrency', 'publicApi']

/** Each kind of signal counts up to a cap, so a hold needs more than one kind to agree. */
const CAPS = { size: 3, reach: 2, risk: 2, quality: 2 }

export const percent = (value: number) => `${Math.round(value * 100)}%`

/** How likely, in a word: `/gate details` leads with it and gives the number after. */
export const likelihood = (value: number) => (value >= LIKELY ? 'likely' : value >= UNLIKELY ? 'possible' : 'unlikely')

/**
 * The Jev signals that fired, each with the file to look at. A change in behaviour alone is not one: nearly every diff
 * has it. It fires only when no tests in the diff cover it.
 */
export function flagsOf(blast: Blast, jev: Jev): Flag[] {
  if (jev.status !== 'judged') {
    return []
  }

  const find = (key: string) => jev.judgments.find(one => one.key === key)
  const where = (at: Place | undefined) => (at === undefined ? {} : { at })
  const flags: Flag[] = jev.judgments
    .filter(one => SENSITIVE.includes(one.key) && one.value >= UNSURE)
    .map(one => ({
      key: one.key,
      label: one.label,
      said: one.value >= LIKELY ? `likely touches ${one.label}` : `may touch ${one.label}`,
      isLikely: one.value >= LIKELY,
      ...where(one.at),
    }))
  const behaviour = find('behaviour')

  if ((behaviour?.value ?? 0) >= LIKELY && (find('tested')?.value ?? 1) < UNLIKELY) {
    flags.push({
      key: 'untested',
      label: 'untested behaviour change',
      said: 'changes behaviour without tests for it',
      isLikely: true,
      ...where(behaviour?.at),
    })
  }

  if (jev.hardToRead >= EFFORTFUL) {
    const isHard = jev.hardToRead >= HARD
    flags.push({
      key: 'readability',
      label: 'hard to follow',
      said: isHard ? 'hard to follow' : 'parts take effort to follow',
      isLikely: isHard,
      ...where(jev.hardestAt),
    })
  }

  if ((find('mixed')?.value ?? 0) >= LIKELY) {
    const groups = groupsOf(blast.files)
    flags.push({
      key: 'mixed',
      label: 'mixes changes',
      said: 'mixes unrelated changes',
      isLikely: true,
      ...(groups.length > 1 ? { groups } : {}),
    })
  }

  return flags
}

export const groupsLine = (groups: { name: string; files: number }[]) =>
  groups.map(({ name, files }) => `${name} (${files} ${files === 1 ? 'file' : 'files'})`).join(' · ')

/** A fired signal as one line of the Why list: what and where, never a percentage. */
export function reasonOf(flag: Flag) {
  if (flag.key === 'mixed') {
    return `Jev: ${flag.said}${flag.groups === undefined ? '' : `: ${groupsLine(flag.groups)}`}; splitting it would help`
  }

  return `Jev: ${flag.said}${flag.at === undefined ? '' : `, mostly in ${placeText(flag.at)}`}`
}

/** The risk topics Jev checked and found nothing in, for one quiet line. */
export const clearOf = (jev: Jev) =>
  jev.status === 'judged' ? jev.judgments.filter(one => SENSITIVE.includes(one.key) && one.value < UNSURE).map(one => one.label) : []

/** What Jev said about tests, when it is not already a flag. */
export function testsNoteOf(jev: Jev) {
  if (jev.status !== 'judged') return undefined

  const value = (key: string) => jev.judgments.find(one => one.key === key)?.value
  const tested = value('tested') ?? 0
  const behaviour = value('behaviour') ?? 0

  if (tested >= LIKELY) return 'Tests in the diff exercise the change.'
  if (behaviour >= LIKELY && tested >= UNLIKELY) return 'Unclear whether the tests in the diff cover the change.'

  return undefined
}

export function verdictOf(blast: Blast, jev: Jev) {
  const reasons: string[] = []
  const tally = { size: 0, reach: 0, risk: 0, quality: 0 }
  const add = (kind: keyof typeof CAPS, weight: number, reason: string) => {
    tally[kind] = Math.min(CAPS[kind], tally[kind] + weight)
    reasons.push(reason)
  }

  if (blast.lines >= MANY_LINES) add('size', 2, `${blast.lines} lines changed`)
  else if (blast.lines >= SOME_LINES) add('size', 1, `${blast.lines} lines changed`)

  if (blast.files.length >= MANY_FILES) add('size', 2, `${blast.files.length} files changed`)
  else if (blast.files.length >= SOME_FILES) add('size', 1, `${blast.files.length} files changed`)

  if (blast.areas.length >= MANY_AREAS) add('size', 1, `spans ${blast.areas.length} areas: ${blast.areas.join(', ')}`)

  const used = blast.widest?.usedBy ?? 0

  if (blast.widest !== undefined && used >= WIDE_USE) add('reach', 2, `${blast.widest.path} is used by ${used} other files`)
  else if (blast.widest !== undefined && used >= SOME_USE) add('reach', 1, `${blast.widest.path} is used by ${used} other files`)

  if (blast.risky.length > 0) add('reach', 1, `touches build, config or schema: ${blast.risky.join(', ')}`)

  for (const flag of flagsOf(blast, jev)) {
    const isRisk = SENSITIVE.includes(flag.key)
    const weight = (isRisk || flag.key === 'readability') && flag.isLikely ? 2 : 1

    add(isRisk ? 'risk' : 'quality', weight, reasonOf(flag))
  }

  // Consequence is judged apart from size: a small change to sensitive code is never a pass.
  const sensitive = blast.files.filter(file => SENSITIVE_PATH.test(file.path)).map(file => file.path)
  const security = jev.status === 'judged' ? jev.judgments.find(one => one.key === 'security')?.value ?? 0 : 0

  if (sensitive.length > 0) reasons.push(`changes sensitive code: ${sensitive.join(', ')}`)
  if (security >= LIKELY) reasons.push('held for review because Jev judges it likely to touch security')

  const points = tally.size + tally.reach + tally.risk + tally.quality
  const bySize: Verdict = points >= HOLD_AT ? 'hold' : points >= READ_AT ? 'read' : 'pass'
  const verdict: Verdict = security >= LIKELY ? 'hold' : sensitive.length > 0 && bySize === 'pass' ? 'read' : bySize

  return { verdict, points, reasons }
}
