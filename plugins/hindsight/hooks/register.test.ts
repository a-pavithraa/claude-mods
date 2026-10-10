import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { withPointer } from './propose'
import { addRun, addWrite, areaOf, commandKey, emptyLog, signalsOf } from './signals'

const USAGE = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0 }

type World = { fix: string; claudeMd?: string; box?: string }

function world(on: On, w: World) {
  const seen = { session: 's1', forks: 0, written: [] as string[], filled: [] as string[], toasts: [] as string[] }
  mock.store(on)
  const clock = mock.clock(on)

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/work' }))
  on('session.id', () => ({ value: seen.session }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('model.fork', () => {
    seen.forks += 1

    return { value: { isAnswered: true, text: w.fix, usage: USAGE } }
  })
  on('fs.exists', ($, e) => ({ value: e.path === '/work/CLAUDE.md' && w.claudeMd !== undefined }))
  on('fs.read', () => ({ value: w.claudeMd ?? '' }))
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
  on('tool.call', ($, e) => {
    const isFailing = 'command' in e && String(e.command).includes('fail')

    return { result: 'ok', text: isFailing ? 'FAIL' : 'ok', ...(isFailing ? { isError: true } : {}) }
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

test('an area is the folder under the root, three deep at most', () => {
  expect(areaOf('/work/plugins/x/hooks/register.tsx', '/work')).toBe('plugins/x/hooks')
  expect(areaOf('D:\\work\\a\\b\\c\\d\\e.ts', 'D:/work')).toBe('a/b/c')
  expect(areaOf('/work/README.md', '/work')).toBe('.')
})

test('a failure repeated without an edit between is not a fix loop', () => {
  const twice = addRun(addRun(emptyLog(), 'npm test', true), 'npm test', true)
  expect(signalsOf(twice)).toEqual([])

  const fixed = addRun(addWrite(addRun(emptyLog(), 'npm test', true)), 'npm test', true)
  expect(signalsOf(fixed)).toEqual([{ kind: 'fix-loop', area: 'npm test' }])
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
  expect(await shown.find({ text: /hindsight · 2 sessions: 10 or more searches in plugins\/x\/hooks/ })).toBeDefined()
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
