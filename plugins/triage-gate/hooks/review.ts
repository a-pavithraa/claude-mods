import type { Finding, Triage } from '../types'
import { SENSITIVE_PATH } from './blast'

const FILES_REVIEWED = 15
const FINDINGS_ASKED = 5
const ASKS_KEPT = 3
const ASK_CHARS = 600
export const BRIEF_CHARS = 900

export const BRIEF_PROMPT = `A reviewer who has not seen this conversation will check the uncommitted changes against what was wanted. In at most six short lines, with no preamble, say: the requirement those changes implement, the behaviour that should now hold, and what was deliberately left out of scope.`

export const addAsk = (asks: string[], text: string) => [...asks, text.slice(0, ASK_CHARS)].slice(-ASKS_KEPT)

export type Intent = { asks: string[]; brief?: string }

export function reviewScope(judged: Triage | null, focus: string) {
  const blast = judged?.blast
  const isFlagged = (path: string) =>
    SENSITIVE_PATH.test(path) || (blast?.risky.includes(path) ?? false) || blast?.widest?.path === path
  const bySize = [...(blast?.files ?? [])].sort((a, b) => b.added + b.removed - (a.added + a.removed))
  const flagged = bySize.filter(file => isFlagged(file.path))
  const files = [...flagged, ...bySize.filter(file => !isFlagged(file.path))]
    .slice(0, FILES_REVIEWED)
    .map(file => file.path)
  const changed = blast?.files.length ?? 0
  const covers =
    files.length === 0
      ? 'every uncommitted change'
      : files.length === changed
        ? `the ${changed} changed ${changed === 1 ? 'file' : 'files'}`
        : flagged.length === 0
          ? `the ${files.length} largest of ${changed} changed files`
          : `${files.length} of ${changed} changed files, flagged ones first, then the largest`

  return { files, label: focus === '' ? covers : `${covers}, focus: ${focus}` }
}

export function reviewPrompt(judged: Triage | null, focus: string, intent: Intent = { asks: [] }): string {
  const { files } = reviewScope(judged, focus)

  return [
    'Review the uncommitted changes in this repository. Do not change any files.',
    files.length > 0 ? `Review only these files, and read others only when one of these calls them:\n${files.join('\n')}` : '',
    intent.asks.length > 0
      ? `What the user asked for, in their own words, oldest first:\n${intent.asks.map(ask => `> ${ask.replaceAll('\n', ' ')}`).join('\n')}`
      : '',
    intent.brief === undefined
      ? ''
      : `The implementer's own summary of what was built. Check the code against it; it may be wrong:\n${intent.brief}`,
    intent.asks.length > 0 || intent.brief !== undefined
      ? 'Report where the code does not do what was asked, as well as plain bugs.'
      : '',
    judged !== null && judged.reasons.length > 0 ? `An earlier triage flagged: ${judged.reasons.join('; ')}.` : '',
    focus === '' ? '' : `Focus on: ${focus}`,
    `Report at most ${FINDINGS_ASKED} findings, the most serious first. Write one or two sentences of summary, then a line "Review comments:", then each finding in exactly this shape:`,
    '- [P1] <short title> -- <file>:<line>\n  <one or two sentences on what goes wrong and when>',
    'Use P1 for a bug that will bite and P2 for the rest. If nothing is wrong, say so and list no findings.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

const FINDING = /^- \[(P\d)\] (.+?) (?:—|--) (\S+?:\d+(?:-\d+)?)\s*$/
const COMMENTS_HEADING = /^(full )?review comments?:\s*$/i

export function parseReview(text: string): { summary: string; findings: Finding[] } {
  const findings: Finding[] = []
  const summary: string[] = []

  for (const line of text.split(/\r?\n/)) {
    const found = FINDING.exec(line)
    const last = findings[findings.length - 1]

    if (found !== null) {
      findings.push({ priority: found[1] ?? '', title: found[2] ?? '', at: found[3] ?? '', body: '' })
    } else if (last !== undefined) {
      last.body = `${last.body} ${line.trim()}`.trim()
    } else if (!COMMENTS_HEADING.test(line.trim())) {
      summary.push(line)
    }
  }

  return { summary: summary.join('\n').trim(), findings }
}

export const lastLine = (text: string) =>
  text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .pop()

export const tookOf = (ms: number) => {
  const seconds = Math.round(ms / 1000)

  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function fixPrompt(findings: Finding[]): string {
  const listed = findings
    .map(one => `- [${one.priority}] ${one.title} (${one.at})\n  ${one.body}`)
    .join('\n')

  return `Codex reviewed the uncommitted change and reported the findings below. Check each one against the code. Fix the ones that are real, and tell me which you rejected and why.\n\n${listed}`
}
