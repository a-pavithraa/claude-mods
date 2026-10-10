import type { FixKind, Snag } from '../types'

export const MAX_POINTERS = 15
const MAX_FIX = 300
const START = '<!-- hindsight: navigation pointers (edit freely) -->'
const END = '<!-- end hindsight -->'
const FIX_KINDS: readonly FixKind[] = ['pointer', 'check', 'standard', 'info', 'economy']

export type RepoFacts = { hasPreCommit: boolean; hasCi: boolean; claudeMdLines: number }

export function describe(snag: Pick<Snag, 'kind' | 'area'>): string {
  if (snag.kind === 'search') return `10 or more searches in ${snag.area} before the first edit of a turn`
  if (snag.kind === 'fix-loop') return `\`${snag.area}\` failed, was fixed by an edit, and failed again`

  return `a tool output over 20,000 characters from ${snag.area}`
}

export function proposePrompt(snag: Snag, facts: RepoFacts): string {
  return [
    'Pause the task. This is a question about the environment, not about the work.',
    `This session hit a snag that also came up in ${snag.sessions.length - 1} earlier session(s): ${describe(snag)}.`,
    `Repo facts: pre-commit hook ${facts.hasPreCommit ? 'yes' : 'no'}; CI workflow ${facts.hasCi ? 'yes' : 'no'}; ./CLAUDE.md ${facts.claudeMdLines} lines.`,
    ...(snag.tried === undefined
      ? []
      : ['These fixes were saved or sent before, and the snag came back anyway. Do not propose them again:', ...snag.tried.map(text => `- ${text}`)]),
    '',
    'Propose ONE change to the coding agent\'s environment that stops this snag next time. Kinds:',
    '- pointer: one line for ./CLAUDE.md that tells the agent where to look ("Mod hook code: plugins/<mod>/hooks/register.tsx").',
    '- check: an automated check (lint rule, pre-commit hook, CI job, test) that catches the mistake. A mechanical rule always gets a check, never a written rule.',
    '- standard: a judgement call for the code reviewer, which no check can catch.',
    '- info: a way to give the agent information it lacked (a log, a read-only command).',
    '- economy: a cheaper way to get the same information (a narrower command, a quiet flag, a limit).',
    '- none: nothing in the environment would have helped.',
    'Write the change as one imperative sentence a person can act on, at most 40 words. A pointer is the exact line.',
    '',
    'Answer with JSON only: {"fix": "pointer"|"check"|"standard"|"info"|"economy"|"none", "text": "..."}',
  ].join('\n')
}

export type Fix = { kind: FixKind; text: string } | 'none'

export function parseFix(reply: string): Fix | undefined {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0]

  if (json === undefined) return undefined

  try {
    const parsed = JSON.parse(json) as Record<string, unknown>

    if (parsed.fix === 'none') return 'none'

    const kind = FIX_KINDS.find(one => one === parsed.fix)
    const text = typeof parsed.text === 'string' ? parsed.text.trim().replace(/\s+/g, ' ') : ''

    if (kind === undefined || text === '' || text.length > MAX_FIX) return undefined
    if (kind === 'pointer' && (text.includes('<!--') || text.includes('-->'))) return undefined

    return { kind, text }
  } catch {
    return undefined
  }
}

/**
 * `file` with `pointer` added inside the marked section; the file unchanged when the line is there; undefined when
 * the markers are broken or the section already holds MAX_POINTERS lines: never guess where to write.
 */
export function withPointer(file: string, pointer: string): string | undefined {
  const line = `- ${pointer.replace(/^[-*]\s+/, '')}`

  if (file.split(/\r?\n/).some(existing => existing.trim() === line)) return file

  const starts = file.split(START).length - 1
  const ends = file.split(END).length - 1

  if (starts === 0 && ends === 0) {
    const gap = file === '' || file.endsWith('\n\n') ? '' : file.endsWith('\n') ? '\n' : '\n\n'

    return `${file}${gap}${START}\n${line}\n${END}\n`
  }

  const start = file.indexOf(START)
  const end = file.indexOf(END)

  if (starts !== 1 || ends !== 1 || end < start) return undefined

  const held = file.slice(start + START.length, end).split(/\r?\n/).filter(existing => existing.startsWith('- '))

  if (held.length >= MAX_POINTERS) return undefined

  return `${file.slice(0, end)}${line}\n${file.slice(end)}`
}

export const taskText = (snag: Snag, fixText: string) =>
  `hindsight saw this snag in ${snag.sessions.length} sessions: ${describe(snag)}.\nMake this change: ${fixText}`

export function retroText(snags: Snag[]): string {
  const lines = snags.map(snag => `- ${describe(snag)} (${snag.sessions.length} sessions, ${snag.status})`)

  return ['/mattpocock-skills:retro', 'Start from these snags hindsight recorded in this repo:', ...lines].join('\n')
}
