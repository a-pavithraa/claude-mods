import type { Signal } from '../types'

export const SPIRAL_SEARCHES = 10
export const LOOP_FAILS = 2
export const BIG_OUTPUT_CHARS = 20_000
const CALL_CHARS = 200
const TARGET_SEGMENTS = 3
const COMMAND_WORDS = 3
const SHOWN_PATHS = 3
export const SLOW_MS = 60_000
/** Failures in a row with no edit between: the same command tried again unchanged. */
export const BLIND_FAILS = 3
const CHARS_PER_TOKEN = 4

/** `blind`: failures since the last edit or pass, so a red-green-red test cycle never counts. */
type Run = { fails: number; blind: number; isEditedSince: boolean; command: string }

type Call = { area: string; call: string }

type BigOutput = Call & { path?: string; chars: number }

type Slow = Call & { ms: number }

export type TurnLog = {
  searches: number
  paths: string[]
  hasWritten: boolean
  written: string[]
  runs: Record<string, Run>
  bigOutputs: BigOutput[]
  slow: Slow[]
  /** Calls put to the permission dialog that have not run yet; any left at the turn's end were declined. */
  asked: Record<string, Call>
}

export const emptyLog = (): TurnLog => ({
  searches: 0,
  paths: [],
  hasWritten: false,
  written: [],
  runs: {},
  bigOutputs: [],
  slow: [],
  asked: {},
})

const slashed = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '')

const samePath = (a: string, b: string) => slashed(a).toLowerCase() === slashed(b).toLowerCase()

/** Hashes, UUIDs and version folders change between installs; a snag must not. */
const isVolatile = (part: string) => /^[0-9a-f]{16,}$/i.test(part) || /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(part)

/** `path` relative to `root` when under it, with volatile folders as `*`; '.' for the root itself. */
export function areaOf(path: string, root: string): string {
  const full = slashed(path)
  const base = slashed(root)
  const isUnder = full.toLowerCase().startsWith(`${base.toLowerCase()}/`)
  const parts = (isUnder ? full.slice(base.length + 1) : full).split('/').filter(part => part !== '' && part !== '.')

  return parts.map(part => (isVolatile(part) ? '*' : part)).join('/') || '.'
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

const baseName = (word: string) => slashed(word.replace(/^["']|["']$/g, '')).split('/').at(-1) ?? word

/** Each step of a shell line as its program and first target: "cat HANDOFF.md, ls plugins". */
export function targetKey(command: string): string {
  const steps = command
    .split(/&&|\|\||;|\||\n/)
    .map(step => step.trim().split(/\s+/).filter(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)))
    .filter(words => words.length > 0 && !['cd', 'echo', 'printf'].includes(words[0] ?? ''))
    .map(([program = '', ...args]) => {
      const target = args.find(word => !word.startsWith('-') && !/^[|<>&$`(]/.test(word))

      return [baseName(program), ...(target === undefined ? [] : [baseName(target)])].join(' ')
    })

  return steps.slice(0, TARGET_SEGMENTS).join(', ')
}

export const callText = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > CALL_CHARS ? `${flat.slice(0, CALL_CHARS - 1)}…` : flat
}

export function addSearch(log: TurnLog, path: string | undefined, root: string): TurnLog {
  if (log.hasWritten) return log

  return { ...log, searches: log.searches + 1, paths: path === undefined ? log.paths : [...log.paths, areaOf(path, root)] }
}

/** An edit also clears a big read of the same file: reading a file whole to change it is the work, not waste. */
export function addWrite(log: TurnLog, path?: string): TurnLog {
  const runs = Object.fromEntries(Object.entries(log.runs).map(([key, run]) => [key, { ...run, blind: 0, isEditedSince: true }]))
  const bigOutputs = path === undefined ? log.bigOutputs : log.bigOutputs.filter(big => big.path === undefined || !samePath(big.path, path))

  return { ...log, hasWritten: true, written: path === undefined ? log.written : [...log.written, path], runs, bigOutputs }
}

/** A failure counts once for a fix loop until an edit happens, and once more for `blind` each time; a pass clears the command. */
export function addRun(log: TurnLog, command: string, isError: boolean): TurnLog {
  const key = commandKey(command)

  if (key === '') return log
  if (!isError) return { ...log, runs: { ...log.runs, [key]: { fails: 0, blind: 0, isEditedSince: false, command } } }

  const was = log.runs[key] ?? { fails: 0, blind: 0, isEditedSince: false, command }
  const fails = was.fails === 0 || was.isEditedSince ? was.fails + 1 : was.fails
  const blind = was.command === command ? was.blind + 1 : 1

  return { ...log, runs: { ...log.runs, [key]: { fails, blind, isEditedSince: false, command } } }
}

export function addOutput(log: TurnLog, output: Omit<BigOutput, 'chars'>, chars: number): TurnLog {
  if (chars < BIG_OUTPUT_CHARS || log.bigOutputs.some(big => big.area === output.area)) return log
  if (output.path !== undefined && log.written.some(path => samePath(path, output.path ?? ''))) return log

  return {
    ...log,
    bigOutputs: [...log.bigOutputs, { ...output, chars, call: callText(`${output.call} → ${chars.toLocaleString('en-US')} chars`) }],
  }
}

export function addTiming(log: TurnLog, call: Call, ms: number): TurnLog {
  if (ms < SLOW_MS || log.slow.some(one => one.area === call.area)) return log

  return { ...log, slow: [...log.slow, { ...call, ms }] }
}

export const addAsked = (log: TurnLog, id: string, call: Call): TurnLog => ({ ...log, asked: { ...log.asked, [id]: call } })

export function addReached(log: TurnLog, id: string | undefined): TurnLog {
  if (id === undefined || !(id in log.asked)) return log

  return { ...log, asked: Object.fromEntries(Object.entries(log.asked).filter(([held]) => held !== id)) }
}

/** The one path searched twice or more, else the deepest folder every search shares. */
export function focusOf(paths: string[]): string {
  const counts = new Map<string, number>()

  for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1)

  const [top, times] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['.', 0]

  if (times >= 2) return top

  const folders = paths.map(path => path.split('/').slice(0, /\.[A-Za-z0-9]+$/.test(path) ? -1 : undefined))
  const shared: string[] = []

  for (const [at, part] of (folders[0] ?? []).entries()) {
    if (!folders.every(folder => folder[at] === part)) break
    shared.push(part)
  }

  return shared.join('/') || '.'
}

export function signalsOf(log: TurnLog): Signal[] {
  const spiral: Signal[] =
    log.searches >= SPIRAL_SEARCHES
      ? [
          {
            kind: 'search',
            area: focusOf(log.paths),
            call: callText(`${log.searches} searches before an edit, last: ${log.paths.slice(-SHOWN_PATHS).join(', ')}`),
            cost: log.searches,
          },
        ]
      : []
  const loops: Signal[] = Object.entries(log.runs)
    .filter(([, run]) => run.fails >= LOOP_FAILS)
    .map(([key, run]) => ({ kind: 'fix-loop', area: key, call: callText(run.command), cost: run.fails }))
  const retries: Signal[] = Object.entries(log.runs)
    .filter(([, run]) => run.blind >= BLIND_FAILS && run.fails < LOOP_FAILS)
    .map(([key, run]) => ({ kind: 'retry', area: key, call: callText(run.command), cost: run.blind }))
  const big: Signal[] = log.bigOutputs.map(({ area, call, path, chars }) => ({
    kind: 'big-output',
    area,
    call,
    cost: Math.round(chars / CHARS_PER_TOKEN),
    ...(path === undefined ? {} : { path }),
  }))
  const slow: Signal[] = log.slow.map(({ area, call, ms }) => ({
    kind: 'slow',
    area,
    call: callText(`${call} → ${Math.round(ms / 1000)}s`),
    cost: Math.round(ms / 1000),
  }))
  const declines = new Map<string, Signal>()

  for (const { area, call } of Object.values(log.asked)) {
    const was = declines.get(area)
    declines.set(area, { kind: 'denied', area, call: was?.call ?? call, cost: (was?.cost ?? 0) + 1 })
  }

  return [...spiral, ...loops, ...retries, ...big, ...slow, ...declines.values()]
}
