import type { Blast, Jev, Verdict } from '../types'

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

export function verdictOf(blast: Blast, jev: Jev) {
  const reasons: string[] = []
  let points = 0
  const add = (weight: number, reason: string) => {
    points += weight
    reasons.push(reason)
  }

  if (blast.lines >= MANY_LINES) add(2, `${blast.lines} lines changed`)
  else if (blast.lines >= SOME_LINES) add(1, `${blast.lines} lines changed`)

  if (blast.files.length >= MANY_FILES) add(2, `${blast.files.length} files changed`)
  else if (blast.files.length >= SOME_FILES) add(1, `${blast.files.length} files changed`)

  if (blast.areas.length >= MANY_AREAS) add(1, `spans ${blast.areas.length} areas: ${blast.areas.join(', ')}`)

  const used = blast.widest?.usedBy ?? 0

  if (blast.widest !== undefined && used >= WIDE_USE) add(2, `${blast.widest.path} is named by ${used} other files`)
  else if (blast.widest !== undefined && used >= SOME_USE) add(1, `${blast.widest.path} is named by ${used} other files`)

  if (blast.risky.length > 0) add(1, `touches build, config or schema: ${blast.risky.join(', ')}`)

  if (jev.status === 'judged') {
    const value = (key: string) => jev.judgments.find(one => one.key === key)?.value

    for (const one of jev.judgments.filter(judgment => SENSITIVE.includes(judgment.key))) {
      if (one.value >= LIKELY) add(2, `Jev: likely touches ${one.label} (${one.value.toFixed(2)})`)
      else if (one.value >= UNSURE) add(1, `Jev is unsure whether it touches ${one.label} (${one.value.toFixed(2)})`)
    }

    if ((value('behaviour') ?? 0) >= LIKELY && (value('tested') ?? 1) < UNLIKELY) {
      add(1, 'Jev: changes behaviour without tests for it')
    }

    if (jev.hardToRead >= HARD) add(2, `Jev: hard to read (${jev.hardToRead.toFixed(2)})`)
    else if (jev.hardToRead >= EFFORTFUL) add(1, `Jev: takes effort to read (${jev.hardToRead.toFixed(2)})`)

    if ((value('mixed') ?? 0) >= LIKELY) add(1, 'Jev: mixes unrelated changes; splitting it would help')
  }

  const verdict: Verdict = points >= HOLD_AT ? 'hold' : points >= READ_AT ? 'read' : 'pass'

  return { verdict, points, reasons }
}
