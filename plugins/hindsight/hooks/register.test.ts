import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { costText, withPointer } from './propose'
import { addAsked, addOutput, addReached, addRun, addTiming, addWrite, areaOf, commandKey, emptyLog, focusOf, signalsOf, targetKey } from './signals'

const USAGE = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0 }

type World = { fix: string; claudeMd?: string; box?: string; size?: number; stored?: Record<string, unknown> }

function world(on: On, w: World) {
  const seen = { session: 's1', forks: 0, prompts: [] as string[], written: [] as string[], filled: [] as string[], toasts: [] as string[] }
  mock.store(on, w.stored)
  const clock = mock.clock(on)

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/work' }))
  on('session.id', () => ({ value: seen.session }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('model.fork', ($, e) => {
    seen.forks += 1
    seen.prompts.push(e.prompt)

    return { value: { isAnswered: true, text: w.fix, usage: USAGE } }
  })
  on('fs.exists', ($, e) => ({ value: e.path === '/work/CLAUDE.md' && w.claudeMd !== undefined }))
  on('fs.read', () => ({ value: w.claudeMd ?? '' }))
  on('fs.stat', () => ({ value: { kind: 'file', size: w.size ?? 30_000, mtimeMs: 0 } }))
  on('fs.list', () => ({
    value: [
      { name: 'big.ts', kind: 'file', size: w.size ?? 30_000, mtimeMs: 0 },
      { name: 'small.ts', kind: 'file', size: 900, mtimeMs: 0 },
    ],
  }))
  on('fs.write', ($, e) => {
    seen.written.push(e.text)

    return { value: undefined }
  })
  on('prompt.read', () => ({ value: { text: w.box ?? '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    seen.filled.push(e.text)

    return { isFilled: true }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('tool.check', ($, e) => ({
    decision: typeof e.input === 'object' && e.input !== null && String((e.input as { command?: unknown }).command).includes('ask') ? 'ask' : 'allow',
  }))
  on('tool.call', async ($, e) => {
    if ('command' in e && String(e.command).includes('slow')) await clock.advance(90_000)

    const isFailing = 'command' in e && String(e.command).includes('fail')
    const isBig = 'file_path' in e && String(e.file_path).includes('big')

    return { result: 'ok', text: isFailing ? 'FAIL' : isBig ? 'x'.repeat(25_000) : 'ok', ...(isFailing ? { isError: true } : {}) }
  })

  return { seen, clock }
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

const band = ($: Engine, isWorking = false) =>
  $.ui.mount({
    plugin: 'hindsight',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking,
      maxRows: 10,
      bodyColumns: 160,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  })

async function spiralTurn($: Engine, turnId: string) {
  await $.turn.start({ text: 'where is the hook code?', turnId })

  for (let at = 0; at < 10; at += 1) {
    await $.tool.call({ tool: 'Read', file_path: `/work/plugins/x/hooks/file${at}.ts` })
  }

  await $.tool.call({ tool: 'Edit', file_path: '/work/plugins/x/hooks/file0.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId, reason: 'answer' })
}

async function bigReadTurn($: Engine, turnId: string, isEdited = false) {
  await $.turn.start({ text: 'change the hook', turnId })
  await $.tool.call({ tool: 'Read', file_path: '/work/plugins/x/hooks/big.ts' })

  if (isEdited) await $.tool.call({ tool: 'Edit', file_path: '/work/plugins/x/hooks/big.ts', old_string: 'a', new_string: 'b' })

  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId, reason: 'answer' })
}

async function fixLoopTurn($: Engine, turnId: string) {
  await $.turn.start({ text: 'make the tests pass', turnId })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail' })
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId, reason: 'answer' })
}

test('a command key is its first plain words', () => {
  expect(commandKey('cd /work && npm test -- --watch')).toBe('npm test')
  expect(commandKey('claude plugin test plugins/hindsight')).toBe('claude plugin test')
  expect(commandKey('FOO=1 pytest tests/a.py -q')).toBe('pytest')
})

test('an area is the file itself, relative to the root', () => {
  expect(areaOf('D:\\work\\plugins\\x\\hooks\\register.tsx', 'D:/work')).toBe('plugins/x/hooks/register.tsx')
})

test('an area outside the root hides the hash folders that change between installs', () => {
  const path = 'C:\\Temp\\claude\\bundled-skills\\2.1.296\\9bdd2812c3c92bdeb5ff57dc7de657bf\\types\\claude-code.d.ts'
  expect(areaOf(path, 'D:/work')).toBe('C:/Temp/claude/bundled-skills/2.1.296/*/types/claude-code.d.ts')
})

test('a spiral names the file searched again and again', () => {
  expect(focusOf(['a/types.d.ts', 'b/x.ts', 'a/types.d.ts'])).toBe('a/types.d.ts')
})

test('a spiral over different files names the folder they share', () => {
  expect(focusOf(['plugins/x/hooks/a.ts', 'plugins/x/hooks/b.ts', 'plugins/x/types/c.ts'])).toBe('plugins/x')
})

test('a big shell output is named by each program and its target', () => {
  expect(targetKey('cd /work && cat HANDOFF.md; ls plugins; ls -R "/c/skills/html-plan"')).toBe('cat HANDOFF.md, ls plugins, ls html-plan')
})

test('a big read followed by an edit of the same file is not a snag', () => {
  // #given a whole-file read over the limit
  const read = addOutput(emptyLog(), { area: 'Read a.ts', call: 'Read D:\\work\\a.ts', path: 'D:\\work\\a.ts' }, 30_000)

  // #when the same file is edited in that turn, spelt with forward slashes
  const edited = addWrite(read, 'd:/work/a.ts')

  // #then nothing is reported
  expect(signalsOf(edited)).toEqual([])
})

test('a failure repeated without an edit between is not a fix loop', () => {
  const twice = addRun(addRun(emptyLog(), 'npm test', true), 'npm test', true)
  expect(signalsOf(twice)).toEqual([])

  const fixed = addRun(addWrite(addRun(emptyLog(), 'npm test', true)), 'npm test', true)
  expect(signalsOf(fixed)).toEqual([{ kind: 'fix-loop', area: 'npm test', call: 'npm test', cost: 2 }])
})

test('a pointer goes in one marked section, once', () => {
  const first = withPointer('# Repo\n', 'Hook code: plugins/x/hooks') ?? ''
  expect(first).toContain('<!-- hindsight: navigation pointers (edit freely) -->\n- Hook code: plugins/x/hooks\n<!-- end hindsight -->')
  expect(withPointer(first, 'Hook code: plugins/x/hooks')).toBe(first)
  expect(withPointer(`${first}<!-- end hindsight -->\n`, 'Other')).toBeUndefined()
})

test('one spiral only watches; the same spiral in a second session offers a pointer to save', async ($, on) => {
  const { seen, clock } = world(on, {
    fix: '{"fix": "pointer", "text": "Mod hook code: plugins/<mod>/hooks/register.tsx"}',
    claudeMd: '# Repo\n',
  })
  await start($)
  await spiralTurn($, 't1')
  await clock.settle()

  expect(seen.forks).toBe(0)
  expect(await (await band($)).find({ text: /hindsight/ })).toBeUndefined()

  seen.session = 's2'
  await spiralTurn($, 't2')
  await clock.settle()

  expect(seen.forks).toBe(1)

  const shown = await band($)
  expect(await shown.find({ text: /hindsight · seen in 2 sessions, 10 searches a session: 10 or more searches in plugins\/x\/hooks/ })).toBeDefined()
  expect(await shown.find({ text: /Add to \.\/CLAUDE\.md: "Mod hook code/ })).toBeDefined()

  await shown.press({ key: 'act' })

  expect(seen.written[0]).toContain('- Mod hook code: plugins/<mod>/hooks/register.tsx')
  expect(await (await band($)).find({ text: /hindsight/ })).toBeUndefined()
})

test('a fix loop offers a task, and the press puts it in the prompt box', async ($, on) => {
  const { seen, clock } = world(on, { fix: '{"fix": "check", "text": "Add a pre-commit hook that runs npm test."}' })
  await start($)
  await fixLoopTurn($, 't1')
  seen.session = 's2'
  await fixLoopTurn($, 't2')
  await clock.settle()

  const shown = await band($)
  expect(await shown.find({ key: 'act', text: 'Put task in prompt' })).toBeDefined()

  await shown.press({ key: 'act' })

  expect(seen.filled[0]).toContain('Make this change: Add a pre-commit hook that runs npm test.')
  expect(seen.written).toEqual([])
})

test('the row hides while Claude works, and Skip drops it', async ($, on) => {
  const { seen, clock } = world(on, { fix: '{"fix": "check", "text": "Add a pre-commit hook that runs npm test."}' })
  await start($)
  await fixLoopTurn($, 't1')
  seen.session = 's2'
  await fixLoopTurn($, 't2')
  await clock.settle()

  expect(await (await band($, true)).find({ text: /hindsight/ })).toBeUndefined()

  const shown = await band($)
  await shown.press({ key: 'skip' })

  expect(await (await band($)).find({ text: /hindsight/ })).toBeUndefined()
})

test('a fork that finds no fix shows nothing', async ($, on) => {
  const { seen, clock } = world(on, { fix: '{"fix": "none", "text": ""}' })
  await start($)
  await spiralTurn($, 't1')
  seen.session = 's2'
  await spiralTurn($, 't2')
  await clock.settle()

  expect(seen.forks).toBe(1)
  expect(await (await band($)).find({ text: /hindsight/ })).toBeUndefined()
})

test('a fix loop that comes back in a later session reopens, and the fork hears what was tried', async ($, on) => {
  // #given a fix sent to the prompt box in session 2
  const { seen, clock } = world(on, { fix: '{"fix": "check", "text": "Add a pre-commit hook that runs npm test."}' })
  await start($)
  await fixLoopTurn($, 't1')
  seen.session = 's2'
  await fixLoopTurn($, 't2')
  await clock.settle()
  await (await band($)).press({ key: 'act' })

  // #when the same loop happens again in that session, then in session 3
  await fixLoopTurn($, 't3')
  await clock.settle()
  expect(seen.forks).toBe(1)

  seen.session = 's3'
  await fixLoopTurn($, 't4')
  await clock.settle()

  // #then it is judged again with the earlier fix ruled out, and the row says it came back
  expect(seen.forks).toBe(2)
  expect(seen.prompts[1]).toContain('Do not propose them again:\n- Add a pre-commit hook that runs npm test.')
  expect(await (await band($)).find({ text: /hindsight · back after a fix: `npm test fail` failed/ })).toBeDefined()
})

test('a skipped snag is proposed again once it comes back in two more sessions', async ($, on) => {
  // #given a fix loop proposed in session 2 and skipped
  const { seen, clock } = world(on, { fix: '{"fix": "check", "text": "Add a pre-commit hook that runs npm test."}' })
  await start($)
  await fixLoopTurn($, 't1')
  seen.session = 's2'
  await fixLoopTurn($, 't2')
  await clock.settle()
  await (await band($)).press({ key: 'skip' })

  // #when it comes back in session 3, then in session 4
  seen.session = 's3'
  await fixLoopTurn($, 't3')
  await clock.settle()
  const afterOne = seen.forks
  seen.session = 's4'
  await fixLoopTurn($, 't4')
  await clock.settle()

  // #then only the second return asks for a new proposal
  expect([afterOne, seen.forks]).toEqual([1, 2])
})

test('a big read seen in two sessions is proposed with the folder sizes', async ($, on) => {
  // #given a file still over the limit
  const { seen, clock } = world(on, { fix: '{"fix": "economy", "text": "Read big.ts in parts."}' })
  await start($)

  // #when it is read whole in two sessions
  await bigReadTurn($, 't1')
  seen.session = 's2'
  await bigReadTurn($, 't2')
  await clock.settle()

  // #then the fork hears the current sizes
  expect(seen.prompts[0]).toContain('- big.ts 30,000\n- small.ts 900\nA proposed check must pass')
})

test('a big read whose file has shrunk since is not proposed', async ($, on) => {
  // #given a file split under the limit after the first session
  const { seen, clock } = world(on, { fix: '{"fix": "economy", "text": "Read big.ts in parts."}', size: 12_000 })
  await start($)

  // #when the old read comes back in a second session
  await bigReadTurn($, 't1')
  seen.session = 's2'
  await bigReadTurn($, 't2')
  await clock.settle()

  // #then no fork runs
  expect(seen.forks).toBe(0)
})

test('reading a file whole to edit it is never a snag', async ($, on) => {
  // #given two sessions that each read a big file and then edit it
  const { seen, clock } = world(on, { fix: '{"fix": "economy", "text": "Read big.ts in parts."}' })
  await start($)
  await bigReadTurn($, 't1', true)
  seen.session = 's2'
  await bigReadTurn($, 't2', true)
  await clock.settle()

  // #when /hindsight lists the repo's snags
  const ran = await $.command.run({ command: 'hindsight', args: '', origin: { kind: 'user' }, presentation: 'text' })

  // #then there are none
  expect(ran.text).toBe('hindsight has seen no snags in this repo yet.')
})

test('/hindsight hands the retro each snag with the call that showed it in each session', async ($, on) => {
  // #given a fix loop in two sessions
  const { seen, clock } = world(on, { fix: '{"fix": "check", "text": "Add a pre-commit hook that runs npm test."}' })
  await start($)
  await fixLoopTurn($, 't1')
  seen.session = 's2'
  await fixLoopTurn($, 't2')
  await clock.settle()

  // #when /hindsight runs
  await $.command.run({ command: 'hindsight', args: '', origin: { kind: 'user' }, presentation: 'text' })

  // #then the retro prompt carries the evidence
  expect(seen.filled[0]).toContain('  - session s1: npm test -- fail\n  - session s2: npm test -- fail')
})

test('the same command failing three times with no edit between is a blind retry', () => {
  // #given three failures of one command and nothing changed between them
  const thrice = addRun(addRun(addRun(emptyLog(), 'python -I fix.py', true), 'python -I fix.py', true), 'python -I fix.py', true)

  // #then it is a retry, not a fix loop
  expect(signalsOf(thrice)).toEqual([{ kind: 'retry', area: 'python', call: 'python -I fix.py', cost: 3 }])
})

test('three different scripts failing under one program are not a blind retry', () => {
  // #given three failures that share the key "python" but run different scripts
  const tried = ['first.py', 'second.py', 'third.py'].reduce((log, script) => addRun(log, `python -I ${script}`, true), emptyLog())

  // #then nothing is reported
  expect(signalsOf(tried)).toEqual([])
})

test('a red, edit, red, edit, green test cycle is not a blind retry', () => {
  // #given failures that each follow an edit, then a pass
  const red = addRun(emptyLog(), 'npm test', true)
  const cycle = addRun(addWrite(addRun(addWrite(red), 'npm test', true)), 'npm test', false)

  // #then nothing is reported
  expect(signalsOf(cycle)).toEqual([])
})

test('a call over a minute is slow, and its seconds are the cost', () => {
  const slow = addTiming(emptyLog(), { area: 'Bash npm install', call: 'Bash: npm install' }, 95_000)
  expect(signalsOf(slow)).toEqual([{ kind: 'slow', area: 'Bash npm install', call: 'Bash: npm install → 95s', cost: 95 }])
})

test('a call put to the prompt that then ran is not a refusal', () => {
  const ran = addReached(addAsked(emptyLog(), 'u1', { area: 'Bash git push', call: 'Bash: git push' }), 'u1')
  expect(signalsOf(ran)).toEqual([])
})

test('the same call refused twice in a turn is one refusal costing two', () => {
  // #given two asks for one command that never ran
  const call = { area: 'Bash git push', call: 'Bash: git push' }
  const refused = addAsked(addAsked(emptyLog(), 'u1', call), 'u2', call)

  // #then one signal with both counted
  expect(signalsOf(refused)).toEqual([{ kind: 'denied', area: 'Bash git push', call: 'Bash: git push', cost: 2 }])
})

test('a cost reads in its unit, tokens rounded to thousands', () => {
  expect([costText('big-output', 7123.4), costText('big-output', 27_300), costText('slow', 1)]).toEqual([
    '~7,123 tokens',
    '~27k tokens',
    '1 second',
  ])
})

async function slowTurn($: Engine, turnId: string) {
  await $.turn.start({ text: 'install', turnId })
  await $.tool.call({ tool: 'Bash', command: 'npm install slow' })
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId, reason: 'answer' })
}

async function refusedTurn($: Engine, turnId: string) {
  await $.turn.start({ text: 'push it', turnId })
  await $.tool.check({ tool: 'Bash', input: { command: 'git push ask' } })
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId, reason: 'answer' })
}

test('a slow command in two sessions is proposed with what it means', async ($, on) => {
  // #given a command that takes 90 seconds
  const { seen, clock } = world(on, { fix: '{"fix": "economy", "text": "Run npm install with --prefer-offline."}' })
  await start($)

  // #when it runs in two sessions
  await slowTurn($, 't1')
  seen.session = 's2'
  await slowTurn($, 't2')
  await clock.settle()

  // #then the fork is told it blocks the turn, and the row shows the time
  expect(seen.prompts[0]).toContain('A slow call blocks the turn')
  expect(await (await band($)).find({ text: /hindsight · seen in 2 sessions, 90 seconds a session: a call that took over a minute: Bash npm install/ })).toBeDefined()
})

test('a fix that stays quiet for five sessions is held, with what the snag cost before', async ($, on) => {
  // #given a fix loop proposed in session 2 and its fix sent
  const { seen, clock } = world(on, { fix: '{"fix": "check", "text": "Add a pre-commit hook that runs npm test."}' })
  await start($)
  await fixLoopTurn($, 't1')
  seen.session = 's2'
  await fixLoopTurn($, 't2')
  await clock.settle()
  await (await band($)).press({ key: 'act' })

  // #when five more sessions start without it
  for (const session of ['s3', 's4', 's5', 's6', 's7']) {
    seen.session = session
    await start($)
  }

  // #then /hindsight says the fix held, and what it cost before
  const ran = await $.command.run({ command: 'hindsight', args: '', origin: { kind: 'user' }, presentation: 'text' })
  expect(ran.text).toContain('Fixes that held (1):\n  · `npm test fail` failed, was fixed by an edit, and failed again — quiet for 5 sessions since the fix; was 2 failures a session')
})

test('a fix four sessions old is still waiting, not held', async ($, on) => {
  // #given the same sent fix
  const { seen, clock } = world(on, { fix: '{"fix": "check", "text": "Add a pre-commit hook that runs npm test."}' })
  await start($)
  await fixLoopTurn($, 't1')
  seen.session = 's2'
  await fixLoopTurn($, 't2')
  await clock.settle()
  await (await band($)).press({ key: 'act' })

  // #when only four sessions start, one of them twice
  for (const session of ['s3', 's4', 's4', 's5', 's6']) {
    seen.session = session
    await start($)
  }

  // #then it is still sent
  const ran = await $.command.run({ command: 'hindsight', args: '', origin: { kind: 'user' }, presentation: 'text' })
  expect(ran.text).toContain('Fix in progress: held after 5 sessions without the snag (1):\n  · `npm test fail` failed, was fixed by an edit, and failed again — fix sent; 4 of 5 clean sessions')
})

test('/hindsight groups snags by what happens next and says how often each was seen', async ($, on) => {
  // #given one fix loop seen once
  const { clock } = world(on, { fix: '{"fix": "check", "text": "Add a pre-commit hook that runs npm test."}' })
  await start($)
  await fixLoopTurn($, 't1')
  await clock.settle()

  // #when /hindsight runs
  const ran = await $.command.run({ command: 'hindsight', args: '', origin: { kind: 'user' }, presentation: 'text' })

  // #then it sits under the waiting group, seen once
  expect(ran.text).toContain('Waiting for a 2nd session before proposing a fix (1):\n  · `npm test fail` failed, was fixed by an edit, and failed again — seen once, 2 failures a session')
})

test('snags stored by 0.2.0 are dropped when a session starts', async ($, on) => {
  // #given a store holding a snag with no calls, as 0.2.0 wrote them
  const old = { id: 'old', project: '/work', kind: 'big-output', area: 'Bash ls head', sessions: ['s0'], status: 'watching', lastAt: 1 }
  world(on, { fix: '{"fix": "none", "text": ""}', stored: { snags: [old] } })

  // #when a session starts
  await start($)

  // #then the list is empty
  const ran = await $.command.run({ command: 'hindsight', args: '', origin: { kind: 'user' }, presentation: 'text' })
  expect(ran.text).toBe('hindsight has seen no snags in this repo yet.')
})
