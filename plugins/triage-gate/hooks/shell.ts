// The shell splitting is adapted from prismantis (MIT), hooks/render.tsx:
// https://github.com/NahumLitvin/prismantis
import type { Scope } from '../types'

/** With `paths`, the commit takes what was staged before plus what `git add` stages from those paths. */
export type CommitCall = { cwd?: string; scope: Scope; paths?: string[] }

const HEREDOC = /<<(?!<)-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g
const SHELLS = new Set(['bash', 'sh', 'zsh', 'pwsh', 'powershell'])
const MOVES = new Set(['cd', 'pushd', 'set-location'])
const LEADING_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time'])
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])

function dropHeredocBodies(command: string): string {
  const lines = command.split('\n')
  const kept: string[] = []

  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? ''
    kept.push(line)

    for (const [, , end] of line.matchAll(HEREDOC)) {
      while (at + 1 < lines.length && (lines[at + 1] ?? '').trim() !== end) {
        at += 1
      }

      at += 1
    }
  }

  return kept.join('\n')
}

export function segmentsOf(source: string, isPosix: boolean): string[][] {
  const command = dropHeredocBodies(source)
  const segments: string[][] = [[]]
  let word = ''
  let quote = ''
  let isStarted = false

  const endWord = () => {
    if (isStarted) {
      segments[segments.length - 1]?.push(word)
    }

    word = ''
    isStarted = false
  }
  const endSegment = () => {
    endWord()
    segments.push([])
  }

  for (let at = 0; at < command.length; at += 1) {
    const char = command[at] ?? ''
    const next = command[at + 1] ?? ''

    if (quote !== '') {
      if (char === quote) {
        quote = ''
      } else if (isPosix && char === '\\' && quote === '"' && /[$`"\\]/.test(next)) {
        word += next
        at += 1
      } else {
        word += char
      }
    } else if (char === '"' || char === "'") {
      quote = char
      isStarted = true
    } else if (isPosix && char === '\\' && next === '\n') {
      at += 1
    } else if (isPosix && char === '\\' && next !== '') {
      word += next
      isStarted = true
      at += 1
    } else if (char === '\n' || char === ';' || char === '|' || char === '&' || char === '(' || char === ')') {
      endSegment()
    } else if (/\s/.test(char)) {
      endWord()
    } else {
      word += char
      isStarted = true
    }
  }

  endWord()

  return segments.filter(words => words.length > 0)
}

const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)

function commandWords(words: string[]): string[] {
  const from = words.findIndex(word => !isAssignment(word) && !LEADING_KEYWORDS.has(word))

  return from < 0 ? [] : words.slice(from)
}

const programOf = (word: string | undefined) =>
  (word ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    ?.replace(/\.exe$/i, '')
    .toLowerCase() ?? ''

const isAbsolute = (path: string) => /^([A-Za-z]:)?[\\/]/.test(path) || path.startsWith('~')

const under = (base: string | undefined, path: string | undefined) => {
  if (path === undefined) return base
  if (base === undefined || isAbsolute(path)) return path

  return `${base}/${path}`
}

function gitCall(args: string[]) {
  let dir: string | undefined
  let at = 0

  while (at < args.length && (args[at] ?? '').startsWith('-')) {
    const option = args[at] ?? ''

    if (option === '-C') {
      dir = under(dir, args[at + 1])
    }

    at += GIT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1
  }

  return { dir, verb: args[at], rest: args.slice(at + 1) }
}

const COMMIT_OPTIONS_WITH_VALUE = /^(-[a-zA-Z]*[mFCct]|--(message|file|author|date|fixup|squash|template|cleanup|reuse-message|reedit-message|trailer))$/

const commitsAll = (word: string) => word === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(word)

/** A redirection such as `<<EOF`, `2>/dev/null` or `>`; a bare operator takes the next word as its target. */
const REDIRECT = /^\d*(<<?-?|>>?)/
const isBareRedirect = (word: string) => /^\d*(<<?-?|>>?)$/.test(word)

function commitsWorkingTree(args: string[]): boolean {
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at] ?? ''

    if (REDIRECT.test(word)) {
      if (isBareRedirect(word)) at += 1
      continue
    }

    if (commitsAll(word) || word === '--' || /^(-[a-zA-Z]*[oi][a-zA-Z]*|--only|--include)$/.test(word)) return true
    if (COMMIT_OPTIONS_WITH_VALUE.test(word)) at += 1
    else if (!word.startsWith('-')) return true
  }

  return false
}

type Added = { scope: Scope; paths: string[] }

/** What `git add` stages. Anything it cannot place exactly counts as the whole tree. */
function addedBy(args: string[]): Added {
  const paths: string[] = []
  let isUpdate = false
  let isAll = false

  for (let at = 0; at < args.length; at += 1) {
    const word = args[at] ?? ''

    if (word === '--') {
      paths.push(...args.slice(at + 1))
      break
    }

    if (!word.startsWith('-')) paths.push(word)
    else if (word === '-u' || word === '--update') isUpdate = true
    else if (word === '-A' || word === '--all') isAll = true
    else if (/^(-[a-zA-Z]*[pie][a-zA-Z]*|--(patch|interactive|edit)|--pathspec-from-file.*)$/.test(word))
      return { scope: 'tree', paths: [] }
  }

  if (paths.length > 0) return { scope: 'tree', paths }

  return { scope: isUpdate && !isAll ? 'tracked' : 'tree', paths: [] }
}

/** The union of the adds before a commit; one that reaches the whole tree, or runs from another folder, wins. */
function joinAdds(adds: (Added & { dir?: string })[], commitDir: string | undefined): Pick<CommitCall, 'scope' | 'paths'> {
  if (adds.length === 0) return { scope: 'tree' }
  if (adds.some(add => add.paths.length === 0 || add.dir !== commitDir)) {
    return { scope: adds.every(add => add.scope === 'tracked' && add.dir === commitDir) ? 'tracked' : 'tree' }
  }

  return { scope: 'tree', paths: adds.flatMap(add => add.paths) }
}

export function commitIn(command: string, isPosix = true, cwd?: string): CommitCall | undefined {
  let dir = cwd
  const adds: (Added & { dir?: string })[] = []

  for (const words of segmentsOf(command, isPosix)) {
    const [name, ...rest] = commandWords(words)
    const program = programOf(name)

    if (MOVES.has(program)) {
      dir = under(dir, rest.find(word => !word.startsWith('-')))
    } else if (SHELLS.has(program)) {
      const script = rest[rest.findIndex(word => /^-(c|command)$/i.test(word)) + 1]
      const inner = script === undefined ? undefined : commitIn(script, isPosix, dir)

      if (inner !== undefined) return inner
    } else if (program === 'git') {
      const call = gitCall(rest)

      if (call.verb === 'add') adds.push({ ...addedBy(call.rest), dir: under(dir, call.dir) })

      if (call.verb === 'commit') {
        const commitDir = under(dir, call.dir)

        if (adds.length === 0) return { cwd: commitDir, scope: commitsWorkingTree(call.rest) ? 'tracked' : 'staged' }
        if (commitsWorkingTree(call.rest)) return { cwd: commitDir, scope: 'tree' }

        return { cwd: commitDir, ...joinAdds(adds, commitDir) }
      }
    }
  }

  return undefined
}
