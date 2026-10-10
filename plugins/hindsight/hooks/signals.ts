import type { Signal } from '../types'

export const SPIRAL_SEARCHES = 10
export const LOOP_FAILS = 2
export const BIG_OUTPUT_CHARS = 20_000
const AREA_DEPTH = 3
const COMMAND_WORDS = 3

type Run = { fails: number; isEditedSince: boolean }

export type TurnLog = {
  searches: number
  dirs: string[]
  hasWritten: boolean
  runs: Record<string, Run>
  bigOutputs: string[]
}

export const emptyLog = (): TurnLog => ({ searches: 0, dirs: [], hasWritten: false, runs: {}, bigOutputs: [] })

const slashed = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '')

/** The directory of `path` under `root`, cut to its first three folders; '.' for the root itself. */
export function areaOf(path: string, root: string): string {
  const full = slashed(path)
  const base = slashed(root)
  const isUnder = full.toLowerCase().startsWith(`${base.toLowerCase()}/`)
  const parts = (isUnder ? full.slice(base.length + 1) : full).split('/').filter(part => part !== '' && part !== '.')
  const isFile = /\.[A-Za-z0-9]+$/.test(parts.at(-1) ?? '')
  const folders = isFile ? parts.slice(0, -1) : parts

  return folders.slice(0, AREA_DEPTH).join('/') || '.'
}

/** The command a shell line runs, as its first words: "npm test", "claude plugin test". */
export function commandKey(command: string): string {
  const last = command.split(/&&|\|\||;|\n/).map(part => part.trim()).filter(Boolean).at(-1) ?? ''
  const words = last
    .split(/\s+/)
    .filter(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
    .filter(word => !word.startsWith('-') && !/[/\\.]/.test(word) && !/["'$`|<>]/.test(word))

  return words.slice(0, COMMAND_WORDS).join(' ')
}

export function addSearch(log: TurnLog, path: string | undefined, root: string): TurnLog {
  if (log.hasWritten) return log

  return { ...log, searches: log.searches + 1, dirs: path === undefined ? log.dirs : [...log.dirs, areaOf(path, root)] }
}

export function addWrite(log: TurnLog): TurnLog {
  const runs = Object.fromEntries(Object.entries(log.runs).map(([key, run]) => [key, { ...run, isEditedSince: true }]))

  return { ...log, hasWritten: true, runs }
}

/** A failure counts once until an edit happens; a pass clears the command. */
export function addRun(log: TurnLog, command: string, isError: boolean): TurnLog {
  const key = commandKey(command)

  if (key === '') return log
  if (!isError) return { ...log, runs: { ...log.runs, [key]: { fails: 0, isEditedSince: false } } }

  const was = log.runs[key] ?? { fails: 0, isEditedSince: false }
  const fails = was.fails === 0 || was.isEditedSince ? was.fails + 1 : was.fails

  return { ...log, runs: { ...log.runs, [key]: { fails, isEditedSince: false } } }
}

export function addOutput(log: TurnLog, area: string, chars: number): TurnLog {
  if (chars < BIG_OUTPUT_CHARS || log.bigOutputs.includes(area)) return log

  return { ...log, bigOutputs: [...log.bigOutputs, area] }
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>()

  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '.'
}

export function signalsOf(log: TurnLog): Signal[] {
  const spiral: Signal[] = log.searches >= SPIRAL_SEARCHES ? [{ kind: 'search', area: mostCommon(log.dirs) }] : []
  const loops: Signal[] = Object.entries(log.runs)
    .filter(([, run]) => run.fails >= LOOP_FAILS)
    .map(([key]) => ({ kind: 'fix-loop', area: key }))
  const big: Signal[] = log.bigOutputs.map(area => ({ kind: 'big-output', area }))

  return [...spiral, ...loops, ...big]
}
