import type { Finding, Triage } from '../types'
import { SENSITIVE_PATH } from './blast'
import { flagsOf } from './verdict'

const FILES_REVIEWED = 15
const FINDINGS_ASKED = 5
const ASKS_KEPT = 3
const ASK_CHARS = 600
export const BRIEF_CHARS = 900
export const GUIDE_CHARS = 8000

export const BRIEF_PROMPT = `A reviewer who has not seen this conversation will check the uncommitted changes against what was wanted. In at most six short lines, with no preamble, say: the requirement those changes implement, the behaviour that should now hold, and what was deliberately left out of scope.`

export const addAsk = (asks: string[], text: string) => [...asks, text.slice(0, ASK_CHARS)].slice(-ASKS_KEPT)

/** `guide` is the repository's REVIEW.md as committed, so a change cannot edit the checks it is reviewed against. */
export type Intent = { asks: string[]; brief?: string; guide?: string }

export function reviewScope(judged: Triage | null, focus: string) {
  const blast = judged?.blast
  const pointed = judged === null ? [] : flagsOf(judged.blast, judged.jev).map(flag => flag.at?.path)
  const isFlagged = (path: string) =>
    SENSITIVE_PATH.test(path) ||
    (blast?.risky.includes(path) ?? false) ||
    blast?.widest?.path === path ||
    pointed.includes(path)
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
    intent.guide === undefined
      ? ''
      : `The repository's review guide (REVIEW.md, as committed). Follow it. Where it is more specific than the rules below, it wins:\n${intent.guide}`,
    judged !== null && judged.reasons.length > 0 ? `An earlier triage flagged: ${judged.reasons.join('; ')}.` : '',
    focus === '' ? '' : `Focus on: ${focus}`,
    [
      'Report a finding only when you can trace it. Start at a supported entry point: a user action, a route the app calls, a job, an event, or data the schema allows. Follow it through the changed lines to a wrong result someone would see.',
      'Then look for the strongest reason it cannot happen: an earlier guard, a type, a database constraint, server-side validation, or a caller that never sends that value. Drop the finding if one holds.',
      'Leave out style, naming, formatting and anything a linter or type checker would catch.',
    ].join(' '),
    `Report at most ${FINDINGS_ASKED} findings, one per cause, the most serious first. Write one or two sentences of summary, then a line "Review comments:", then each finding in exactly this shape:`,
    '- [P1] <short title> -- <file>:<line>\n  <the entry point, what happens, and the wrong result>',
    'Use P1 only when the wrong result reaches a normal user doing normal work, or breaks a rule the repository writes down; use P0 if it loses data or breaks security. A rare setup, such as an unusual time zone, a tiny screen or years-old data, is P2 at most, as is a real nit not worth a fix round. Use P3 for a bug the code had before this change. Zero findings is a valid result: if nothing survives, say so and list none.',
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

export const isImportant = (one: Finding) => one.priority === 'P0' || one.priority === 'P1'

const listOf = (findings: Finding[]) =>
  findings.map(one => `- [${one.priority}] ${one.title} (${one.at})\n  ${one.body}`).join('\n')

/**
 * Replays showed Codex tagging most findings P1 whatever the prompt said, so the tag cannot decide
 * what gets fixed: Claude applies the consequence test to every finding itself.
 */
export function fixPrompt(findings: Finding[]): string {
  return [
    'Codex reviewed the uncommitted change. Its P tags are a hint and often overstate; P3 means Codex thinks the code had it before this change. Judge each finding yourself:',
    [
      '1. Trace it in the code from a supported entry point to the wrong result, or name the guard that stops it.',
      '2. Fix it only if the trace holds and the wrong result reaches a normal user doing normal work, loses data, breaks security, or breaks a rule the repository writes down. If REVIEW.md exists, its severity rules decide.',
      '3. Otherwise change no code. Answer it in one line: wrong, intentional, rare, or there before this change, with the reason. Record a follow-up worth keeping where the repository keeps known gaps.',
    ].join('\n'),
    'Fix the whole class of bug, but nothing beyond it without asking me. Rejecting a finding is a valid outcome.',
    `Findings:\n${listOf(findings)}`,
    'Finish with a table: finding, verdict (fixed, wrong, intentional, rare, pre-existing), how often times how bad (each 1 to 10), and the guard or the fix.',
  ].join('\n\n')
}
