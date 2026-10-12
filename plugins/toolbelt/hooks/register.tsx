import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Confirm, Disabled, Health, Item, Notice, Unit, Uses } from '../types'
import { argvFor, disableOf, enableOf, moveArgv, removeOf } from './actions'
import type { Step } from './actions'
import { paneOf } from './pane'
import type { Counters } from './usage'
import {
  DAY_MS,
  DEFAULT_DAYS,
  combine,
  countUse,
  daysOf,
  installedIds,
  keyOf,
  listText,
  projectServers,
  readCounters,
  serverOf,
  serverScope,
  signature,
  toastText,
  unusedUnits,
  withIds,
} from './usage'

const units = atom({ plugin: 'toolbelt', key: 'units' } as const, [])
const disabled = atom({ plugin: 'toolbelt', key: 'disabled' } as const, [])
const confirm = atom({ plugin: 'toolbelt', key: 'confirm' } as const, null)
const notice = atom({ plugin: 'toolbelt', key: 'notice' } as const, { text: '', isError: false })
const page = atom({ plugin: 'toolbelt', key: 'page' } as const, 0)
const health = atom({ plugin: 'toolbelt', key: 'health' } as const, { isCounted: true })
const total = atom({ plugin: 'toolbelt', key: 'total' } as const, 0)

const PANE = 'toolbelt'
const USES_KEY = 'uses'
const SINCE_KEY = 'since'
const MUTED_KEY = 'muted'
const DISABLED_KEY = 'disabled'
const TOAST_KEY = 'toast'
/** Kept by 0.1.0: uses noted live between transcript reads, now counted straight into `uses`. */
const LIVE_KEY = 'live'
const RETIRED_KEYS = ['scanned', 'backfilled', 'scopes']

type Toast = { at: number; sig: string }

async function stored<T>($: EngineInterface, key: string, fallback: T): Promise<T> {
  const held = await $.store.get(key)

  return held === undefined || held === null ? fallback : (held as T)
}

// The module's own: a reload asks the shell again; the store keeps everything else.
let home = ''
let isWindows = false
/** The window, as the plugin's settings had it when the module loaded. */
let days = DEFAULT_DAYS
/** Whether each tool waits behind ToolSearch, as the session placed it. */
const deferred = new Map<string, boolean>()
/** Plugins switched off or removed this session: their other skills stay loaded until it ends, so they are not listed. */
const gone = new Set<string>()

/** Store writes that read the whole value first run one after another, so parallel calls do not drop counts. */
let writes: Promise<unknown> = Promise.resolve()

function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const done = writes.then(job)
  writes = done.catch(() => undefined)

  return done
}

async function learnShell($: EngineInterface) {
  if (home !== '') return

  const win = await $.process.run(['cmd.exe', '/d', '/c', 'echo', '%USERPROFILE%']).catch(() => undefined)
  const winHome = win?.exitCode === 0 ? win.stdout.trim() : ''

  if (winHome !== '' && winHome !== '%USERPROFILE%') {
    isWindows = true
    home = winHome.split('\\').join('/')

    return
  }

  const posix = await $.process.run(['sh', '-c', 'echo "$HOME"']).catch(() => undefined)
  home = posix?.exitCode === 0 ? posix.stdout.trim() : ''
}

const run = ($: EngineInterface, argv: string[]) => $.process.run(argvFor(argv, isWindows))

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  const text = await $.fs.read(path).catch(() => undefined)

  return typeof text === 'string' ? text : undefined
}

async function inventory($: EngineInterface, counters: Counters | undefined, root: string): Promise<Item[]> {
  const items: Item[] = []

  for (const command of await $.command.list()) {
    if (command.source !== 'user' && command.source !== 'plugin') continue
    if (command.source === 'plugin' && !command.name.includes(':')) continue
    if (command.plugin !== undefined && gone.has(command.plugin)) continue

    const isUserSkill = command.source === 'user' && home !== '' && (await $.fs.exists(`${home}/.claude/skills/${command.name}`).catch(() => false))
    const scope = command.source === 'plugin' ? 'plugin' : isUserSkill ? 'user' : 'unknown'

    items.push({
      kind: 'skill',
      name: command.name,
      scope,
      ...(command.plugin === undefined ? {} : { plugin: command.plugin }),
      cost: command.name.length + command.description.length,
    })
  }

  const servers = new Map<string, number>()

  for (const tool of await $.tool.list()) {
    const server = tool.mcp ? serverOf(tool.name) : undefined

    if (server === undefined) continue

    // An MCP tool is deferred unless a hook moved it, so one not yet described costs its name only.
    const chars = deferred.get(tool.name) === false ? tool.name.length + tool.description.length : tool.name.length
    servers.set(server, (servers.get(server) ?? 0) + chars)
  }

  const listed = projectServers((await readText($, `${root}/.mcp.json`)) ?? '')

  for (const [name, cost] of servers) {
    items.push({ kind: 'mcp', name, scope: serverScope(name, root, listed, counters), cost })
  }

  return items
}

async function refresh($: EngineInterface) {
  const now = await $.clock.now()
  const root = await $.session.root()
  const text = home === '' ? undefined : await readText($, `${home}/.claude.json`)
  const counters = text === undefined ? undefined : readCounters(text)
  const items = await inventory($, counters, root)
  const view = {
    project: root,
    now,
    since: await stored($, SINCE_KEY, now),
    days,
    muted: await stored<string[]>($, MUTED_KEY, []),
  }
  const installed = installedIds((home === '' ? undefined : await readText($, `${home}/.claude/plugins/installed_plugins.json`)) ?? '')
  const unused = withIds(unusedUnits(items, counters, await stored<Uses>($, USES_KEY, {}), view), installed).filter(
    unit => disableOf(unit, home) !== undefined || removeOf(unit) !== undefined,
  )

  await update($, units, () => unused)
  await update($, health, (): Health => ({ isCounted: counters !== undefined }))
  await update($, total, () => items.reduce((sum, item) => sum + item.cost, 0))

  return unused
}

async function note($: EngineInterface, key: string) {
  const project = await $.session.root()
  const at = await $.clock.now()

  await exclusive(async () => $.store.set(USES_KEY, countUse(await stored<Uses>($, USES_KEY, {}), key, project, at)))
}

/** 0.1.0 kept a live tally beside the transcript counts and a few keys for reading them; fold the tally in once and drop the rest. */
async function tidyStore($: EngineInterface) {
  const live = await $.store.get(LIVE_KEY)

  if (live !== undefined && live !== null) {
    await exclusive(async () => {
      await $.store.set(USES_KEY, combine(await stored<Uses>($, USES_KEY, {}), live as Uses))
      await $.store.delete(LIVE_KEY)
    })
  }

  for (const key of RETIRED_KEYS) {
    if ((await $.store.get(key)) !== undefined) await $.store.delete(key)
  }
}

/** Every session: toast when the unused list changed since the last toast and a day has passed. */
async function startup($: EngineInterface) {
  await learnShell($)
  await tidyStore($)

  if ((await $.store.get(SINCE_KEY)) === undefined) await $.store.set(SINCE_KEY, await $.clock.now())

  const unused = await refresh($)
  const now = await $.clock.now()
  const last = await stored<Toast | null>($, TOAST_KEY, null)
  const sig = signature(unused)

  if (unused.length === 0 || last?.sig === sig || (last !== null && now - last.at < DAY_MS)) return

  await $.store.set(TOAST_KEY, { at: now, sig })
  $.ui.toast(toastText(unused, days), { timeoutMs: 10000 })
}

async function say($: EngineInterface, text: string, isError = false) {
  await update($, notice, (): Notice => ({ text, isError }))
}

async function execute($: EngineInterface, step: Step): Promise<string | undefined> {
  if (step.move !== undefined) {
    const parent = step.move.to.split('/').slice(0, -1).join('/')
    const made = await run($, isWindows ? ['mkdir', parent.split('/').join('\\')] : ['mkdir', '-p', parent]).catch(() => undefined)

    if (made === undefined && !(await $.fs.exists(parent).catch(() => false))) return `could not create ${parent}`

    const moved = await $.process.run(moveArgv(step.move, isWindows)).catch(() => undefined)

    return moved?.exitCode === 0 ? undefined : (moved?.stderr.trim() || 'the move failed')
  }

  if (step.argv === undefined) return 'nothing to run'

  const ran = await run($, step.argv).catch(() => undefined)

  return ran?.exitCode === 0 ? undefined : (ran?.stderr.trim() || 'the command failed')
}

async function act($: EngineInterface, unit: Unit, which: 'disable' | 'remove') {
  const step = which === 'disable' ? disableOf(unit, home) : removeOf(unit)
  await update($, confirm, () => null)

  if (step === undefined) return

  const failure = await execute($, step)

  if (failure !== undefined) {
    await say($, `${unit.name}: ${failure}`, true)

    return
  }

  const key = step.record?.key ?? keyOf(unit.kind, unit.name)
  const next = await exclusive(async () => {
    const held = await stored<Disabled[]>($, DISABLED_KEY, [])
    const kept = [...held.filter(one => one.key !== key), ...(step.record === undefined ? [] : [step.record])]
    await $.store.set(DISABLED_KEY, kept)

    return kept
  })

  if (unit.kind === 'plugin') gone.add(unit.name)

  await update($, disabled, () => next)
  await say($, which === 'disable' ? `✓ ${step.record?.name ?? unit.name} disabled. Takes effect next session.` : `✓ ${unit.name} removed.`)
  await refresh($)
}

async function enable($: EngineInterface, held: Disabled) {
  const failure = await execute($, enableOf(held))

  if (failure !== undefined) {
    await say($, `${held.name}: ${failure}`, true)

    return
  }

  if (held.how === 'plugin') gone.delete(held.name)

  const next = await exclusive(async () => {
    const kept = (await stored<Disabled[]>($, DISABLED_KEY, [])).filter(one => one.key !== held.key)
    await $.store.set(DISABLED_KEY, kept)

    return kept
  })
  await update($, disabled, () => next)
  await say($, `✓ ${held.name} enabled. Takes effect next session.`)
  await refresh($)
}

/** A record whose plugin or folder is gone can never be enabled; forgetting only drops the record. */
async function forget($: EngineInterface, held: Disabled) {
  const next = await exclusive(async () => {
    const kept = (await stored<Disabled[]>($, DISABLED_KEY, [])).filter(one => one.key !== held.key)
    await $.store.set(DISABLED_KEY, kept)

    return kept
  })

  await update($, disabled, () => next)
  await say($, `${held.name} forgotten. Nothing was changed.`)
}

async function keep($: EngineInterface, unit: Unit) {
  await exclusive(async () => $.store.set(MUTED_KEY, [...(await stored<string[]>($, MUTED_KEY, [])), keyOf(unit.kind, unit.name)]))
  await say($, `${unit.name} kept. Toolbelt will not list it again.`)
  await refresh($)
}

export const register: Register = (on, options) => {
  days = daysOf(options.unusedDays)
  deferred.clear()
  gone.clear()

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'unused', description: 'Plugins, skills and MCP servers nobody used lately; disable or remove them' })
    $.clock.after(0, () => void startup($).catch(() => undefined))

    return next(e)
  })

  on('tool.describe', async ($, e, next) => {
    const result = await next(e)
    deferred.set(e.tool, result.isDeferred ?? e.isDeferred === true)

    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const server = serverOf(e.tool)

    if (server !== undefined) await note($, keyOf('mcp', server))

    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'unused' }, async $ => {
    await learnShell($)
    const held = await stored<Disabled[]>($, DISABLED_KEY, [])
    await update($, disabled, () => held)
    const unused = await refresh($)
    await update($, confirm, () => null)
    await update($, notice, (): Notice => ({ text: '', isError: false }))
    await update($, page, () => 0)

    if (unused.length === 0) return { text: 'Nothing unused.' }

    void $.ui.open({ id: PANE, title: 'Unused' }).then(opened => {
      if (!opened.isPlaced) $.ui.toast(listText(unused, days), { timeoutMs: 20000 })
    })

    return { text: `${unused.length} unused. Opening the pane; if it does not seat, the list follows as a notice.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const view = {
      units: await read($, units),
      disabled: await read($, disabled),
      confirm: await read($, confirm),
      notice: await read($, notice),
      page: await read($, page),
      days,
      isCounted: (await read($, health)).isCounted,
      total: await read($, total),
      now: await $.clock.now(),
      since: await stored($, SINCE_KEY, 0),
      home,
    }

    return paneOf($.ui.resolve(e), view, {
      ask: (key, step) => update($, confirm, () => ({ key, step }) satisfies Confirm),
      cancel: () => update($, confirm, () => null),
      run: (unit, step) => act($, unit, step),
      keep: unit => keep($, unit),
      enable: held => enable($, held),
      turn: next => update($, page, () => next),
      forget: held => forget($, held),
    })
  })
}
