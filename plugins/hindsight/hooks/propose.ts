import type { FixKind, Snag } from '../types'

export const MAX_POINTERS = 15
const MAX_FIX = 300
const START = '<!-- hindsight: navigation pointers (edit freely) -->'
const END = '<!-- end hindsight -->'
const FIX_KINDS: readonly FixKind[] = ['pointer', 'check', 'standard', 'info', 'economy', 'setting']
const UNIT: Record<Snag['kind'], [string, string]> = {
  search: ['search', 'searches'],
  'fix-loop': ['failure', 'failures'],
  retry: ['failure', 'failures'],
  'big-output': ['token', 'tokens'],
  slow: ['second', 'seconds'],
  denied: ['decline', 'declines'],
}

const thousands = (count: number) => (count >= 10_000 ? `${Math.round(count / 1000)}k` : count.toLocaleString('en-US'))

export const costText = (kind: Snag['kind'], cost: number) => {
  const rounded = Math.round(cost)
  const [one, many] = UNIT[kind]

  return `${kind === 'big-output' ? '~' : ''}${thousands(rounded)} ${rounded === 1 ? one : many}`
}

/** The average cost per session the snag was seen in. */
export function costOf(snag: Pick<Snag, 'seen'>): number | undefined {
  const costs = (snag.seen ?? []).flatMap(one => (one.cost === undefined ? [] : [one.cost]))

  return costs.length === 0 ? undefined : costs.reduce((sum, cost) => sum + cost, 0) / costs.length
}

/** `sizes`: the big file's folder as it is now, largest first, so a proposed check fits the repo today. */
export type RepoFacts = { hasPreCommit: boolean; hasCi: boolean; claudeMdLines: number; sizes: string[] }

export function describe(snag: Pick<Snag, 'kind' | 'area'>): string {
  if (snag.kind === 'search') return `10 or more searches in ${snag.area} before the first edit of a turn`
  if (snag.kind === 'fix-loop') return `\`${snag.area}\` failed, was fixed by an edit, and failed again`
  if (snag.kind === 'retry') return `\`${snag.area}\` failed 3 or more times in a row with no edit between`
  if (snag.kind === 'slow') return `a call that took over a minute: ${snag.area}`
  if (snag.kind === 'denied') return `a call refused at the permission prompt (by you or auto mode): ${snag.area}`

  return `a tool output over 20,000 characters from ${snag.area}`
}

/** What the snag usually means, so the proposal starts from the likely cause. */
const HINT: Partial<Record<Snag['kind'], string>> = {
  retry: 'The agent ran the same failing command again without changing anything it could see: often a tool quirk (quoting, paths, the shell) it does not know about.',
  slow: 'A slow call blocks the turn: often a command that waits (a watcher, a prompt, a network fetch) or does more than needed.',
  denied: 'This call was refused at the permission prompt in more than one session. Either the agent should stop asking for it, or the user should allow it in settings; say which, and the exact rule.',
}

export function proposePrompt(snag: Snag, facts: RepoFacts): string {
  return [
    'Pause the task. This is a question about the environment, not about the work.',
    `This session hit a snag that also came up in ${snag.sessions.length - 1} earlier session(s): ${describe(snag)}.`,
    ...(HINT[snag.kind] === undefined ? [] : [HINT[snag.kind] ?? '']),
    `Repo facts: pre-commit hook ${facts.hasPreCommit ? 'yes' : 'no'}; CI workflow ${facts.hasCi ? 'yes' : 'no'}; ./CLAUDE.md ${facts.claudeMdLines} lines.`,
    ...(snag.seen === undefined ? [] : ['Calls that showed it:', ...snag.seen.map(one => `- ${one.call}`)]),
    ...(facts.sizes.length === 0
      ? []
      : [
          'Files in that folder now (bytes):',
          ...facts.sizes.map(line => `- ${line}`),
          'A proposed check must pass on these files as they are, or the change must name what to split first.',
        ]),
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
    '- setting: a Claude Code settings change, such as a permission rule in .claude/settings.json ("Bash(npm test:*)").',
    '- none: nothing in the environment would have helped.',
    'Write the change as one imperative sentence a person can act on, at most 40 words. A pointer is the exact line.',
    '',
    'Answer with JSON only: {"fix": "pointer"|"check"|"standard"|"info"|"economy"|"setting"|"none", "text": "..."}',
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

const times = (count: number) => (count === 1 ? 'once' : `in ${count} sessions`)

/** How the snag stands, in words: what it costs, and whether a fix held. */
export function standing(snag: Snag, heldAfter = 5): string {
  const cost = costOf(snag)
  const perSession = cost === undefined ? '' : `, ${costText(snag.kind, cost)} a session`
  const clean = snag.clean?.length ?? 0

  if (snag.status === 'held') {
    return `quiet for ${clean} sessions since the fix${snag.costBefore === undefined ? '' : `; was ${costText(snag.kind, snag.costBefore)} a session`}`
  }
  if (snag.status === 'done' || snag.status === 'sent') {
    return `fix ${snag.status === 'done' ? 'saved' : 'sent'}; ${clean} of ${heldAfter} clean sessions`
  }

  const latest = snag.seen?.at(-1)?.cost

  if (snag.tried !== undefined && snag.costBefore !== undefined && latest !== undefined) {
    return `back after a fix: ${costText(snag.kind, latest)} last session, was ${costText(snag.kind, snag.costBefore)}`
  }

  return `seen ${times(snag.sessions.length)}${perSession}`
}

const GROUPS: readonly { title: string; statuses: readonly Snag['status'][] }[] = [
  { title: 'Fix proposed: it is in the row above the prompt', statuses: ['proposed', 'judging'] },
  { title: 'Waiting for a 2nd session before proposing a fix', statuses: ['watching'] },
  { title: 'Fix in progress: held after 5 sessions without the snag', statuses: ['sent', 'done'] },
  { title: 'Fixes that held', statuses: ['held'] },
  { title: 'No environment fix found; watching for a change', statuses: ['quiet'] },
]

/** The `/hindsight` list: snags grouped by what happens next, muted ones only counted. */
export function listText(snags: Snag[], heldAfter = 5): string {
  const groups = GROUPS.flatMap(({ title, statuses }) => {
    const here = snags.filter(snag => statuses.includes(snag.status))

    if (here.length === 0) return []

    const lines = here.map(snag => `  · ${describe(snag)} — ${standing(snag, heldAfter)}`)

    return [[`${title} (${here.length}):`, ...lines].join('\n')]
  })
  const muted = snags.filter(snag => snag.status === 'skipped').length

  return [...groups, ...(muted === 0 ? [] : [`Muted in this repo: ${muted}.`])].join('\n\n')
}

export function retroText(snags: Snag[]): string {
  const lines = snags.flatMap(snag => [
    `- ${describe(snag)} (${standing(snag)})`,
    ...(snag.seen ?? []).map(one => `  - session ${one.session}: ${one.call}`),
  ])

  return ['/mattpocock-skills:retro', 'Start from these snags hindsight recorded in this repo:', ...lines].join('\n')
}
