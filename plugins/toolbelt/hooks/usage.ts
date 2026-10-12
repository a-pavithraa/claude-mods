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

  for (const [path, project] of Object.entries(asRecord(config.projects) ?? {})) {
    const names = Object.keys(asRecord(asRecord(project)?.mcpServers) ?? {})
    const place = normalPath(path)

    if (names.length > 0) localServers[place] = [...(localServers[place] ?? []), ...names]
  }

  return { skills, userServers: Object.keys(asRecord(config.mcpServers) ?? {}), localServers }
}

/** The servers a repo's `.mcp.json` lists; none when the text is not that file. */
export function projectServers(text: string): string[] {
  try {
    return Object.keys(asRecord(asRecord(JSON.parse(text))?.mcpServers) ?? {})
  } catch {
    return []
  }
}

/** Plugin ids (`name@marketplace`) by plugin name, from the CLI's install record; none when the text is not that record. */
export function installedIds(text: string): Record<string, string[]> {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }

  const ids: Record<string, string[]> = {}

  for (const id of Object.keys(asRecord(asRecord(parsed)?.plugins) ?? {})) {
    const name = id.slice(0, id.lastIndexOf('@'))

    if (name !== '') ids[name] = [...(own(ids, name) ?? []), id]
  }

  return ids
}

/** The desktop app syncs these from the account instead of installing them, so the install record does not name them. */
const SYNCED_IDS: Record<string, string> = { 'anthropic-skills': 'anthropic-skills@synced' }

/** A synced plugin can be switched off but not uninstalled: the app brings it back. */
export const isSynced = (id: string | undefined) => id?.endsWith('@synced') === true

/** Each plugin unit with the id the CLI takes: a bare name is refused for a synced plugin and is ambiguous between two installs. */
export const withIds = (units: Unit[], installed: Record<string, string[]>): Unit[] =>
  units.map(unit => {
    if (unit.kind !== 'plugin') return unit

    const ids = own(installed, unit.name) ?? []
    const id = ids.length === 1 ? ids[0] : ids.length === 0 ? own(SYNCED_IDS, unit.name) : undefined

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

export type View = { project: string; now: number; since: number; days: number; muted: string[] }

const dearestFirst = (a: Unit, b: Unit) => b.cost - a.cost || a.name.localeCompare(b.name)

function pluginUnits(items: Item[], counters: Counters, view: View, cutoff: number): Unit[] {
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
        cost: skills.reduce((sum, skill) => sum + skill.cost, 0),
        skills: [...skills].sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name)).map(skill => skill.name),
        uses: used.reduce((sum, one) => sum + one.count, 0),
        ...(lastAt === undefined ? {} : { lastAt }),
      },
    ]
  })
}

function skillUnits(items: Item[], counters: Counters, view: View, cutoff: number): Unit[] {
  const loaded = items.filter(item => item.kind === 'skill').map(item => item.name)

  return items.flatMap((item): Unit[] => {
    if (item.kind !== 'skill' || item.scope !== 'user') return []

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
 * Plugins, user skills and servers nobody used for `days`, each group dearest first.
 * Skills are judged by Claude Code's own counters and need no waiting; a server is judged by Toolbelt's tally,
 * so nothing counts as unused before that tracking is `days` old. Without counters skills are not judged.
 */
export function unusedUnits(items: Item[], counters: Counters | undefined, uses: Uses, view: View): Unit[] {
  const cutoff = view.now - view.days * DAY_MS
  const isWaiting = view.now - view.since < view.days * DAY_MS

  return [
    ...(counters === undefined ? [] : [...pluginUnits(items, counters, view, cutoff).sort(dearestFirst), ...skillUnits(items, counters, view, cutoff).sort(dearestFirst)]),
    ...(isWaiting ? [] : serverUnits(items, uses, view, cutoff).sort(dearestFirst)),
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

export const KINDS = ['plugin', 'skill', 'mcp'] as const

/** `12 plugins`, `2 skills`, `3 servers`; a kind with none is left out. */
export const countParts = (units: Unit[]) =>
  KINDS.flatMap(kind => {
    const count = units.filter(unit => unit.kind === kind).length

    return count === 0 ? [] : [plural(count, kind === 'mcp' ? 'server' : kind)]
  })

export const pluralSkills = (count: number) => plural(count, 'skill')

export function toastText(units: Unit[], days: number) {
  const parts = countParts(units)
  const counts = parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`

  return `toolbelt: ${counts} unused ${days} days, ~${totalText(units)} tokens each turn. /unused to review.`
}

export const TEXT_UNITS = 15

const lineOf = (unit: Unit) => {
  const detail = unit.kind === 'plugin' ? pluralSkills(unit.skills.length) : unit.scope

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
