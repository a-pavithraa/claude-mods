/**
 * Replays the Codex review prompt of two triage-gate versions on past changes, so a person can grade them blind.
 *
 *   bun eval/replay.ts run <cases.json> <out-dir> [--old <mods-ref>] [--only <case-id>] [--model <id>] [--effort <level>] [--dry-run]
 *   bun eval/replay.ts score <out-dir>
 *
 * Each case is a repository with a base and a head commit. The head's tree is checked out in a temporary
 * worktree and reset to the base, so the change is uncommitted, as it is when the gate runs Codex.
 * `run` writes sheet.md with the findings under labels A and B, and key.json, which says which label is which.
 * Tick the boxes in sheet.md, then `score` reads them and unblinds the result.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Finding } from '../types'
import { parseReview } from '../hooks/review'

type Case = {
  id: string
  repo: string
  base: string
  head: string
  kind: 'known-bug' | 'clean'
  /** One sentence naming the bug. Only a finding that describes it counts as found. */
  key?: string
  asks?: string[]
}

type Variant = { name: 'old' | 'new'; prompt: (asks: string[]) => string }

const MODS_ROOT = resolve(import.meta.dir, '../../..')
const REVIEW_TIMEOUT_MS = 20 * 60_000
const isWindows = process.platform === 'win32'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

type ReviewModule = { reviewPrompt: (judged: null, focus: string, intent: { asks: string[] }) => string }

async function variantsOf(oldRef: string, scratch: string): Promise<Variant[]> {
  const oldTree = join(scratch, 'mods-old')
  git(MODS_ROOT, 'worktree', 'add', '--detach', oldTree, oldRef)
  const older: ReviewModule = await import(join(oldTree, 'plugins/triage-gate/hooks/review.ts'))
  const newer: ReviewModule = await import('../hooks/review')

  return [
    { name: 'old', prompt: asks => older.reviewPrompt(null, '', { asks }) },
    { name: 'new', prompt: asks => newer.reviewPrompt(null, '', { asks }) },
  ]
}

function checkout(one: Case, scratch: string) {
  const tree = join(scratch, `case-${one.id}`)
  git(one.repo, 'worktree', 'add', '--detach', tree, one.head)
  git(tree, 'reset', '--soft', one.base)

  return tree
}

type Model = { model?: string; effort?: string }

async function codexReview(cwd: string, prompt: string, { model, effort }: Model) {
  const chosen = [
    ...(model === undefined ? [] : ['-m', model]),
    ...(effort === undefined ? [] : ['-c', `model_reasoning_effort=${effort}`]),
  ]
  const codex = ['codex', 'exec', 'review', ...chosen, '-']
  const child = Bun.spawn(isWindows ? ['cmd.exe', '/d', '/c', ...codex] : codex, {
    cwd,
    stdin: Buffer.from(prompt),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), REVIEW_TIMEOUT_MS)
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)

  return { text: stdout.trim() || stderr.trim(), code }
}

const shuffled = <T>(items: T[]) => (Math.random() < 0.5 ? items : [...items].reverse())

function sheetSection(one: Case, labelled: { label: string; findings: Finding[] }[]) {
  const lines = [`## ${one.id} (${one.kind})`, '', one.key === undefined ? 'Clean control: every finding counts against the prompt unless it is real.' : `Answer key: ${one.key}`, '']

  for (const { label, findings } of labelled) {
    lines.push(`### ${label}`, '')
    if (findings.length === 0) lines.push('No findings.', '')
    for (const finding of findings) {
      lines.push(`- [ ] real [ ] matches key | [${finding.priority}] ${finding.title} (${finding.at})`, `  ${finding.body}`, '')
    }
  }

  return lines.join('\n')
}

async function run(casesPath: string, out: string, oldRef: string, only: string | undefined, isDry: boolean, chosen: Model) {
  const cases = (JSON.parse(readFileSync(casesPath, 'utf8')) as Case[]).filter(one => only === undefined || one.id === only)
  mkdirSync(join(out, 'raw'), { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), 'replay-'))
  const variants = await variantsOf(oldRef, scratch)
  const key: Record<string, Record<string, string>> = existsSync(join(out, 'key.json'))
    ? JSON.parse(readFileSync(join(out, 'key.json'), 'utf8'))
    : {}
  const sections: string[] = []

  try {
    for (const one of cases) {
      const tree = checkout(one, scratch)
      const reviewed: { variant: Variant['name']; findings: Finding[] }[] = []

      try {
        for (const variant of variants) {
          const prompt = variant.prompt(one.asks ?? [])
          writeFileSync(join(out, 'raw', `${one.id}.${variant.name}.prompt.txt`), prompt)
          if (isDry) {
            console.log(`${one.id} ${variant.name}: ${git(tree, 'diff', '--cached', '--shortstat')}`)
            continue
          }
          const saved = join(out, 'raw', `${one.id}.${variant.name}.review.txt`)
          if (existsSync(saved)) {
            reviewed.push({ variant: variant.name, findings: parseReview(readFileSync(saved, 'utf8')).findings })
            console.log(`${one.id} ${variant.name}: reused the saved review`)
            continue
          }
          const startedAt = Date.now()
          const { text, code } = await codexReview(tree, prompt, chosen)
          if (code !== 0) {
            writeFileSync(join(out, 'raw', `${one.id}.${variant.name}.failed.txt`), text)
            throw new Error(`Codex failed on ${one.id} ${variant.name} (exit ${code}): ${text.split(/\r?\n/).filter(Boolean).pop() ?? ''}`)
          }
          writeFileSync(saved, text)
          const { findings } = parseReview(text)
          reviewed.push({ variant: variant.name, findings })
          console.log(`${one.id} ${variant.name}: ${findings.length} findings, exit ${code}, ${Math.round((Date.now() - startedAt) / 1000)}s`)
        }
      } finally {
        git(one.repo, 'worktree', 'remove', '--force', tree)
      }

      if (isDry) continue
      const kept = key[one.id]
      const order = kept === undefined ? shuffled(reviewed) : reviewed.toSorted((a, b) => (kept.A === a.variant ? -1 : kept.A === b.variant ? 1 : 0))
      const labelled = order.map((one, at) => ({ label: at === 0 ? 'A' : 'B', ...one }))
      key[one.id] = Object.fromEntries(labelled.map(({ label, variant }) => [label, variant]))
      sections.push(sheetSection(one, labelled))
    }
  } finally {
    git(MODS_ROOT, 'worktree', 'remove', '--force', join(scratch, 'mods-old'))
    rmSync(scratch, { recursive: true, force: true })
  }

  if (isDry) return
  writeFileSync(join(out, 'key.json'), JSON.stringify(key, null, 2))
  writeFileSync(join(out, 'sheet.md'), ['# Replay sheet', '', 'Tick "real" for a finding a maintainer would act on, and "matches key" when it describes the answer key. Do not open key.json until every case is ticked.', '', ...sections].join('\n'))
  console.log(`Wrote ${join(out, 'sheet.md')}`)
}

function score(out: string) {
  const key: Record<string, Record<string, string>> = JSON.parse(readFileSync(join(out, 'key.json'), 'utf8'))
  const totals: Record<string, { reported: number; real: number; cleanFlags: number; knownFound: number; known: number }> = {}
  let caseId = ''
  let kind = ''
  let label = ''
  const foundIn = new Set<string>()

  for (const line of readFileSync(join(out, 'sheet.md'), 'utf8').split(/\r?\n/)) {
    const heading = /^## (\S+) \((known-bug|clean)\)/.exec(line)
    if (heading !== null) {
      ;[caseId, kind] = [heading[1] ?? '', heading[2] ?? '']
      for (const variant of Object.values(key[caseId] ?? {})) {
        totals[variant] ??= { reported: 0, real: 0, cleanFlags: 0, knownFound: 0, known: 0 }
        if (kind === 'known-bug') totals[variant].known += 1
      }
      continue
    }
    const sub = /^### ([AB])$/.exec(line)
    if (sub !== null) {
      label = sub[1] ?? ''
      continue
    }
    const finding = /^- \[( |x)\] real \[( |x)\] matches key/i.exec(line)
    const variant = key[caseId]?.[label]
    if (finding === null || variant === undefined) continue
    const tally = totals[variant]
    if (tally === undefined) continue
    const isReal = finding[1]?.toLowerCase() === 'x'
    tally.reported += 1
    if (isReal) tally.real += 1
    if (kind === 'clean' && !isReal) tally.cleanFlags += 1
    if (kind === 'known-bug' && finding[2]?.toLowerCase() === 'x' && !foundIn.has(`${caseId}/${variant}`)) {
      foundIn.add(`${caseId}/${variant}`)
      tally.knownFound += 1
    }
  }

  for (const [variant, tally] of Object.entries(totals)) {
    const precision = tally.reported === 0 ? 'n/a' : `${Math.round((100 * tally.real) / tally.reported)}%`
    console.log(
      `${variant}: known bugs found ${tally.knownFound}/${tally.known}, real ${tally.real}/${tally.reported} (${precision}), false flags on clean changes ${tally.cleanFlags}`,
    )
  }
}

const [command, ...rest] = process.argv.slice(2)
const flag = (name: string) => {
  const at = rest.indexOf(name)

  return at === -1 ? undefined : rest[at + 1]
}

if (command === 'run' && rest[0] !== undefined && rest[1] !== undefined) {
  const model = flag('--model')
  const effort = flag('--effort')
  await run(rest[0], rest[1], flag('--old') ?? 'HEAD', flag('--only'), rest.includes('--dry-run'), {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  })
} else if (command === 'score' && rest[0] !== undefined) {
  score(rest[0])
} else {
  console.error('Usage: bun eval/replay.ts run <cases.json> <out-dir> [--old <mods-ref>] [--only <case-id>] [--model <id>] [--effort <level>] [--dry-run]\n       bun eval/replay.ts score <out-dir>')
  process.exit(2)
}
