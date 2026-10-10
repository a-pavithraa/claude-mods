import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { ChangedFile, Triage } from '../types'
import { reviewScope } from './review'

type World = {
  numstat: string
  grep?: Record<string, number>
  jev?: { status: number; answers?: Record<string, unknown> }
  key?: string
  hasNoHead?: boolean
  untracked?: string
  hashes?: string
  codexExit?: number
  draft?: string
}

const REVIEW = `The pager can report one page too many.

Full review comments:

- [P1] Fix the off-by-one in pageCount — src/pager.ts:12-14
  A list of exactly ten items reports two pages.
`

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const SURFACES = ['terminal', 'desktop'] as const

const noul = (value: number) => ({ type: 'noul', noul: value })

const CALM = {
  behaviour: noul(0.2),
  security: noul(0.05),
  data: noul(0.05),
  money: noul(0.02),
  concurrency: noul(0.05),
  publicApi: noul(0.1),
  tested: noul(0.8),
  mixed: noul(0.1),
  readability: { type: 'score', probabilities: { '0': 0.8, '1': 0.15, '2': 0.04, '3': 0.01 } },
}

const RISKY = {
  ...CALM,
  behaviour: noul(0.9),
  security: noul(0.86),
  tested: noul(0.1),
  readability: { type: 'score', probabilities: { '0': 0.1, '1': 0.2, '2': 0.4, '3': 0.3 } },
}

const PANE_PROPS = {
  title: 'Triage',
  isFocused: false,
  bodyColumns: 70,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

function world(on: On, w: World) {
  const seen = { fetched: 0, committed: 0, toasts: [] as string[], codexArgs: [] as string[], filled: [] as string[], git: [] as string[], cwds: [] as (string | undefined)[], codexInput: '', modes: [] as string[] }
  const ok = (stdout: string, exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.read', () => ({ value: { text: w.draft ?? '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    seen.filled.push(e.text)
    seen.modes.push(e.mode ?? 'replace')

    return { isFilled: true }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('env.get', ($, e) => ({ value: e.name === 'TYPESAFE_API_KEY' ? w.key : undefined }))
  on('fs.read', () => ({ value: '' }))
  on('tool.call', () => {
    seen.committed += 1

    return { result: 'ok' }
  })
  on('process.run', ($, e) => {
    const [, verb, ...rest] = e.argv

    seen.git.push([verb, ...rest].join(' '))
    seen.cwds.push(e.init?.cwd)

    if (verb === 'diff' && rest[0] === 'HEAD' && w.hasNoHead === true) return ok('', 128)
    if (verb === 'diff' && rest.includes('--numstat')) return ok(w.numstat)
    if (verb === 'diff') return ok('diff --git a/x b/x\n+changed')
    if (verb === 'ls-files') return ok(w.untracked ?? '')
    if (verb === 'hash-object') return ok(w.hashes ?? '')
    if (verb === 'grep') {
      const stem = rest.at(-1) ?? ''
      const count = w.grep?.[stem] ?? 0

      return ok(Array.from({ length: count }, (_, at) => `src/user${at}.ts`).join('\n'))
    }

    return ok('', 1)
  })
  on('process.spawn', async function* ($, e) {
    seen.codexArgs = [...e.argv]
    seen.codexInput = e.input ?? ''
    yield { stream: 'stderr' as const, text: 'reading src/pager.ts\n' }
    if (w.codexExit !== undefined) return { value: { code: w.codexExit, signal: null } }

    yield { stream: 'stdout' as const, text: REVIEW }

    return { value: { code: 0, signal: null } }
  })
  on('model.fork', () => ({ value: { isAnswered: true, text: 'Pages are counted from the item total.', usage: USAGE } }))
  on('http.fetch', () => {
    seen.fetched += 1

    return {
      value: {
        status: w.jev?.status ?? 200,
        ok: (w.jev?.status ?? 200) < 300,
        headers: {},
        text: JSON.stringify({ model: 'jev-1.13.0', answers: w.jev?.answers ?? CALM }),
      },
    }
  })

  return seen
}

const start = ($: Engine) =>
  $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

const commit = ($: Engine) =>
  $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m "change"' })

const triage = ($: Engine, args = '') =>
  $.command.run({
    command: 'gate',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

const mountPane = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({
    plugin: 'triage-gate',
    surface,
    component: 'Pane',
    requestId: 'triage-gate',
    props: PANE_PROPS,
  })

test('a small, calm change commits without a word', async ($, on) => {
  const seen = world(on, { numstat: '12\t3\tsrc/pager.ts\n', key: 'k' })
  await start($)
  const ran = await commit($)

  expect(ran.deny).toBeUndefined()
  expect(ran.isError).toBeUndefined()
  expect(seen.committed).toBe(1)
  expect(seen.fetched).toBe(1)
  expect(seen.toasts).toEqual([])
})

for (const surface of SURFACES) {
  test(`${surface}: a wide, risky change is held, shown, and lets through once approved`, async ($, on) => {
    const seen = world(on, {
      numstat: '220\t40\tsrc/auth/session.ts\n30\t2\tsrc/api/routes.ts\n5\t1\tpackage.json\n',
      grep: { session: 14 },
      jev: { status: 200, answers: RISKY },
      key: 'k',
    })
    await start($)
    const held = await commit($)
    expect(held.deny).toContain('triage-gate held this commit')
    expect(held.deny).toContain('Jev: likely touches security (0.86)')
    expect(held.deny).toContain('src/auth/session.ts is named by 14 other files')
    expect(seen.committed).toBe(0)

    const pane = await mountPane($, surface)

    expect(await pane.find({ text: /HOLD FOR REVIEW/ })).toBeDefined()
    expect(await pane.find({ text: /touches build, config or schema: package.json/ })).toBeDefined()

    await pane.press({ key: 'approve' })
    const second = await commit($)

    expect(second.deny).toBeUndefined()
    expect(seen.committed).toBe(1)
  })
}

test('a middling change commits but is flagged for reading', async ($, on) => {
  const seen = world(on, {
    numstat: '60\t5\tsrc/a.ts\n60\t5\tsrc/b.ts\n40\t5\tsrc/c.ts\n20\t2\tsrc/d.ts\n10\t1\tsrc/e.ts\n',
    key: 'k',
  })
  await start($)
  await commit($)

  expect(seen.committed).toBe(1)
  expect(seen.toasts[0]).toContain('Committed, but worth reading: 208 lines changed; 5 files changed')
})

test('without a key it judges blast radius alone and never calls Jev', async ($, on) => {
  const seen = world(on, { numstat: '12\t3\tsrc/pager.ts\n' })
  await start($)

  expect((await triage($)).text).toBe('NO REVIEW TRIGGER (risk 0)')
  expect(seen.fetched).toBe(0)

  const pane = await mountPane($, 'terminal')

  expect(await pane.find({ text: /Not configured/ })).toBeDefined()
})

test('a refused key is reported, not fatal', async ($, on) => {
  world(on, { numstat: '12\t3\tsrc/pager.ts\n', jev: { status: 401 }, key: 'bad' })
  await start($)
  await triage($)

  const pane = await mountPane($, 'terminal')

  expect(await pane.find({ text: /refused the API key/ })).toBeDefined()
})

test('commands other than a commit pass straight through', async ($, on) => {
  const seen = world(on, { numstat: '900\t0\tsrc/huge.ts\n', key: 'k' })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'git status' })

  expect(seen.committed).toBe(1)
  expect(seen.fetched).toBe(0)
})

test('a Codex review lands in the pane', async ($, on) => {
  const seen = world(on, { numstat: '12\t3\tsrc/pager.ts\n', key: 'k' })
  await start($)
  await triage($)

  expect((await triage($, 'codex')).text).toContain('Codex found 1 problem')
  expect(seen.codexArgs).toEqual(['codex', 'exec', 'review', '-'])

  const pane = await mountPane($, 'desktop')

  expect(await pane.find({ text: /Fix the off-by-one in pageCount/ })).toBeDefined()
  expect(await pane.find({ text: /src\/pager\.ts:12-14/ })).toBeDefined()
})

test('the findings of a Codex review can be sent to Claude to fix', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '12\t3\tsrc/pager.ts\n', key: 'k' })
  await start($)
  await triage($)
  await triage($, 'codex')
  const pane = await mountPane($, 'desktop')

  // #when
  await pane.press({ key: 'fix' })

  // #then
  expect(seen.filled).toEqual([expect.stringContaining('[P1] Fix the off-by-one in pageCount (src/pager.ts:12-14)')])
})

const write = ($: Engine, path: string, lines: number) =>
  $.tool.call({
    tool: 'Write',
    file_path: path,
    content: Array.from({ length: lines }, (_, at) => `line ${at}`).join('\n'),
  })

const finish = ($: Engine) =>
  $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 'turn-1', reason: 'answer' })

const guide = ($: Engine) =>
  $.command.run({
    command: 'guide',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

test('an uncommitted change that passes a size level is called out once when the turn ends', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '150\t20\tsrc/big.ts\n40\t0\tsrc/other.ts\n' })
  await start($)

  // #when
  await finish($)
  await finish($)

  // #then
  expect(seen.toasts).toEqual([
    'Uncommitted change is now 210 lines in 2 files. Commit a slice, or run /gate to see the risk.',
  ])
})

test('the size alert fires again at the next level', async ($, on) => {
  // #given
  const w = { numstat: '200\t0\tsrc/big.ts\n' }
  const seen = world(on, w)
  await start($)
  await finish($)

  // #when
  w.numstat = '450\t0\tsrc/big.ts\n'
  await finish($)

  // #then
  expect(seen.toasts).toHaveLength(2)
})

test('the size alert never sends the change to Jev', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '900\t0\tsrc/huge.ts\n', key: 'k' })
  await start($)

  // #when
  await finish($)

  // #then
  expect(seen.fetched).toBe(0)
})

test('/guide puts a reading-guide request naming the files of the turn in the prompt box', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '' })
  await start($)
  await write($, '/work/src/big.ts', 120)
  await write($, '/work/src/other.ts', 80)

  // #when
  await guide($)

  // #then
  expect(seen.filled).toEqual([expect.stringContaining('/work/src/big.ts\n/work/src/other.ts')])
})

test('a small uncommitted change ends the turn quietly', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '20\t3\tsrc/small.ts\n' })
  await start($)

  // #when
  await finish($)

  // #then
  expect(seen.toasts).toEqual([])
})

test('/guide forgets the files of an earlier prompt', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '' })
  await start($)
  await write($, '/work/src/old.ts', 140)

  // #when
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  await write($, '/work/src/new.ts', 20)
  await guide($)

  // #then
  expect(seen.filled[0]).not.toContain('/work/src/old.ts')
})

test('a commit in another folder is judged in that folder', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '12\t3\tsrc/pager.ts\n' })
  await start($)

  // #when
  await $.tool.call({ tool: 'Bash', command: 'cd ../other && git -C api commit -m "change"' })

  // #then
  expect(new Set(seen.cwds)).toEqual(new Set(['../other/api']))
})

test('the first commit of a repository is still triaged', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '900\t0\tsrc/huge.ts\n', key: 'k', hasNoHead: true })
  await start($)

  // #when
  await commit($)

  // #then
  expect(seen.fetched).toBe(1)
})

test('an approval does not cover a later edit to an untracked file', async ($, on) => {
  // #given
  const w = { numstat: '900\t0\tsrc/huge.ts\n', key: 'k', jev: { status: 200, answers: RISKY }, untracked: 'notes.md', hashes: 'aaa' }
  world(on, w)
  await start($)
  await commit($)
  await triage($, 'approve')

  // #when
  w.hashes = 'bbb'
  const ran = await commit($)

  // #then
  expect(ran.deny).toContain('held this commit')
})

test('commit text inside a heredoc body is not a commit', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '900\t0\tsrc/huge.ts\n', key: 'k' })
  await start($)

  // #when
  await $.tool.call({ tool: 'Bash', command: "cat > notes.md <<'EOF'\ngit commit -m later\nEOF" })

  // #then
  expect(seen.fetched).toBe(0)
})

test('a commit run through bash -c is gated', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '12\t3\tsrc/pager.ts\n', key: 'k' })
  await start($)

  // #when
  await $.tool.call({ tool: 'Bash', command: 'bash -c "git commit -m change"' })

  // #then
  expect(seen.fetched).toBe(1)
})

const run = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })

test('a plain commit is judged on what is staged, not the whole working tree', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '12\t3\tsrc/pager.ts\n' })
  await start($)

  // #when
  await run($, 'git commit -m "change"')

  // #then
  expect(seen.git).toEqual(['diff --cached --numstat', 'diff --cached', 'grep -l -w -F -e pager'])
})

test('commit -a is judged on tracked changes, without untracked files', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '12\t3\tsrc/pager.ts\n' })
  await start($)

  // #when
  await run($, 'git commit -am "change"')

  // #then
  expect(seen.git).toEqual(['diff HEAD --numstat', 'diff HEAD', 'grep -l -w -F -e pager'])
})

test('a commit that names a file is judged on the working tree, not the index', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '12\t3\tsrc/pager.ts\n' })
  await start($)

  // #when
  await run($, 'git commit -m "change" -- src/pager.ts')

  // #then
  expect(seen.git[0]).toBe('diff HEAD --numstat')
})

test('a Codex review is marked stale once the change is edited', async ($, on) => {
  // #given
  const w = { numstat: '12\t3\tsrc/pager.ts\n', key: 'k', untracked: 'notes.md', hashes: 'aaa' }
  world(on, w)
  await start($)
  await triage($)
  await triage($, 'codex')

  // #when
  w.hashes = 'bbb'
  await triage($)
  const pane = await mountPane($, 'desktop')

  // #then
  expect(await pane.find({ text: /edited since this review/ })).toBeDefined()
})

test('a commit behind global git options is still gated', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '12\t3\tsrc/pager.ts\n', key: 'k' })
  await start($)

  // #when
  await run($, 'git --no-pager -C repo commit -m "change"')

  // #then
  expect(seen.fetched).toBe(1)
})

test('git commit-graph is not mistaken for a commit', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '900\t0\tsrc/huge.ts\n', key: 'k' })
  await start($)

  // #when
  await run($, 'git commit-graph write')

  // #then
  expect(seen.fetched).toBe(0)
})

test('a quoted mention of a commit is not gated', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '900\t0\tsrc/huge.ts\n', key: 'k' })
  await start($)

  // #when
  await run($, 'echo "git commit"')

  // #then
  expect(seen.fetched).toBe(0)
})

test('Codex is told which files to review and what to focus on', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '12\t3\tsrc/pager.ts\n', key: 'k' })
  await start($)
  await triage($)

  // #when
  await triage($, 'codex the page count maths')

  // #then
  expect(seen.codexInput).toContain('Review only these files, and read others only when one of these calls them:\nsrc/pager.ts')
  expect(seen.codexInput).toContain('Focus on: the page count maths')
})

test('Codex is told what the user asked for and what was built', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '12\t3\tsrc/pager.ts\n', key: 'k' })
  await start($)
  await $.prompt.submit({ text: 'make the pager count the last partial page', wait: false, origin: { kind: 'composer' } })
  await triage($)

  // #when
  await triage($, 'codex')

  // #then
  expect(seen.codexInput).toContain('> make the pager count the last partial page')
  expect(seen.codexInput).toContain('Pages are counted from the item total.')
})

test('a one-line auth change is reviewed even when 15 larger files changed', () => {
  // #given
  const big = (at: number): ChangedFile => ({ path: `src/feature/part${at}.ts`, added: 100 + at, removed: 0, isNew: false })
  const files = [...Array.from({ length: 15 }, (_, at) => big(at)), { path: 'src/auth/guard.ts', added: 1, removed: 1, isNew: false }]
  const judged: Triage = {
    fingerprint: 'f',
    verdict: 'hold',
    points: 5,
    reasons: [],
    blast: { files, lines: 0, areas: [], risky: [] },
    jev: { status: 'off' },
    isPatchCut: false,
  }

  // #when
  const scope = reviewScope(judged, '')

  // #then
  expect([scope.files[0], scope.files.length, scope.label]).toEqual([
    'src/auth/guard.ts',
    15,
    '15 of 16 changed files, flagged ones first, then the largest',
  ])
})

test('a failed Codex run is reported as failed, not as a clean review', async ($, on) => {
  // #given
  world(on, { numstat: '12\t3\tsrc/pager.ts\n', key: 'k', codexExit: 1 })
  await start($)
  await triage($)

  // #when
  const ran = await triage($, 'codex')

  // #then
  expect(ran.text).toBe('Codex review failed; it listed no findings. See the Triage pane.')
})

test('a Codex review run before any triage still shows in the pane', async ($, on) => {
  // #given
  world(on, { numstat: '12\t3\tsrc/pager.ts\n', key: 'k' })
  await start($)

  // #when
  await triage($, 'codex')
  const pane = await mountPane($, 'desktop')

  // #then
  expect(await pane.find({ text: /Codex found 1 problem/ })).toBeDefined()
})

test('an edit by Claude marks a finished Codex review stale without a new triage', async ($, on) => {
  // #given
  world(on, { numstat: '12\t3\tsrc/pager.ts\n', key: 'k' })
  await start($)
  await triage($)
  await triage($, 'codex')

  // #when
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/pager.ts', old_string: 'a', new_string: 'b' })
  const pane = await mountPane($, 'desktop')

  // #then
  expect(await pane.find({ text: /edited since this review/ })).toBeDefined()
})

test('a one-line change to auth code is flagged for reading even without Jev', async ($, on) => {
  // #given
  world(on, { numstat: '1\t1\tsrc/auth/guard.ts\n' })
  await start($)

  // #when
  const ran = await triage($)

  // #then
  expect(ran.text).toBe('READ IT (risk 0): changes sensitive code: src/auth/guard.ts')
})

test('/guide adds to a draft in the prompt box instead of replacing it', async ($, on) => {
  // #given
  const seen = world(on, { numstat: '', draft: 'also check the pager' })
  await start($)
  await write($, '/work/src/big.ts', 120)

  // #when
  await guide($)

  // #then
  expect(seen.modes).toEqual(['append'])
})

test('a verdict from local checks alone says so under the badge', async ($, on) => {
  // #given
  world(on, { numstat: '12\t3\tsrc/pager.ts\n' })
  await start($)
  await triage($)

  // #when
  const pane = await mountPane($, 'desktop')

  // #then
  expect(await pane.find({ text: /Local checks only: size, spread and file paths/ })).toBeDefined()
})
