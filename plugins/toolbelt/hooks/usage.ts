import type { Item, Unit, UnitKind, Use, Uses } from '../types'

export const DAY_MS = 86_400_000
export const DAY_CHOICES = ['7', '14', '30', '60', '90']
export const DEFAULT_DAYS = 14

/** The window the person chose in the plugin's settings; anything else is the default. */
export const daysOf = (option: unknown) => (typeof option === 'string' && DAY_CHOICES.includes(option) ? Number(option) : DEFAULT_DAYS)
const CHARS_PER_TOKEN = 4
const HIGH_TOKENS = 500
const MID_TOKENS = 100
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const keyOf = (kind: UnitKind, name: string) => `${kind}:${name}`

/** `mcp__exa__web_search_exa` is server `exa`. */
export const serverOf = (tool: string) => /^mcp__(.+?)__/.exec(tool)?.[1]

/** One form for a path: forward slashes, no trailing slash, and case folded when it starts with a Windows drive. */
export function normalPath(path: string) {
  const slashed = path.split('\\').join('/').replace(/\/+$/, '')

  return /^[a-z]:/i.test(slashed) ? slashed.toLowerCase() : slashed
}

/** A session started in a subdirectory still belongs to the repo above it. */
const isInRepo = (cwd: string, repo: string) => cwd === repo || cwd.startsWith(`${repo}/`)

const isPerProject = (scope: Item['scope']) => scope === 'project' || scope === 'local'

export function countUse(uses: Uses, key: string, project: string, at: number): Uses {
  const held = uses[key]
  const place = normalPath(project)

  return {
    ...uses,
    [key]: {
      count: (held?.count ?? 0) + 1,
      lastAt: Math.max(held?.lastAt ?? 0, at),
      byProject: { ...held?.byProject, [place]: Math.max(held?.byProject?.[place] ?? 0, at) },
    },
  }
}

function lastInRepo(use: Use | undefined, project: string) {
  const repo = normalPath(project)
  const times = Object.entries(use?.byProject ?? {}).flatMap(([cwd, at]) => (isInRepo(normalPath(cwd), repo) ? [at] : []))

  return times.length === 0 ? undefined : Math.max(...times)
}

export type Counters = {
  skills: Record<string, { count: number; lastAt: number }>
  userServers: string[]
  /** Local-scope servers by normalised project path. */
  localServers: Record<string, string[]>
  /** Servers the person switched off in a project, by normalised project path. */
  disabledServers: Record<string, string[]>
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const own = <T>(record: Record<string, T>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined)

/** What Claude Code's own config says about use; undefined when the text is not that config. */
export function readCounters(text: string): Counters | undefined {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }

  const config = asRecord(parsed)
  const usage = asRecord(config?.skillUsage)

  if (config === undefined || usage === undefined) return undefined

  const skills: Counters['skills'] = {}

  for (const [name, entry] of Object.entries(usage)) {
    const counter = asRecord(entry)

    if (typeof counter?.usageCount === 'number' && typeof counter.lastUsedAt === 'number') {
      skills[name] = { count: counter.usageCount, lastAt: counter.lastUsedAt }
    }
  }

  const localServers: Counters['localServers'] = {}
  const disabledServers: Counters['disabledServers'] = {}

  for (const [path, project] of Object.entries(asRecord(config.projects) ?? {})) {
    const entry = asRecord(project)
    const names = Object.keys(asRecord(entry?.mcpServers) ?? {})
    const off = [entry?.disabledMcpServers, entry?.disabledMcpjsonServers].flatMap(list => (Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string') : []))
    const place = normalPath(path)

    if (names.length > 0) localServers[place] = [...(localServers[place] ?? []), ...names]
    if (off.length > 0) disabledServers[place] = [...(disabledServers[place] ?? []), ...off]
  }

  return { skills, userServers: Object.keys(asRecord(config.mcpServers) ?? {}), localServers, disabledServers }
}

/** The servers a repo's `.mcp.json` lists; none when the text is not that file. */
export function projectServers(text: string): string[] {
  try {
    return Object.keys(asRecord(asRecord(JSON.parse(text))?.mcpServers) ?? {})
  } catch {
    return []
  }
}

/** One install of a plugin: its `name@marketplace` id, and what the record says of its version and last update. */
export type Install = { id: string; version: string; updatedAt: number }
export type Installs = Record<string, Install[]>

/** Installs by plugin name, from the CLI's install record; none when the text is not that record. */
export function installsOf(text: string): Installs {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }

  const installs: Installs = {}

  for (const [id, entries] of Object.entries(asRecord(asRecord(parsed)?.plugins) ?? {})) {
    const name = id.slice(0, id.lastIndexOf('@'))
    const entry = asRecord(Array.isArray(entries) ? entries[0] : entries)
    const updatedAt = Date.parse(typeof entry?.lastUpdated === 'string' ? entry.lastUpdated : '')

    if (name === '') continue

    installs[name] = [
      ...(own(installs, name) ?? []),
      { id, version: typeof entry?.version === 'string' ? entry.version : '', updatedAt: Number.isNaN(updatedAt) ? 0 : updatedAt },
    ]
  }

  return installs
}

/** The plugin ids the settings switch off (`enabledPlugins` set to false). */
export const switchedOff = (settings: Record<string, unknown>) =>
  Object.entries(asRecord(settings.enabledPlugins) ?? {}).flatMap(([id, isOn]) => (isOn === false ? [id] : []))

const marketOf = (id: string) => id.slice(id.lastIndexOf('@') + 1)

const labelOf = (install: Install) => `${install.version === '' ? '' : `${install.version} `}from ${marketOf(install.id)}`

/**
 * What is loaded twice, whether or not it is used: a plugin installed from two marketplaces, of which the copy updated
 * longest ago is the one to drop, and a user skill whose name a plugin's skill also carries.
 */
export function duplicateUnits(items: Item[], installs: Installs, off: string[], muted: string[]): Unit[] {
  const units: Unit[] = []

  for (const [name, all] of Object.entries(installs)) {
    const live = all.filter(install => !off.includes(install.id)).sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
    const [stale, ...kept] = live
    const newest = kept.at(-1)

    if (stale === undefined || newest === undefined) continue

    const seen = new Set<string>()
    const repeated = items.filter(item => item.plugin === name && (seen.has(item.name) || !seen.add(item.name)))

    units.push({
      kind: 'duplicate',
      name,
      id: stale.id,
      scope: 'plugin',
      cost: repeated.reduce((sum, item) => sum + item.cost, 0),
      skills: [],
      uses: 0,
      detail: `${labelOf(stale)} · ${labelOf(newest)} is newer`,
    })
  }

  for (const item of items) {
    if (item.kind !== 'skill' || item.scope !== 'user') continue

    const twin = items.find(other => other.kind === 'skill' && other.plugin !== undefined && other.name.endsWith(`:${item.name}`))

    if (twin?.plugin !== undefined) {
      units.push({ kind: 'duplicate', name: item.name, scope: 'user', cost: item.cost, skills: [], uses: 0, detail: `your copy · ${twin.plugin} has one too` })
    }
  }

  return units.filter(unit => !muted.includes(keyOf('duplicate', unit.name)))
}

/** The desktop app syncs this plugin's skills from the account into `~/.claude/skills/synced`: the install record does not name it, and its skills are listed as bare user commands. */
export const SYNCED_PLUGIN = 'anthropic-skills'
const SYNCED_IDS: Record<string, string> = { [SYNCED_PLUGIN]: `${SYNCED_PLUGIN}@synced` }

/** A synced skill is listed as `docx`, or `anthropic-skills:docx` when a user skill already has the bare name. */
export const syncedBare = (name: string) => (name.startsWith(`${SYNCED_PLUGIN}:`) ? name.slice(SYNCED_PLUGIN.length + 1) : name)

/** A synced plugin can be switched off but not uninstalled: the app brings it back. */
export const isSynced = (id: string | undefined) => id?.endsWith('@synced') === true

/** Each plugin unit with the id the CLI takes: a bare name is refused for a synced plugin and is ambiguous between two installs. */
export const withIds = (units: Unit[], installs: Installs): Unit[] =>
  units.map(unit => {
    if (unit.kind !== 'plugin') return unit

    const all = own(installs, unit.name) ?? []
    const id = all.length === 1 ? all[0]?.id : all.length === 0 ? own(SYNCED_IDS, unit.name) : undefined

    return id === undefined ? unit : { ...unit, id }
  })

/** Where a server is defined, read from data and in this order: app-managed, plugin-bundled, the repo's `.mcp.json`, the config's entry for the repo, the config's user entries. */
export function serverScope(name: string, root: string, listed: string[], counters: Counters | undefined): Item['scope'] {
  if (name.startsWith('claude_ai_') || isConnector(name)) return 'builtin'
  if (name.startsWith('plugin_')) return 'plugin'
  if (listed.includes(name)) return 'project'
  if (counters?.localServers[normalPath(root)]?.includes(name)) return 'local'
  if (counters?.userServers.includes(name)) return 'user'

  return 'unknown'
}

/** A skill's counter: its full name first, then its bare name, but only when one loaded skill ends in that name. */
export function skillUse(counters: Counters, name: string, loaded: string[]): { count: number; lastAt: number } | undefined {
  const full = own(counters.skills, name)

  if (full !== undefined) return full

  const bare = name.slice(name.lastIndexOf(':') + 1)
  const sharing = loaded.filter(one => one === bare || one.endsWith(`:${bare}`))

  return sharing.length === 1 ? own(counters.skills, bare) : undefined
}

export type View = {
  project: string
  now: number
  since: number
  days: number
  muted: string[]
  installs?: Installs
  off?: string[]
  /** The servers the repo's `.mcp.json` lists. */
  listed?: string[]
}

const dearestFirst = (a: Unit, b: Unit) => b.cost - a.cost || a.name.localeCompare(b.name)

const onePerName = (skills: Item[]) => skills.filter((skill, at) => skills.findIndex(other => other.name === skill.name) === at)

/** A plugin loaded twice is costed once here: the duplicate row already counts the spare copy. */
function pluginUnits(items: Item[], counters: Counters, view: View, cutoff: number, twice: Unit[]): Unit[] {
  const loaded = items.filter(item => item.kind === 'skill').map(item => item.name)
  const byPlugin = new Map<string, Item[]>()

  for (const item of items) {
    if (item.kind !== 'skill' || item.scope !== 'plugin' || item.plugin === undefined) continue

    byPlugin.set(item.plugin, [...(byPlugin.get(item.plugin) ?? []), item])
  }

  return [...byPlugin].flatMap(([name, skills]): Unit[] => {
    const used = skills.flatMap(skill => skillUse(counters, skill.name, loaded) ?? [])
    const lastAt = used.length === 0 ? undefined : Math.max(...used.map(one => one.lastAt))

    if (view.muted.includes(keyOf('plugin', name)) || (lastAt !== undefined && lastAt > cutoff)) return []

    return [
      {
        kind: 'plugin',
        name,
        scope: 'plugin',
        cost: (twice.some(unit => unit.scope === 'plugin' && unit.name === name) ? onePerName(skills) : skills).reduce((sum, skill) => sum + skill.cost, 0),
        skills: [...new Set([...skills].sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name)).map(skill => skill.name))],
        uses: used.reduce((sum, one) => sum + one.count, 0),
        ...(lastAt === undefined ? {} : { lastAt }),
      },
    ]
  })
}

function skillUnits(items: Item[], counters: Counters, view: View, cutoff: number, twice: Unit[]): Unit[] {
  const loaded = items.filter(item => item.kind === 'skill').map(item => item.name)

  return items.flatMap((item): Unit[] => {
    const isTwice = twice.some(unit => unit.scope === 'user' && unit.name === item.name) || view.muted.includes(keyOf('duplicate', item.name))

    if (item.kind !== 'skill' || item.scope !== 'user' || isTwice) return []

    const use = skillUse(counters, item.name, loaded)

    if (view.muted.includes(keyOf('skill', item.name)) || (use !== undefined && use.lastAt > cutoff)) return []

    return [{ kind: 'skill', name: item.name, scope: item.scope, cost: item.cost, skills: [], uses: use?.count ?? 0, ...(use === undefined ? {} : { lastAt: use.lastAt }) }]
  })
}

function serverUnits(items: Item[], uses: Uses, view: View, cutoff: number): Unit[] {
  return items.flatMap((item): Unit[] => {
    if (item.kind !== 'mcp') return []

    const key = keyOf('mcp', item.name)
    const use = uses[key]
    const lastAt = isPerProject(item.scope) ? lastInRepo(use, view.project) : use?.lastAt

    if (view.muted.includes(key) || (lastAt !== undefined && lastAt > cutoff)) return []

    return [{ kind: 'mcp', name: item.name, scope: item.scope, cost: item.cost, skills: [], uses: use?.count ?? 0, ...(lastAt === undefined ? {} : { lastAt }) }]
  })
}

/**
 * Servers the config names that gave this session no tools, used or not: one that fails to start costs nothing per turn
 * but is dead weight in the config. A server the person switched off for the repo is left out.
 */
function downUnits(items: Item[], counters: Counters, uses: Uses, view: View): Unit[] {
  const repo = normalPath(view.project)
  const connected = items.flatMap(item => (item.kind === 'mcp' ? [item.name] : []))
  const off = own(counters.disabledServers, repo) ?? []
  const configured = new Map<string, Item['scope']>()

  for (const [scope, names] of [['project', view.listed ?? []], ['local', own(counters.localServers, repo) ?? []], ['user', counters.userServers]] as const) {
    for (const name of names) if (!configured.has(name)) configured.set(name, scope)
  }

  return [...configured].flatMap(([name, scope]): Unit[] => {
    const key = keyOf('mcp', name)

    if (connected.includes(name) || off.includes(name) || view.muted.includes(key)) return []

    const use = uses[key]

    return [{ kind: 'mcp', name, scope, cost: 0, skills: [], uses: use?.count ?? 0, ...(use === undefined ? {} : { lastAt: use.lastAt }), isDown: true }]
  })
}

/**
 * What is loaded twice, then the plugins, user skills and servers nobody used for `days`, each group dearest first.
 * Skills are judged by Claude Code's own counters and need no waiting; a server is judged by Toolbelt's tally,
 * so nothing counts as unused before that tracking is `days` old. Without counters skills are not judged.
 */
export function unusedUnits(items: Item[], counters: Counters | undefined, uses: Uses, view: View): Unit[] {
  const cutoff = view.now - view.days * DAY_MS
  const isWaiting = view.now - view.since < view.days * DAY_MS

  const twice = duplicateUnits(items, view.installs ?? {}, view.off ?? [], view.muted).sort(dearestFirst)

  return [
    ...twice,
    ...(counters === undefined ? [] : [...pluginUnits(items, counters, view, cutoff, twice).sort(dearestFirst), ...skillUnits(items, counters, view, cutoff, twice).sort(dearestFirst)]),
    ...(isWaiting ? [] : serverUnits(items, uses, view, cutoff).sort(dearestFirst)),
    ...(counters === undefined ? [] : downUnits(items, counters, uses, view).sort(dearestFirst)),
  ]
}

export const signature = (units: Unit[]) => units.map(unit => keyOf(unit.kind, unit.name)).sort().join('|')

export const tokensOf = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN)

export const tokenText = (tokens: number) => (tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens))

export const totalText = (units: Unit[]) => tokenText(units.reduce((sum, unit) => sum + tokensOf(unit.cost), 0))

export type Tier = 'high' | 'mid' | 'low'

export const tierOf = (tokens: number): Tier => (tokens >= HIGH_TOKENS ? 'high' : tokens >= MID_TOKENS ? 'mid' : 'low')

/** `never used`, `today`, `yesterday`, `41 days ago`. */
export function agoText(lastAt: number | undefined, now: number) {
  if (lastAt === undefined) return 'never used'

  const days = Math.floor((now - lastAt) / DAY_MS)

  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
}

/** A bar in two parts so each can take its own colour; a positive share fills at least one cell. */
export function barText(share: number, cells: number) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(share) ? share : 0))
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round(clamped * cells))

  return { filled: '▰'.repeat(filled), empty: '▱'.repeat(cells - filled) }
}

/** `grilling, tdd +23`: the first `shown` names and a count of the rest. */
export const skillsText = (skills: string[], shown: number) =>
  skills.length <= shown ? skills.join(', ') : `${skills.slice(0, shown).join(', ')} +${skills.length - shown}`

/** `14 Jul`, from UTC parts so the result does not depend on the machine's zone. */
export function dayText(at: number) {
  const date = new Date(at)

  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

export const KINDS = ['duplicate', 'plugin', 'skill', 'mcp'] as const

/** `12 plugins`, `2 skills`, `3 servers`; a kind with none is left out. */
export const countParts = (units: Unit[]) =>
  KINDS.flatMap(kind => {
    const count = units.filter(unit => unit.kind === kind).length

    return count === 0 ? [] : [plural(count, kind === 'mcp' ? 'server' : kind)]
  })

export const pluralSkills = (count: number) => plural(count, 'skill')

export function toastText(units: Unit[], days: number) {
  const twice = units.filter(unit => unit.kind === 'duplicate').length
  const parts = countParts(units.filter(unit => unit.kind !== 'duplicate'))
  const counts = parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
  const said = [...(twice === 0 ? [] : [`${twice} loaded twice`]), ...(counts === '' ? [] : [`${counts} unused ${days} days`])]

  return `toolbelt: ${said.join('; ')}, ~${totalText(units)} tokens each turn. /unused to review.`
}

export const TEXT_UNITS = 15

const lineOf = (unit: Unit) => {
  const detail = unit.kind === 'plugin' ? pluralSkills(unit.skills.length) : (unit.detail ?? unit.scope)

  return `${unit.kind} ${unit.name} (${detail}) ~${tokenText(tokensOf(unit.cost))}`
}

/** The list as plain lines, for a screen too narrow to seat the pane. */
export function listText(units: Unit[], days: number) {
  const more = units.length > TEXT_UNITS ? [`…and ${units.length - TEXT_UNITS} more, cheaper. Widen the terminal to 110 columns for the pane.`] : []

  return [`${units.length} unused for ${days} days, ~${totalText(units)} tokens/turn:`, ...units.slice(0, TEXT_UNITS).map(lineOf), ...more].join('\n')
}

/** What two tallies add up to: counts add, the latest use and the latest use in each repo win. */
export function combine(a: Uses, b: Uses): Uses {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])

  return Object.fromEntries(
    [...keys].map(key => {
      const [one, two] = [a[key], b[key]]
      const projects = new Set([...Object.keys(one?.byProject ?? {}), ...Object.keys(two?.byProject ?? {})])

      return [
        key,
        {
          count: (one?.count ?? 0) + (two?.count ?? 0),
          lastAt: Math.max(one?.lastAt ?? 0, two?.lastAt ?? 0),
          byProject: Object.fromEntries([...projects].map(project => [project, Math.max(one?.byProject?.[project] ?? 0, two?.byProject?.[project] ?? 0)])),
        },
      ]
    }),
  )
}

/** A claude.ai connector is named by a UUID and is managed in the app, not here. */
export const isConnector = (name: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(name)
