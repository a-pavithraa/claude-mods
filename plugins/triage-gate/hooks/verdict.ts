import type { Blast, Jev, Verdict } from '../types'
import { SENSITIVE_PATH } from './blast'

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

/** How likely, in a word: the pane leads with it and gives the number after. */
export const likelihood = (value: number) => (value >= LIKELY ? 'likely' : value >= UNLIKELY ? 'possible' : 'unlikely')

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

  if (jev.status === 'judged') {
    const value = (key: string) => jev.judgments.find(one => one.key === key)?.value

    for (const one of jev.judgments.filter(judgment => SENSITIVE.includes(judgment.key))) {
      if (one.value >= LIKELY) add('risk', 2, `Jev: likely touches ${one.label} (${percent(one.value)})`)
      else if (one.value >= UNSURE) add('risk', 1, `Jev: may touch ${one.label} (${percent(one.value)})`)
    }

    if ((value('behaviour') ?? 0) >= LIKELY && (value('tested') ?? 1) < UNLIKELY) {
      add('quality', 1, 'Jev: changes behaviour without tests for it')
    }

    if (jev.hardToRead >= HARD) add('quality', 2, `Jev: hard to follow (${percent(jev.hardToRead)})`)
    else if (jev.hardToRead >= EFFORTFUL) add('quality', 1, `Jev: parts take effort to follow (${percent(jev.hardToRead)})`)

    if ((value('mixed') ?? 0) >= LIKELY) add('quality', 1, 'Jev: mixes unrelated changes; splitting it would help')
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
