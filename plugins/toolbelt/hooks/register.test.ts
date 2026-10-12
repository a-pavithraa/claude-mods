import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Item } from '../types'
import {
  DAY_MS,
  agoText,
  barText,
  countUse,
  dayText,
  daysOf,
  installedIds,
  normalPath,
  projectServers,
  readCounters,
  serverScope,
  signature,
  skillUse,
  skillsText,
  tierOf,
  unusedUnits,
  withIds,
} from './usage'

const NOW = 200 * DAY_MS
const PANE_PROPS = {
  title: 'Unused',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

type World = {
  stored?: Record<string, unknown>
  /** What `~/.claude.json` holds; unreadable text means the counters are missing. */
  config?: string
  mcpJson?: string
  /** What the CLI's install record holds; by default superpowers from one marketplace. */
  installed?: string
  hasSynced?: boolean
  failRun?: string
  isPlaced?: boolean
  extraSkills?: number
  hasGrill?: boolean
}

const slashed = (path: string) => path.split('\\').join('/')

const ok = (stdout: string, exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

type ConfigParts = {
  skills?: Record<string, number>
  user?: string[]
  local?: Record<string, string[]>
}

/** A `~/.claude.json` as Claude Code writes it: counters keyed by skill, servers by scope. */
const configOf = ({ skills = {}, user = ['exa', 'chrome'], local = {} }: ConfigParts = {}) =>
  JSON.stringify({
    skillUsage: Object.fromEntries(Object.entries(skills).map(([name, at]) => [name, { usageCount: 2, lastUsedAt: at }])),
    mcpServers: Object.fromEntries(user.map(name => [name, {}])),
    projects: Object.fromEntries(Object.entries(local).map(([path, names]) => [path, { mcpServers: Object.fromEntries(names.map(name => [name, {}])) }])),
  })

function world(on: On, w: World = {}) {
  const held = new Map<string, unknown>(Object.entries({ since: NOW - 90 * DAY_MS, ...w.stored }))
  const seen = { w, toasts: [] as string[], ran: [] as string[], held }

  on('store.get', ($, e) => ({ value: held.get(e.key) }))
  on('store.set', ($, e) => {
    held.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    held.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...held.keys()] }))
  const clock = mock.clock(on, { now: NOW })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 's1' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({
    value: [
      { name: 'plugin-authoring', description: 'Make a mod.', source: 'user' },
      { name: 'superpowers:writing-plans', description: 'Plan multi-step work before touching code.', source: 'plugin', plugin: 'superpowers' },
      { name: 'superpowers:brainstorming', description: 'Explore intent before building.', source: 'plugin', plugin: 'superpowers' },
      { name: 'unused', description: 'A mod command.', source: 'plugin', plugin: 'toolbelt' },
      ...(w.hasSynced === true ? [{ name: 'anthropic-skills:docx', description: 'Word documents.', source: 'plugin' as const, plugin: 'anthropic-skills' }] : []),
      ...(w.hasGrill === true ? [{ name: 'build-compass:grill-page', description: 'Grill through a page.', source: 'plugin' as const, plugin: 'build-compass' }] : []),
      ...Array.from({ length: w.extraSkills ?? 0 }, (_, at) => ({ name: `extra-${at}`, description: 'Another skill.', source: 'user' as const })),
      { name: 'compact', description: 'Compact the conversation.', source: 'builtin' },
    ],
  }))
  on('tool.list', () => ({
    value: [
      { name: 'Read', description: 'Reads files.', mcp: false },
      { name: 'mcp__exa__web_search_exa', description: 'Search the web with Exa.', mcp: true },
      { name: 'mcp__chrome__navigate', description: 'Navigate a tab.', mcp: true },
      { name: 'mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__batch', description: 'A claude.ai connector.', mcp: true },
    ],
  }))
  on('tool.describe', ($, e) => ({ description: e.description }))
  on('fs.exists', ($, e) => ({ value: slashed(e.path).includes('/.claude/skills/') || slashed(e.path).endsWith('/.claude/skills-disabled') }))
  on('fs.read', ($, e) => {
    const path = slashed(e.path)

    if (path.endsWith('/.claude.json')) return { value: w.config ?? configOf() }
    if (path.endsWith('/.mcp.json')) return { value: w.mcpJson ?? '' }
    if (path.endsWith('/plugins/installed_plugins.json')) return { value: w.installed ?? JSON.stringify({ plugins: { 'superpowers@official': [{}] } }) }

    return { value: '' }
  })
  on('process.run', ($, e) => {
    const line = e.argv.join(' ')
    seen.ran.push(line)

    if (line.includes('%USERPROFILE%')) return ok('C:\\Users\\T\r\n')
    if (w.failRun !== undefined && line.includes(w.failRun)) return ok('', 1, 'boom')

    return ok('')
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.open', () => ({ value: w.isPlaced === false ? { isPlaced: false, reason: 'narrow' } : { isPlaced: true } }))
  on('tool.call', () => ({ result: 'ok' }))
  on('command.run', () => ({ text: '' }))

  return { seen, clock }
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

const pane = ($: Engine) =>
  $.ui.mount({ plugin: 'toolbelt', surface: 'terminal', component: 'Pane', requestId: 'toolbelt', props: PANE_PROPS })

const winPath = (...parts: string[]) => parts.join(String.fromCharCode(92))

const moveLine = (from: string, to: string) =>
  `cmd.exe /d /c move /Y ${winPath('C:', 'Users', 'T', '.claude', from, 'plugin-authoring')} ${winPath('C:', 'Users', 'T', '.claude', to, 'plugin-authoring')}`

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

const WIN = { project: '/work', now: NOW, since: NOW - 90 * DAY_MS, days: 30, muted: [] }

const skill = (name: string, plugin: string | undefined, cost: number, scope: Item['scope'] = plugin === undefined ? 'user' : 'plugin'): Item => ({
  kind: 'skill',
  name,
  scope,
  ...(plugin === undefined ? {} : { plugin }),
  cost,
})

const server = (name: string, scope: Item['scope'], cost: number): Item => ({ kind: 'mcp', name, scope, cost })

const counters = (skills: Record<string, number>) => readCounters(configOf({ skills }))

test('a config that is not JSON, or has no skill counters, reads as nothing, and one bad entry does not spoil the rest', () => {
  expect(readCounters('{"skillUsage": broken')).toBeUndefined()
  expect(readCounters('{"projects": {}}')).toBeUndefined()
  expect(readCounters('{"skillUsage": []}')).toBeUndefined()

  const read = readCounters(
    JSON.stringify({
      skillUsage: { good: { usageCount: 3, lastUsedAt: 5 }, bad: { usageCount: 'many', lastUsedAt: 5 }, worse: null },
      mcpServers: { exa: {} },
      projects: { 'D:/Work': { mcpServers: { db: {} } }, 'd:\\work\\': { mcpServers: { cache: {} } }, empty: {} },
    }),
  )

  expect(read?.skills).toEqual({ good: { count: 3, lastAt: 5 } })
  expect(read?.userServers).toEqual(['exa'])
  expect(read?.localServers).toEqual({ 'd:/work': ['db', 'cache'] })
})

test('a skill counted under its bare name is found for its plugin name, but not when two loaded skills share that bare name', () => {
  const read = readCounters(JSON.stringify({ skillUsage: { drawio: { usageCount: 1, lastUsedAt: 7 } } }))

  if (read === undefined) throw new Error('config should read')

  expect(skillUse(read, 'drawio:drawio', ['drawio:drawio', 'other:thing'])).toEqual({ count: 1, lastAt: 7 })
  expect(skillUse(read, 'drawio:drawio', ['drawio:drawio', 'drawio'])).toBeUndefined()
  expect(skillUse(read, 'nothing:here', ['nothing:here'])).toBeUndefined()
})

test('a plugin with one skill used inside the window is not listed; with none used it is one unit carrying all its skills', () => {
  const items = [skill('p:big', 'p', 300), skill('p:small', 'p', 100)]
  const used = counters({ 'p:small': NOW - DAY_MS })
  const unused = counters({})

  expect(unusedUnits(items, used, {}, WIN)).toEqual([])

  const [unit, ...rest] = unusedUnits(items, unused, {}, WIN)

  expect(rest).toEqual([])
  expect(unit).toEqual({ kind: 'plugin', name: 'p', scope: 'plugin', cost: 400, skills: ['p:big', 'p:small'], uses: 0 })
})

test('a plugin whose latest use is older than the window is listed with that date', () => {
  const items = [skill('p:one', 'p', 100), skill('p:two', 'p', 50)]
  const lastAt = NOW - 41 * DAY_MS
  const read = counters({ 'p:one': NOW - 60 * DAY_MS, 'p:two': lastAt })

  expect(unusedUnits(items, read, {}, WIN).map(unit => [unit.name, unit.lastAt, unit.uses])).toEqual([['p', lastAt, 4]])
})

test('a mod\'s own command is not listed', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await clock.settle()
  const shown = await pane($)

  expect(await shown.find({ key: 'disable:plugin:toolbelt' })).toBeUndefined()
  expect(await shown.find({ key: 'disable:plugin:superpowers' })).toBeDefined()
})

test('a plugin takes the id its one install has, a synced plugin its synced id, and one installed twice or not at all takes none', () => {
  const installed = installedIds(JSON.stringify({ plugins: { 'p@market': [{}], 'twice@old': [{}], 'twice@new': [{}] } }))
  const unit = (name: string) => ({ kind: 'plugin' as const, name, scope: 'plugin' as const, cost: 1, skills: [], uses: 0 })
  const ids = withIds([unit('p'), unit('anthropic-skills'), unit('twice'), unit('stray')], installed).map(one => one.id)

  expect(ids).toEqual(['p@market', 'anthropic-skills@synced', undefined, undefined])
  expect(installedIds('not json')).toEqual({})
})

test('a synced plugin is disabled and enabled by its synced id, and offers no Uninstall', async ($, on) => {
  const { seen, clock } = world(on, { hasSynced: true })
  await start($)
  await clock.settle()
  const shown = await pane($)

  expect(await shown.find({ key: 'remove:plugin:anthropic-skills' })).toBeUndefined()

  await shown.press({ key: 'disable:plugin:anthropic-skills' })
  await shown.press({ key: 'yes:plugin:anthropic-skills' })
  await shown.press({ key: 'enable:plugin:anthropic-skills' })

  expect(seen.ran.filter(line => line.includes('anthropic-skills'))).toEqual([
    'cmd.exe /d /c claude plugin disable anthropic-skills@synced',
    'cmd.exe /d /c claude plugin enable anthropic-skills@synced',
  ])
})

test('a server\'s scope is read from the app, the plugin, .mcp.json, the project\'s entry in the config, then the user entries', () => {
  const read = readCounters(configOf({ user: ['both', 'mine'], local: { '/work': ['both', 'here'] } }))

  expect(projectServers('{"mcpServers": {"repo": {}}}')).toEqual(['repo'])
  expect(projectServers('not json')).toEqual([])
  expect(projectServers('{"mcpServers": []}')).toEqual([])

  const scopeOf = (name: string, listed: string[] = []) => serverScope(name, '/work/', listed, read)

  expect(scopeOf('claude_ai_Gmail')).toBe('builtin')
  expect(scopeOf('1a59c906-04da-521d-bda7-7f71b9f9e01c')).toBe('builtin')
  expect(scopeOf('plugin_x_y')).toBe('plugin')
  expect(scopeOf('both', ['both'])).toBe('project')
  expect(scopeOf('both')).toBe('local')
  expect(scopeOf('here')).toBe('local')
  expect(scopeOf('mine')).toBe('user')
  expect(scopeOf('stranger')).toBe('unknown')
  expect(serverScope('mine', '/work', [], undefined)).toBe('unknown')
})

test('no command is run to list the unused, beyond learning where home is', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await clock.settle()
  await $.command.run({ command: 'unused', args: '', ...RUN })

  expect(seen.ran.filter(line => !line.includes('%USERPROFILE%'))).toEqual([])
})

test('when the config cannot be read, servers are still listed and the pane says skills were not judged', async ($, on) => {
  const { clock } = world(on, { config: 'not json', mcpJson: '{"mcpServers": {"exa": {}}}' })
  await start($)
  await clock.settle()
  const shown = await pane($)

  expect(await shown.find({ text: /Can't read Claude Code's usage counters/ })).toBeDefined()
  expect(await shown.find({ text: 'superpowers' })).toBeUndefined()
  expect(await shown.find({ text: 'plugin-authoring' })).toBeUndefined()
  expect(await shown.find({ text: 'MCP SERVERS · 1' })).toBeDefined()
  expect(await shown.find({ text: 'exa' })).toBeDefined()
})

test('a server is not listed before tracking is as old as the window; a plugin is', () => {
  const items = [skill('p:one', 'p', 100), server('exa', 'user', 400)]
  const young = { ...WIN, since: NOW - 5 * DAY_MS }

  expect(unusedUnits(items, counters({}), {}, young).map(unit => unit.kind)).toEqual(['plugin'])
  expect(unusedUnits(items, counters({}), {}, WIN).map(unit => unit.kind)).toEqual(['plugin', 'mcp'])
})

test('units come out plugins first, then skills, then servers, each dearest first and a kept one left out', () => {
  const items = [
    server('cheap-server', 'user', 10),
    skill('mine', undefined, 50),
    skill('a:one', 'a', 20),
    skill('b:one', 'b', 90),
    server('dear-server', 'user', 500),
    skill('yours', undefined, 80),
    skill('kept', undefined, 999),
  ]
  const units = unusedUnits(items, counters({}), {}, { ...WIN, muted: ['skill:kept'] })

  expect(units.map(unit => unit.name)).toEqual(['b', 'a', 'yours', 'mine', 'dear-server', 'cheap-server'])
  expect(signature(units)).toBe('mcp:cheap-server|mcp:dear-server|plugin:a|plugin:b|skill:mine|skill:yours')
})

test('without counters no plugin or skill is judged, but servers still are', () => {
  const items = [skill('p:one', 'p', 100), skill('mine', undefined, 50), server('exa', 'user', 400)]

  expect(unusedUnits(items, undefined, {}, WIN).map(unit => unit.name)).toEqual(['exa'])
})

test('a project server is unused in a repo where it was not called, a user server only if called nowhere', () => {
  const items = [server('local-db', 'project', 100), server('exa', 'user', 200)]
  const uses = countUse(countUse({}, 'mcp:local-db', '/other', NOW - DAY_MS), 'mcp:exa', '/other', NOW - DAY_MS)

  expect(unusedUnits(items, undefined, uses, WIN).map(unit => unit.name)).toEqual(['local-db'])
})

test('a session in a subdirectory, or a path written the Windows way, still counts for the repo', () => {
  const items = [server('local-db', 'project', 100)]
  const view = { ...WIN, project: 'D:/Work' }
  const used = (cwd: string) => unusedUnits(items, undefined, countUse({}, 'mcp:local-db', cwd, NOW - DAY_MS), view)

  expect(used(winPath('d:', 'work', 'packages', 'api'))).toEqual([])
  expect(used(winPath('D:', 'Work', ''))).toEqual([])
  expect(used(winPath('D:', 'Workshop'))).toHaveLength(1)
  expect(normalPath(winPath('C:', 'A', 'b', ''))).toBe('c:/a/b')
})

test('agoText says never, today, yesterday, then days', () => {
  expect(agoText(undefined, NOW)).toBe('never used')
  expect(agoText(NOW - 1000, NOW)).toBe('today')
  expect(agoText(NOW - DAY_MS, NOW)).toBe('yesterday')
  expect(agoText(NOW - 41 * DAY_MS - 5000, NOW)).toBe('41 days ago')
})

test('barText splits filled from empty, fills at least one cell for a positive share and never overflows', () => {
  expect(barText(0.5, 8)).toEqual({ filled: '▰▰▰▰', empty: '▱▱▱▱' })
  expect(barText(0.001, 8)).toEqual({ filled: '▰', empty: '▱▱▱▱▱▱▱' })
  expect(barText(0, 8)).toEqual({ filled: '', empty: '▱▱▱▱▱▱▱▱' })
  expect(barText(3, 4)).toEqual({ filled: '▰▰▰▰', empty: '' })
})

test('tierOf cuts at 500 and 100 tokens', () => {
  expect([tierOf(500), tierOf(499), tierOf(100), tierOf(99)]).toEqual(['high', 'mid', 'mid', 'low'])
})

test('skillsText names the first few and counts the rest', () => {
  expect(skillsText(['a', 'b', 'c'], 5)).toBe('a, b, c')
  expect(skillsText(['a', 'b', 'c', 'd'], 2)).toBe('a, b +2')
  expect(skillsText([], 5)).toBe('')
})

test('dayText reads the UTC date, day first', () => {
  expect(dayText(Date.UTC(2026, 6, 14, 23, 59))).toBe('14 Jul')
  expect(dayText(Date.UTC(2026, 0, 1, 0, 0))).toBe('1 Jan')
})

test('a claude.ai connector named by a UUID is not listed, since it is managed in the app', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await clock.settle()

  expect(await (await pane($)).find({ text: /1a59c906/ })).toBeUndefined()
})

test('the first session lists what was never used and toasts once', async ($, on) => {
  const { seen, clock } = world(on, { config: configOf({ skills: { 'plugin-authoring': NOW - 3 * DAY_MS } }) })
  await start($)
  await clock.settle()

  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toMatch(/toolbelt: 1 plugin and 2 servers unused 14 days/)

  const shown = await pane($)
  expect(await shown.find({ text: 'superpowers' })).toBeDefined()
  expect(await shown.find({ text: 'exa' })).toBeDefined()
  expect(await shown.find({ text: 'plugin-authoring' })).toBeUndefined()
})

test('the toast comes at most once a day and only when the list changed', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await clock.settle()
  expect(seen.toasts).toHaveLength(1)

  await start($)
  await clock.settle()
  expect(seen.toasts).toHaveLength(1)

  await clock.advance(2 * DAY_MS)
  await start($)
  await clock.settle()
  expect(seen.toasts).toHaveLength(1)
})

test('a skill Claude Code has counted since leaves the list on the next /unused, and a server call does too', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await clock.settle()

  seen.w.config = configOf({ skills: { 'superpowers:brainstorming': NOW, 'plugin-authoring': NOW } })
  await $.tool.call({ tool: 'mcp__exa__web_search_exa' })
  await $.command.run({ command: 'unused', args: '', ...RUN })

  const shown = await pane($)
  expect([await shown.find({ text: 'plugin-authoring' }), await shown.find({ text: 'exa' }), await shown.find({ text: 'superpowers' })].map(one => one !== undefined)).toEqual([false, false, false])
  expect(await shown.find({ text: 'chrome' })).toBeDefined()
})

test('an old store\'s live tally is folded into the uses once, and the keys it no longer needs are removed', async ($, on) => {
  const stored = {
    uses: { 'mcp:chrome': { count: 1, lastAt: NOW - DAY_MS, byProject: { '/work': NOW - DAY_MS } } },
    live: { 'mcp:exa': { count: 2, lastAt: NOW - DAY_MS, byProject: { '/work': NOW - DAY_MS } } },
    scanned: NOW,
    backfilled: true,
    scopes: { exa: 'user' },
  }
  const { seen, clock } = world(on, { stored })
  await start($)
  await clock.settle()

  expect([...seen.held.keys()].filter(key => ['live', 'scanned', 'backfilled', 'scopes'].includes(key))).toEqual([])
  expect(Object.keys(seen.held.get('uses') as object).sort()).toEqual(['mcp:chrome', 'mcp:exa'])

  const shown = await pane($)
  expect(await shown.find({ text: 'exa' })).toBeUndefined()
  expect(await shown.find({ text: 'chrome' })).toBeUndefined()
})

test('a plugin is one unit with a single Disable, and the confirm line says how many skills go with it', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await clock.settle()
  const shown = await pane($)

  expect(await shown.find({ text: 'Toolbelt' })).toBeDefined()
  expect(await shown.find({ text: 'writing-plans, brainstorming' })).toBeDefined()
  expect(await shown.find({ text: /2 skills · never used/ })).toBeDefined()
  expect(await shown.find({ key: 'disable:skill:superpowers:writing-plans' })).toBeUndefined()

  await shown.press({ key: 'disable:plugin:superpowers' })

  expect(await shown.find({ text: /Disable superpowers\? Its 2 skills go with it/ })).toBeDefined()

  await shown.press({ key: 'yes:plugin:superpowers' })

  expect(seen.ran.filter(line => line.endsWith('claude plugin disable superpowers@official'))).toHaveLength(1)
  expect(await shown.find({ key: 'disable:plugin:superpowers' })).toBeUndefined()
})

test('disabling a plugin keeps one record to undo, and Enable brings it back', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await clock.settle()
  const shown = await pane($)

  await shown.press({ key: 'disable:plugin:superpowers' })
  await shown.press({ key: 'yes:plugin:superpowers' })
  await shown.press({ key: 'enable:plugin:superpowers' })

  expect(seen.ran).toContain('cmd.exe /d /c claude plugin enable superpowers@official')
  expect(await shown.find({ text: /SWITCHED OFF BY TOOLBELT/ })).toBeUndefined()
})

test('a disabled plugin that can no longer be enabled can be forgotten, and the failure shows as an error', async ($, on) => {
  const { seen, clock } = world(on, { failRun: 'plugin enable' })
  await start($)
  await clock.settle()
  const shown = await pane($)

  await shown.press({ key: 'disable:plugin:superpowers' })
  await shown.press({ key: 'yes:plugin:superpowers' })
  await shown.press({ key: 'enable:plugin:superpowers' })

  expect(await shown.find({ text: /superpowers: boom/ })).toBeDefined()
  expect(await shown.find({ key: 'enable:plugin:superpowers' })).toBeDefined()

  await shown.press({ key: 'forget:plugin:superpowers' })

  expect(await shown.find({ text: /SWITCHED OFF BY TOOLBELT/ })).toBeUndefined()
  expect(seen.ran.filter(line => line.includes('plugin uninstall'))).toHaveLength(0)
})

test('when the pane cannot be seated, /unused lists the units as text', async ($, on) => {
  const { seen, clock } = world(on, { isPlaced: false, extraSkills: 20 })
  await start($)
  await clock.settle()
  await $.command.run({ command: 'unused', args: '', ...RUN })
  await clock.settle()

  expect(seen.toasts.at(-1)).toMatch(/unused for 14 days/)
  expect(seen.toasts.at(-1)).toMatch(/plugin superpowers \(2 skills\)/)
  expect(seen.toasts.at(-1)).toMatch(/and \d+ more/)
})

test('a long list pages by unit, and a section heading is drawn on the page where its section starts', async ($, on) => {
  const { clock } = world(on, { extraSkills: 20 })
  await start($)
  await clock.settle()
  const shown = await pane($)

  expect(await shown.find({ text: /1 of 3/ })).toBeDefined()
  expect(await shown.find({ text: 'PLUGINS · 1' })).toBeDefined()
  expect(await shown.find({ text: 'SKILLS · 21' })).toBeDefined()
  expect(await shown.find({ text: 'MCP SERVERS · 2' })).toBeUndefined()

  await shown.press({ key: 'next' })

  expect(await shown.find({ text: /2 of 3/ })).toBeDefined()
  expect(await shown.find({ text: 'PLUGINS · 1' })).toBeUndefined()

  await shown.press({ key: 'next' })

  expect(await shown.find({ text: 'MCP SERVERS · 2' })).toBeDefined()

  await shown.press({ key: 'prev' })

  expect(await shown.find({ text: /2 of 3/ })).toBeDefined()
})

test('disabling a user skill asks twice, moves the folder, and Enable moves it back', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await clock.settle()
  const shown = await pane($)

  await shown.press({ key: 'disable:skill:plugin-authoring' })

  expect(seen.ran.some(line => line.includes('move'))).toBe(false)
  expect(await shown.find({ text: /skills-disabled/ })).toBeDefined()

  await shown.press({ key: 'yes:skill:plugin-authoring' })

  expect(seen.ran).toContain(moveLine('skills', 'skills-disabled'))
  expect(await shown.find({ text: /SWITCHED OFF BY TOOLBELT/ })).toBeDefined()

  await shown.press({ key: 'enable:skill:plugin-authoring' })

  expect(seen.ran).toContain(moveLine('skills-disabled', 'skills'))
})

test('a plugin offers Uninstall beside Disable and asks first, and a server offers only removal', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await clock.settle()
  const shown = await pane($)

  expect(await shown.find({ key: 'disable:mcp:exa' })).toBeUndefined()

  await shown.press({ key: 'remove:plugin:superpowers' })
  await shown.press({ key: 'yes:plugin:superpowers' })

  expect(seen.ran).toContain('cmd.exe /d /c claude plugin uninstall superpowers@official')

  await shown.press({ key: 'remove:mcp:exa' })
  await shown.press({ key: 'yes:mcp:exa' })

  expect(seen.ran).toContain('cmd.exe /d /c claude mcp remove exa -s user')
})

test('a failed command leaves the unit listed and says why', async ($, on) => {
  const { clock } = world(on, { failRun: 'mcp remove' })
  await start($)
  await clock.settle()
  const shown = await pane($)

  await shown.press({ key: 'remove:mcp:exa' })
  await shown.press({ key: 'yes:mcp:exa' })

  expect(await shown.find({ text: /exa: boom/ })).toBeDefined()
  expect(await shown.find({ text: /✓/ })).toBeUndefined()
  expect(await shown.find({ key: 'remove:mcp:exa' })).toBeDefined()
})

test('Keep takes a unit off the list for good', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await clock.settle()
  const shown = await pane($)

  await shown.press({ key: 'keep:mcp:exa' })

  expect(await shown.find({ text: /exa kept/ })).toBeDefined()
  expect(await shown.find({ key: 'keep:mcp:exa' })).toBeUndefined()
})

test('a server\'s scope shows in the pane, as read from .mcp.json before the config', async ($, on) => {
  const { clock } = world(on, { mcpJson: '{"mcpServers": {"exa": {}}}' })
  await start($)
  await clock.settle()
  const shown = await pane($)

  expect(await shown.find({ text: /project · no calls since/ })).toBeDefined()
  expect(await shown.find({ key: 'remove:mcp:exa' })).toBeDefined()
})

test('a deferred server costs only its tool names', async ($, on) => {
  const { clock } = world(on)
  await $.tool.describe({ tool: 'mcp__exa__web_search_exa', description: 'Search the web with Exa.', isDeferred: true, provider: { plugin: 'mcp:exa', tier: 'user' } })
  await start($)
  await clock.settle()
  const shown = await pane($)

  expect(await shown.find({ text: '~6 tok' })).toBeDefined()
})

test('a server listed in the prompt costs its names and descriptions', async ($, on) => {
  const { clock } = world(on)
  await $.tool.describe({ tool: 'mcp__exa__web_search_exa', description: 'Search the web with Exa.', provider: { plugin: 'mcp:exa', tier: 'user' } })
  await start($)
  await clock.settle()
  const shown = await pane($)

  expect(await shown.find({ text: '~12 tok' })).toBeDefined()
})

test('when everything was used the pane says so and draws no header', async ($, on) => {
  const stamp = NOW - DAY_MS
  const { clock } = world(on, {
    config: configOf({ skills: { 'superpowers:writing-plans': stamp, 'plugin-authoring': stamp } }),
    stored: { uses: { 'mcp:exa': { count: 1, lastAt: stamp }, 'mcp:chrome': { count: 1, lastAt: stamp } } },
  })
  await start($)
  await clock.settle()
  await $.command.run({ command: 'unused', args: '', ...RUN })
  const shown = await pane($)

  expect(await shown.find({ text: /Nothing unused/ })).toBeDefined()
  expect(await shown.find({ text: 'Toolbelt' })).toBeUndefined()
})

test('the window is the chosen number of days, and 14 for anything else', () => {
  expect(['7', '90', '15', '', undefined, 30].map(daysOf)).toEqual([7, 90, 14, 14, 14, 14])
})

test('a plugin used 20 days ago is listed under the default window', async ($, on) => {
  const { clock } = world(on, { config: configOf({ skills: { 'superpowers:brainstorming': NOW - 20 * DAY_MS } }) })
  await start($)
  await clock.settle()
  const shown = await pane($)

  expect(await shown.find({ key: 'disable:plugin:superpowers' })).toBeDefined()
  expect(await shown.find({ text: 'unused 14 days' })).toBeDefined()
})

test('with the window set to 30 days, a plugin used 20 days ago is not listed', { options: { unusedDays: '30' } }, async ($, on) => {
  const { clock } = world(on, { config: configOf({ skills: { 'superpowers:brainstorming': NOW - 20 * DAY_MS } }) })
  await start($)
  await clock.settle()
  const shown = await pane($)

  expect(await shown.find({ key: 'disable:plugin:superpowers' })).toBeUndefined()
  expect(await shown.find({ text: 'unused 30 days' })).toBeDefined()
})