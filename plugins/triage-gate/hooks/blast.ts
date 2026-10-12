import type { Blast, ChangedFile } from '../types'

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

export function stemOf(path: string): string | undefined {
  const name = path.split('/').pop() ?? path
  const stem = name.replace(/\.[^.]+$/, '')

  return !CODE_FILE.test(name) || stem.length < SHORTEST_STEM || TOO_GENERIC.has(stem.toLowerCase())
    ? undefined
    : stem
}

export const countUsers = (grepOutput: string, self: string) =>
  grepOutput
    .split(/\r?\n/)
    .filter(line => line.trim() !== '' && line.trim() !== self).length

export const lineCount = (text: string) =>
  text === '' ? 0 : text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0)

const START_WITH = 5
const WIDELY_USED = 4

const sizeOf = (file: ChangedFile) => file.added + file.removed

/** Why a file deserves a first look, most telling first; undefined when only its size speaks for it. */
function concernOf(file: ChangedFile): { rank: number; why: string } | undefined {
  if (SENSITIVE_PATH.test(file.path)) return { rank: 0, why: 'sensitive code: auth, secrets or permissions' }
  if (RISKY_PATH.test(file.path)) return { rank: 1, why: 'build, config or schema' }
  if ((file.usedBy ?? 0) >= WIDELY_USED) return { rank: 2, why: `used by ${file.usedBy} other files` }

  return undefined
}

/** The files to inspect first and why: the ones with a concern, then the biggest changes. */
export function startWith(blast: Blast): { file: ChangedFile; why: string }[] {
  const ranked = blast.files
    .map(file => ({ file, concern: concernOf(file) }))
    .sort((a, b) => (a.concern?.rank ?? 3) - (b.concern?.rank ?? 3) || sizeOf(b.file) - sizeOf(a.file))

  return ranked.slice(0, START_WITH).map(({ file, concern }) => ({
    file,
    why: concern?.why ?? (file.isNew ? 'new file' : 'one of the biggest changes'),
  }))
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
