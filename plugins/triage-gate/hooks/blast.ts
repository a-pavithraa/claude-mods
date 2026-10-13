import type { Blast, ChangedFile, Flag } from '../types'

const RISKY_PATH =
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pom\.xml|build\.gradle(\.kts)?|Cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt|Dockerfile|docker-compose\.ya?ml)$|(^|\/)(migrations?|\.github\/workflows|terraform|infra)\/|\.(sql|tf)$/i
/** Code where a one-line change can matter more than its size says. */
export const SENSITIVE_PATH =
  /auth|login|session|token|secret|credential|password|permission|acl|polic(y|ies)|security|crypto|(^|\/)\.env/i
const TOO_GENERIC = new Set(['index', 'main', 'mod', 'readme', 'changelog', 'license', 'types', 'utils', 'test'])
const SHORTEST_STEM = 4
/** Only code is imported by name; a config or doc file's name is just a common word elsewhere. */
const CODE_FILE = /\.(c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|mjs|cjs|mts|cts|php|py|rb|rs|scala|swift|ts|tsx|vue|svelte)$/i

export function parseNumstat(numstat: string): ChangedFile[] {
  return numstat
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .flatMap(line => {
      const [added, removed, ...rest] = line.split('\t')
      const path = rest.join('\t')

      if (path === '' || added === undefined || removed === undefined) {
        return []
      }

      return [
        {
          path,
          added: added === '-' ? 0 : Number(added),
          removed: removed === '-' ? 0 : Number(removed),
          isNew: false,
        },
      ]
    })
}

const UNHASHED = /^0+$/

/**
 * Each path of `git diff --raw -z --no-abbrev --no-renames` with the blob it will commit: `null` when deleted,
 * `undefined` when git left it unhashed because it lives in the working tree.
 */
export function parseRaw(raw: string): { path: string; blob: string | null | undefined }[] {
  const parts = raw.split('\0')
  const entries: { path: string; blob: string | null | undefined }[] = []

  for (let at = 0; at + 1 < parts.length; at += 2) {
    const meta = parts[at] ?? ''
    const path = parts[at + 1] ?? ''

    if (!meta.startsWith(':')) {
      break
    }

    const [, , , blob = '', status = ''] = meta.slice(1).split(' ')
    entries.push({ path, blob: status.startsWith('D') ? null : UNHASHED.test(blob) ? undefined : blob })
  }

  return entries
}

export function stemOf(path: string): string | undefined {
  const name = path.split('/').pop() ?? path
  const stem = name.replace(/(\.d)?\.[^.]+$/, '')

  return !CODE_FILE.test(name) || stem.length < SHORTEST_STEM || TOO_GENERIC.has(stem.toLowerCase())
    ? undefined
    : stem
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Where a file is named after the class it holds, the class name is how others reach it. */
const BY_CLASS_NAME = /\.(cs|java|kt|scala|swift|php)$/i

/**
 * The `git grep` arguments that find the files using this one: an import, include, require or `mod` naming it, so a
 * file called `pane.ts` is not "used" by every line that says pane. Languages that name a file after its class match
 * the name as a word, as before. A Go file is never imported by name, so it gets none.
 */
export function usersQuery(path: string): string[] | undefined {
  const stem = stemOf(path)

  if (stem === undefined || /\.go$/i.test(path)) {
    return undefined
  }

  if (BY_CLASS_NAME.test(path)) {
    return ['-w', '-F', '-e', stem]
  }

  const name = escaped(stem)
  const pattern = /\.(c|cc|cpp|h|hpp)$/i.test(path)
    ? `#include *["<]([^">]*/)?${name}\\.(h|hpp)[">]`
    : /\.py$/i.test(path)
      ? `^ *(from|import) ([^ ]*[.])?${name}( |,|[.]|$)|^ *from [^ ]+ import (.*[ ,])?${name}( |,|$)`
      : /\.rs$/i.test(path)
        ? `^ *(pub )?(mod|use) ([^;]*::)?${name}( |;|::|,|})`
        : /\.rb$/i.test(path)
          ? `require(_relative)?[ (]*['"]([^'"]*/)?${name}(\\.rb)?['"]`
          : `['"][^'"]*/${name}(\\.[A-Za-z]+)?['"]`

  return ['-E', '-e', pattern]
}

/** Only a source extension: `./billing.service` names `billing.service.ts`, so its `.service` stays. */
const withoutExtension = (path: string) => path.replace(/\.(d\.ts|[cm]?[jt]sx?|vue|svelte)$/i, '')

/** `spec` taken from `from`'s folder, with `.` and `..` worked out. */
function resolved(from: string, spec: string) {
  const parts: string[] = []

  for (const part of [...folderOf(from).split('/'), ...spec.split('/')]) {
    if (part === '..') parts.pop()
    else if (part !== '.' && part !== '') parts.push(part)
  }

  return parts.join('/')
}

/** Whether a quoted path on this line names `target`: a relative one must resolve to it, any other is taken on trust. */
function names(line: string, from: string, target: string) {
  const specs = [...line.matchAll(/['"]([^'"]+)['"]/g)].map(found => found[1] ?? '')

  return specs.some(spec =>
    spec.startsWith('.')
      ? withoutExtension(resolved(from, spec)) === withoutExtension(target)
      : withoutExtension(spec).endsWith(`/${stemOf(target)}`),
  )
}

/**
 * How many other files use `target`, from `git grep --full-name` lines (`file:text`) for `usersQuery`. A relative
 * import from a TypeScript or JavaScript file counts only when it resolves to `target`, so a `./pane` beside another
 * `pane.ts` does not.
 */
export function countUsers(grepOutput: string, target: string) {
  const users = new Set<string>()
  const isResolved = !BY_CLASS_NAME.test(target) && !/\.(c|cc|cpp|h|hpp|py|rs|rb)$/i.test(target)

  for (const line of grepOutput.split(/\r?\n/)) {
    const cut = line.indexOf(':')
    const from = line.slice(0, cut)

    if (cut > 0 && from !== target && (!isResolved || names(line.slice(cut + 1), from, target))) {
      users.add(from)
    }
  }

  return users.size
}

export const lineCount = (text: string) =>
  text === '' ? 0 : text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0)

const START_WITH = 5
const WIDELY_USED = 4

const sizeOf = (file: ChangedFile) => file.added + file.removed

/** Why a file deserves a first look, most telling first; undefined when only its size speaks for it. */
function concernOf(file: ChangedFile, flags: Flag[]): { rank: number; why: string } | undefined {
  const pointed = flags.filter(flag => flag.at?.path === file.path).map(flag => flag.label)

  if (SENSITIVE_PATH.test(file.path)) return { rank: 0, why: 'sensitive code: auth, secrets or permissions' }
  if (pointed.length > 0) return { rank: 1, why: `Jev: ${pointed.join(', ')}` }
  if (RISKY_PATH.test(file.path)) return { rank: 2, why: 'build, config or schema' }
  if ((file.usedBy ?? 0) >= WIDELY_USED) return { rank: 3, why: `used by ${file.usedBy} other files` }

  return undefined
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[^./]+$|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|cs|swift)$/i

/**
 * The files to inspect first and why: the ones with a concern, those Jev points at among them, then the biggest. Within
 * each step code comes before its tests, which make sense once the code is read.
 */
export function startWith(blast: Blast, flags: Flag[] = []): { file: ChangedFile; why: string }[] {
  const isTest = (file: ChangedFile) => (TEST_PATH.test(file.path) ? 1 : 0)
  const ranked = blast.files
    .map(file => ({ file, concern: concernOf(file, flags) }))
    .sort(
      (a, b) =>
        (a.concern?.rank ?? 4) - (b.concern?.rank ?? 4) || isTest(a.file) - isTest(b.file) || sizeOf(b.file) - sizeOf(a.file),
    )

  return ranked.slice(0, START_WITH).map(({ file, concern }) => ({
    file,
    why: concern?.why ?? (isTest(file) === 1 ? 'tests for the change' : file.isNew ? 'new file' : 'one of the biggest changes'),
  }))
}

const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

const sharedFolder = (common: string, folder: string): string =>
  common === '' || folder === common || folder.startsWith(`${common}/`) ? common : sharedFolder(folderOf(common), folder)

/**
 * The change split into groups a reviewer could take apart: by the first two folders, so `plugins/a` and `plugins/b`
 * stay apart, each narrowed to the deepest folder all its files share; root files read as `root`.
 */
export function groupsOf(files: ChangedFile[]): { name: string; files: number }[] {
  const byTop = new Map<string, string[]>()

  for (const { path } of files) {
    const top = folderOf(path).split('/').slice(0, 2).join('/')
    byTop.set(top, [...(byTop.get(top) ?? []), folderOf(path)])
  }

  return [...byTop.values()]
    .map(folders => {
      const shared = folders.reduce(sharedFolder)

      return { name: shared === '' ? 'root' : shared, files: folders.length }
    })
    .sort((a, b) => b.files - a.files)
}

export function blastOf(files: ChangedFile[]): Blast {
  const areas = [...new Set(files.map(file => (file.path.includes('/') ? file.path.split('/')[0] ?? '' : '.')))]
  const widest = [...files]
    .filter(file => (file.usedBy ?? 0) > 0)
    .sort((a, b) => (b.usedBy ?? 0) - (a.usedBy ?? 0))[0]

  return {
    files,
    lines: files.reduce((sum, file) => sum + file.added + file.removed, 0),
    areas,
    risky: files.filter(file => RISKY_PATH.test(file.path)).map(file => file.path),
    widest,
  }
}
