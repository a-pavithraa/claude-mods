import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { Seen, Signal, Snag } from '../types'
import { costOf, describe, listText, parseFix, proposePrompt, retroText, standing, taskText, withPointer } from './propose'
import type { RepoFacts } from './propose'
import {
  BIG_OUTPUT_CHARS,
  addAsked,
  addOutput,
  addReached,
  addRun,
  addSearch,
  addTiming,
  addWrite,
  areaOf,
  callText,
  commandKey,
  emptyLog,
  signalsOf,
  targetKey,
} from './signals'
import type { TurnLog } from './signals'

const shown = atom({ plugin: 'hindsight', key: 'shown' } as const, null)

const SNAGS_KEY = 'snags'
const MUTED_KEY = 'muted'
const RECUR_SESSIONS = 2
const MAX_SNAGS = 200
/** Forks are cached reads of the whole session: at most this many per session. */
const MAX_FORKS = 2
const SEEN_KEPT = 5
/** Sessions without the snag after its fix before the fix counts as held. */
const HELD_SESSIONS = 5
const SIZES_SHOWN = 8

async function snagsOf($: EngineInterface): Promise<Snag[]> {
  const held = await $.store.get(SNAGS_KEY)

  return Array.isArray(held) ? (held as Snag[]) : []
}

/** Keeps the newest MAX_SNAGS, dropping finished ones first. */
async function saveSnags($: EngineInterface, list: Snag[]) {
  const isOpen = (snag: Snag) => snag.status === 'watching' || snag.status === 'proposed'
  const kept = list.length <= MAX_SNAGS ? list : [...list.filter(isOpen), ...list.filter(snag => !isOpen(snag))]

  await $.store.set(SNAGS_KEY, kept.sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_SNAGS))
}

async function mutedOf($: EngineInterface): Promise<string[]> {
  const held = await $.store.get(MUTED_KEY)

  return Array.isArray(held) ? (held as string[]) : []
}

const muteKey = (snag: Pick<Snag, 'project' | 'kind' | 'area'>) => `${snag.project}\n${snag.kind}\n${snag.area}`

async function refreshShown($: EngineInterface) {
  const root = await $.session.root()
  const next = (await snagsOf($)).find(snag => snag.project === root && snag.status === 'proposed') ?? null

  await update($, shown, () => next)
}

const folderOf = (path: string) => path.split('\\').join('/').split('/').slice(0, -1).join('/')

async function sizesNear($: EngineInterface, path: string | undefined): Promise<string[]> {
  if (path === undefined) return []

  const entries = await $.fs.list(folderOf(path)).catch(() => [])

  return entries
    .filter(entry => entry.kind === 'file')
    .sort((a, b) => b.size - a.size)
    .slice(0, SIZES_SHOWN)
    .map(entry => `${entry.name} ${entry.size.toLocaleString('en-US')}`)
}

async function factsOf($: EngineInterface, root: string, path?: string): Promise<RepoFacts> {
  const has = (path: string) => $.fs.exists(`${root}/${path}`).catch(() => false)
  const claudeMd = (await has('CLAUDE.md')) ? await $.fs.read(`${root}/CLAUDE.md`).catch(() => '') : ''

  return {
    hasPreCommit: (await has('.git/hooks/pre-commit')) || (await has('.husky')) || (await has('.pre-commit-config.yaml')),
    hasCi: await has('.github/workflows'),
    claudeMdLines: typeof claudeMd === 'string' && claudeMd !== '' ? claudeMd.split('\n').length : 0,
    sizes: await sizesNear($, path),
  }
}

async function setStatus($: EngineInterface, id: string, change: (snag: Snag) => Snag) {
  const list = await snagsOf($)
  await saveSnags($, list.map(snag => (snag.id === id ? change(snag) : snag)))
  await refreshShown($)
}

/** A big read whose file has since shrunk under the limit, or gone, needs no fix. */
async function isCauseGone($: EngineInterface, snag: Snag) {
  if (snag.kind !== 'big-output' || snag.path === undefined) return false

  const stat = await $.fs.stat(snag.path).catch(() => undefined)

  return stat === undefined || stat.size < BIG_OUTPUT_CHARS
}

async function judge($: EngineInterface, snag: Snag) {
  if (await isCauseGone($, snag)) {
    await setStatus($, snag.id, held => ({ ...held, status: 'watching', sessions: [] }))

    return
  }

  const reply = await $.model.fork({ prompt: proposePrompt(snag, await factsOf($, snag.project, snag.path)) })
  const fix = reply.isAnswered ? parseFix(reply.text) : undefined

  if (fix === undefined) {
    await setStatus($, snag.id, held => ({ ...held, status: 'watching' }))

    return
  }

  await setStatus($, snag.id, held =>
    fix === 'none' ? { ...held, status: 'quiet' } : { ...held, status: 'proposed', fix },
  )
}

/** Counts this session against each signal; returns the snags that just came back. */
async function record($: EngineInterface, signals: Signal[]): Promise<Snag[]> {
  const root = await $.session.root()
  const sessionId = await $.session.id()
  const now = await $.clock.now()
  const muted = await mutedOf($)
  const list = await snagsOf($)
  const recurred: Snag[] = []

  for (const { call, cost, ...signal } of signals) {
    if (muted.includes(muteKey({ ...signal, project: root }))) continue

    const same = list.find(snag => snag.project === root && snag.kind === signal.kind && snag.area === signal.area)
    const seen: Seen = { session: sessionId, call, cost }

    if (same === undefined) {
      list.push({ ...signal, seen: [seen], id: `s${now.toString(36)}${list.length}`, project: root, sessions: [sessionId], status: 'watching', lastAt: now })
      continue
    }

    same.lastAt = now
    const before = same.seen?.find(one => one.session === sessionId)?.cost ?? 0
    same.seen = [...(same.seen ?? []).filter(one => one.session !== sessionId), { ...seen, cost: before + cost }].slice(-SEEN_KEPT)

    if (signal.path !== undefined) same.path = signal.path

    if (!same.sessions.includes(sessionId)) same.sessions.push(sessionId)

    const isFixed = same.status === 'sent' || same.status === 'done' || same.status === 'held'

    if (isFixed && same.fixedIn !== sessionId) {
      same.tried = [...(same.tried ?? []), ...(same.fix === undefined ? [] : [same.fix.text])]
      same.fix = undefined
      same.fixedIn = undefined
      same.clean = undefined
      same.status = 'judging'
      recurred.push(same)
    } else if (same.status === 'watching' && same.sessions.length >= RECUR_SESSIONS) {
      same.status = 'judging'
      recurred.push(same)
    }
  }

  await saveSnags($, list)

  return recurred
}

const fixed = (snag: Snag): Snag => {
  const cost = costOf(snag)

  return { ...snag, clean: [], ...(cost === undefined ? {} : { costBefore: cost }) }
}

/** Counts this session for every fix in the repo still waiting to prove itself; enough clean sessions make it held. */
async function countClean($: EngineInterface) {
  const root = await $.session.root()
  const sessionId = await $.session.id()
  const list = await snagsOf($)
  const isWaiting = (snag: Snag) =>
    snag.project === root &&
    (snag.status === 'done' || snag.status === 'sent') &&
    snag.fixedIn !== sessionId &&
    !(snag.clean ?? []).includes(sessionId)

  if (!list.some(isWaiting)) return

  await saveSnags(
    $,
    list.map(snag => {
      if (!isWaiting(snag)) return snag

      const clean = [...(snag.clean ?? []), sessionId]

      return { ...snag, clean, ...(clean.length >= HELD_SESSIONS ? { status: 'held' as const } : {}) }
    }),
  )
}

async function save($: EngineInterface, snag: Snag) {
  if (snag.fix === undefined) return

  const path = `${snag.project}/CLAUDE.md`
  const before = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  const after = withPointer(typeof before === 'string' ? before : '', snag.fix.text)

  if (after === undefined) {
    $.ui.toast(`hindsight: the hindsight section in ${path} is full or its markers are broken; nothing written`)

    return
  }

  if (after !== before) await $.fs.write(path, after)

  const fixedIn = await $.session.id()
  await setStatus($, snag.id, held => ({ ...fixed(held), status: 'done', fixedIn }))
  $.ui.toast(after === before ? `hindsight: already in ${path}` : `hindsight: added to ${path}`)
}

async function sendToPrompt($: EngineInterface, snag: Snag) {
  if (snag.fix === undefined) return

  const box = await $.prompt.read()

  if (box.text.trim() !== '') {
    $.ui.toast('hindsight: clear the prompt box first; the task goes there')

    return
  }

  const filled = await $.prompt.fill({ text: taskText(snag, snag.fix.text), mode: 'replace' })

  if (!filled.isFilled) return

  const fixedIn = await $.session.id()
  await setStatus($, snag.id, held => ({ ...fixed(held), status: 'sent', fixedIn }))
}

/** Not now: the snag starts counting sessions again, and is proposed afresh if it keeps coming back. */
async function skip($: EngineInterface, snag: Snag) {
  await setStatus($, snag.id, held => ({ ...held, status: 'watching', sessions: [], fix: undefined }))
}

async function mute($: EngineInterface, snag: Snag) {
  const muted = await mutedOf($)
  await $.store.set(MUTED_KEY, [...muted, muteKey(snag)])
  await setStatus($, snag.id, held => ({ ...held, status: 'skipped' }))
}

// The module's own: a reload starts a fresh turn log; the store keeps the snags.
let log: TurnLog = emptyLog()
let forks = 0

/** A shell call is named by its command words, the grain a permission rule takes ("Bash(npm test:*)"); any other tool by its name. */
function askedCall(tool: string, input: unknown) {
  const command = typeof input === 'object' && input !== null && 'command' in input ? String(input.command) : undefined

  if (command === undefined) return { area: tool, call: callText(`${tool} ${JSON.stringify(input)}`) }

  return { area: `${tool} ${commandKey(command) || targetKey(command)}`, call: callText(`${tool}: ${command}`) }
}

async function noteSearch($: EngineInterface, agentId: string | undefined, path: string | undefined) {
  if (agentId === undefined) log = addSearch(log, path, await $.session.root())
}

function noteOutput(agentId: string | undefined, output: { area: string; call: string; path?: string }, text: string | undefined) {
  if (agentId === undefined && text !== undefined) log = addOutput(log, output, text.length)
}

function noteWrite(agentId: string | undefined, path: string, ran: ToolCallResult) {
  if (agentId === undefined && ran.deny === undefined && ran.isError !== true) log = addWrite(log, path)
}

function noteRun(agentId: string | undefined, shell: string, command: string, ran: ToolCallResult, ms: number) {
  if (agentId !== undefined || ran.deny !== undefined) return

  log = addRun(log, command, ran.isError === true)
  log = addTiming(log, { area: `${shell} ${targetKey(command)}`, call: callText(`${shell}: ${command}`) }, ms)
  noteOutput(agentId, { area: `${shell} ${targetKey(command)}`, call: callText(`${shell}: ${command}`) }, ran.text)
}

export const register: Register = on => {
  log = emptyLog()
  forks = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hindsight', description: 'Snags hindsight saw in this repo; hands them to the retro skill' })
    await countClean($)
    const list = await snagsOf($)
    // Snags from 0.2.0 have no calls and an area of another shape: they would never match a new one.
    const current = list.filter(snag => snag.seen !== undefined)

    if (current.length !== list.length || current.some(snag => snag.status === 'judging')) {
      await saveSnags($, current.map(snag => (snag.status === 'judging' ? { ...snag, status: 'watching' } : snag)))
    }

    await refreshShown($)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    log = emptyLog()

    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const decided = await next(e)

    if (decided.decision === 'ask' && e.agentId === undefined && e.tool_use_id !== undefined) {
      log = addAsked(log, e.tool_use_id, askedCall(e.tool, e.input))
    }

    return decided
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    log = addReached(log, e.tool_use_id)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    await noteSearch($, e.agentId, e.file_path)
    noteOutput(
      e.agentId,
      { area: `Read ${areaOf(e.file_path, await $.session.root())}`, call: `Read ${e.file_path}`, path: e.file_path },
      ran.text,
    )

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Grep' }, async ($, e, next) => {
    const ran = await next(e)
    await noteSearch($, e.agentId, e.path)
    const where = e.path === undefined ? '.' : areaOf(e.path, await $.session.root())
    noteOutput(e.agentId, { area: `Grep ${where}`, call: `Grep "${e.pattern}" in ${where}` }, ran.text)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Glob' }, async ($, e, next) => {
    const ran = await next(e)
    await noteSearch($, e.agentId, e.path)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    noteWrite(e.agentId, e.file_path, ran)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    noteWrite(e.agentId, e.file_path, ran)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    noteWrite(e.agentId, e.notebook_path, ran)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const startedAt = await $.clock.now()
    const ran = await next(e)
    noteRun(e.agentId, 'Bash', e.command, ran, (await $.clock.now()) - startedAt)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const startedAt = await $.clock.now()
    const ran = await next(e)
    noteRun(e.agentId, 'PowerShell', e.command, ran, (await $.clock.now()) - startedAt)

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId !== undefined) return done

    const signals = signalsOf(log)
    log = emptyLog()

    if (signals.length === 0) return done

    const recurred = await record($, signals)

    for (const snag of recurred) {
      if (forks >= MAX_FORKS) {
        await setStatus($, snag.id, held => ({ ...held, status: 'watching' }))
        continue
      }

      forks += 1
      $.clock.after(0, () => void judge($, snag).catch(() => setStatus($, snag.id, held => ({ ...held, status: 'watching' }))))
    }

    return done
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'hindsight' }, async $ => {
    const root = await $.session.root()
    const here = (await snagsOf($)).filter(snag => snag.project === root)

    if (here.length === 0) return { text: 'hindsight has seen no snags in this repo yet.' }

    const lines = [listText(here, HELD_SESSIONS)]
    const box = await $.prompt.read()
    const filled = box.text.trim() === '' ? await $.prompt.fill({ text: retroText(here), mode: 'replace' }) : undefined
    const handoff = filled?.isFilled === true
      ? 'The retro skill with these snags is in your prompt box. Press Enter to run it.'
      : 'Clear the prompt box and run /hindsight again to hand these to the retro skill.'

    return { text: [...lines, '', handoff].join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const snag = await read($, shown)

    if (e.props.hasSurvey || e.props.isWorking || snag === null || snag.fix === undefined) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const isPointer = snag.fix.kind === 'pointer'

    return (
      <Box flexDirection="column">
        {below.type === 'engine' ? null : below}
        <Box>
          <Text color="warning">⚑ </Text>
          <Text wrap="wrap">
            {`hindsight · ${snag.tried === undefined ? standing(snag) : 'back after a fix'}: ${describe(snag)}`}
          </Text>
        </Box>
        <Text wrap="wrap">{`  ${isPointer ? `Add to ./CLAUDE.md: "${snag.fix.text}"` : snag.fix.text}`}</Text>
        <Box gap={1}>
          <Text>{'  '}</Text>
          <Button
            key="act"
            variant="primary"
            label={isPointer ? 'Save' : 'Put task in prompt'}
            onPress={() => (isPointer ? save($, snag) : sendToPrompt($, snag))}
          />
          <Button key="mute" label="Not in this repo" onPress={() => mute($, snag)} />
          <Button
            key="skip"
            label="Skip"
            onPress={() => skip($, snag)}
          />
        </Box>
      </Box>
    )
  })
}
