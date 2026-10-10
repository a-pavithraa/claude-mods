import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type World = { model: string; effort?: string; label: string; context?: number; otherBand?: string; reply?: string; draft?: string }

const USAGE = { input_tokens: 400, output_tokens: 900, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2_000 }

function world(on: On, w: World) {
  const seen = {
    toasts: [] as string[],
    classified: [] as string[],
    filled: [] as string[],
  }
  mock.store(on)
  const clock = mock.clock(on)

  on('settings.read', () => ({ value: { model: w.model, effortLevel: w.effort } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('model.classify', ($, e) => {
    seen.classified.push(e.text)

    return { value: w.label }
  })
  on('session.messages', () => ({
    value: w.reply === undefined ? [] : [{ role: 'assistant', text: w.reply, toolUses: [] }],
  }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.read', () => ({ value: { text: w.draft ?? '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    seen.filled.push(e.text)

    return { isFilled: true }
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: w.context, window: 1_000_000 }, rateLimits: [] },
  }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.render', () =>
    w.otherBand === undefined ? { type: 'engine', ref: 0 } : { type: 'Text', children: [w.otherBand] },
  )
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  return { seen, clock }
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

async function step($: Engine, model: string, index: number, effort?: 'high' | 'low' | 'medium', turnId = 't1') {
  const stream = $.turn.step({ turnId, index, model, effort, messageCount: 2 + index })

  for await (const chunk of stream) void chunk

  return stream.result
}

/** The person types a prompt: it is submitted from the composer, then its turn starts. */
async function ask($: Engine, text: string, turnId: string) {
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text, turnId })
}

const band = ($: Engine) =>
  $.ui.mount({
    plugin: 'model-fit',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: true,
      maxRows: 10,
      bodyColumns: 160,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  })

type Turn = { id: string; text: string; model: string; steps: number; effort?: 'high' | 'low' | 'medium'; isLabelLate?: boolean }

/** A typed ask, run to its end; with `isLabelLate` the label comes back only after the turn ended. */
async function runTurn($: Engine, clock: { settle: () => Promise<unknown> }, turn: Turn) {
  await ask($, turn.text, turn.id)

  if (turn.isLabelLate !== true) await clock.settle()

  for (let index = 0; index < turn.steps; index += 1) await step($, turn.model, index, turn.effort, turn.id)

  await $.turn.complete({
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    turnId: turn.id,
    reason: 'answer',
    usage: { ...USAGE, model: turn.model },
  })
  await clock.settle()
}

const fitCommand = ($: Engine) =>
  $.command.run({ command: 'fit', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

const RENAME: Turn = { id: 't1', text: 'rename foo to bar in util.ts', model: 'claude-opus-5-5', steps: 2, effort: 'high' }
const DESIGN = 'design a plugin system for the exporter and migrate the three formats to it'

test('a simple ask on Opus says nothing while it runs', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'opus', effort: 'high', label: 'trivial', context: 12_000 })
  await start($)

  // #when
  await ask($, RENAME.text, 't1')
  await clock.settle()

  // #then
  expect(await (await band($)).find({ text: /simple/ })).toBeUndefined()
})

test('after a simple ask on Opus it prices the turn on Haiku and offers /model haiku for next time', async ($, on) => {
  // #given
  const { seen, clock } = world(on, { model: 'opus', effort: 'high', label: 'trivial', context: 12_000 })
  await start($)
  await runTurn($, clock, RENAME)

  // #when
  const shown = await band($)
  await shown.press({ key: 'use' })

  // #then
  expect([
    (await shown.find({ text: /That ask looked simple and ran on Opus\/high: ≈ \$0\.04\. On Haiku ≈ <\$0\.01, if it took the same steps\./ })) !== undefined,
    (await shown.find({ text: /List-price estimates; \/cost has the real figure/ })) !== undefined,
    seen.filled,
  ]).toEqual([true, true, ['/model haiku']])
})

test('a label that comes back after the turn ended still gives the advice', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'opus', effort: 'medium', label: 'trivial', context: 12_000 })
  await start($)

  // #when
  await runTurn($, clock, { ...RENAME, effort: 'medium', isLabelLate: true })

  // #then
  expect(await (await band($)).find({ text: /That ask looked simple and ran on Opus\/medium/ })).toBeDefined()
})

test('the command is not put over a draft in the prompt box', async ($, on) => {
  // #given
  const { seen, clock } = world(on, { model: 'opus', effort: 'high', label: 'trivial', context: 12_000, draft: 'next: fix the pager' })
  await start($)
  await runTurn($, clock, RENAME)

  // #when
  await (await band($)).press({ key: 'use' })

  // #then
  expect([seen.filled, seen.toasts]).toEqual([[], ['model-fit: clear the prompt box first; /model haiku goes there']])
})

test('a complex ask on Haiku warns while it runs, with no switch mid-turn', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'haiku', label: 'complex' })
  await start($)

  // #when
  await ask($, DESIGN, 't1')
  await clock.settle()
  const shown = await band($)

  // #then
  expect([
    (await shown.find({ text: /This ask looks complex and runs on Haiku\./ })) !== undefined,
    (await shown.find({ key: 'use', text: 'Put /model opus in prompt' })) !== undefined,
  ]).toEqual([true, true])
})

test("the advice and another plugin's band are both shown", async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'haiku', label: 'complex', otherBand: '2 files to read' })
  await start($)

  // #when
  await ask($, DESIGN, 't1')
  await clock.settle()
  const shown = await band($)

  // #then
  expect([
    (await shown.find({ text: /looks complex/ })) !== undefined,
    (await shown.find({ text: '2 files to read' })) !== undefined,
  ]).toEqual([true, true])
})

test('a routine ask stays quiet, and the finished turn is learned for next time', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'opus', label: 'normal' })
  await start($)

  // #when
  await runTurn($, clock, { id: 't1', text: 'add a test for groupByTask', model: 'claude-opus-5-5', steps: 2 })

  // #then
  expect([await (await band($)).find({ text: /looks|looked/ }), (await fitCommand($)).text]).toEqual([
    undefined,
    expect.stringContaining('normal: ~5 steps, ~3k output tok (from 1 turns)'),
  ])
})

test('a simple-labelled turn that ran far longer gets no advice and is counted as a wrong label', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'opus', effort: 'medium', label: 'trivial', context: 70_000 })
  await start($)

  // #when
  await runTurn($, clock, { ...RENAME, effort: 'medium', steps: 40 })

  // #then
  expect([await (await band($)).find({ text: /simple/ }), (await fitCommand($)).text]).toEqual([
    undefined,
    expect.stringContaining('trivial: ~2 steps, ~800 output tok (a guess so far; 1 more ran over 3x that, so their label was wrong)'),
  ])
})

const measure = ($: Engine, count: number) =>
  $.session.measure({ context: { tokens: count, window: 1_000_000 }, rateLimits: [], changed: ['context'] })

const finishTurn = ($: Engine) =>
  $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })

test('a context past 100k is explained in plain words, in the band alone', async ($, on) => {
  const { seen } = world(on, { model: 'opus', effort: 'medium', label: 'normal' })
  await start($)
  await measure($, 120_000)
  await measure($, 130_000)

  const shown = await band($)
  expect(await shown.find({ text: /Long conversation \(120k tokens\): each step Claude takes rereads it, ≈ \$0\.02 a step at list prices/ })).toBeDefined()
  expect(await shown.find({ text: /When you move on to a new task, \/clear first/ })).toBeDefined()
  expect(await shown.find({ text: /re-cached/ })).toBeUndefined()
  expect(seen.toasts).toEqual([])
})

test('compaction takes the alert down', async ($, on) => {
  world(on, { model: 'opus', effort: 'medium', label: 'normal' })
  await start($)
  await measure($, 120_000)
  await measure($, 40_000)

  expect(await (await band($)).find({ text: /Long conversation/ })).toBeUndefined()
})

test('after an hour of quiet the alert adds what the next action costs, and a new turn clears it', async ($, on) => {
  const { clock } = world(on, { model: 'opus', effort: 'medium', label: 'normal' })
  await start($)
  await measure($, 120_000)
  await finishTurn($)

  await clock.advance(59 * 60_000)

  expect(await (await band($)).find({ text: /re-cached/ })).toBeUndefined()

  await clock.advance(60_000)

  expect(await (await band($)).find({ text: /After this pause the next action costs ≈ \$0\.96 while the reread is re-cached/ })).toBeDefined()

  await ask($, 'carry on', 't2')

  expect(await (await band($)).find({ text: /re-cached/ })).toBeUndefined()
})

test('a go-ahead is judged together with the reply it approves', async ($, on) => {
  const { seen, clock } = world(on, {
    model: 'opus',
    label: 'normal',
    reply: 'Plan: move the mods into a new repo, rewrite the handoff and switch the marketplace.',
  })
  await start($)
  await ask($, 'yes please', 't1')
  await clock.settle()

  expect(seen.classified[0]).toContain('Previous assistant reply (context only):\nPlan: move the mods into a new repo')
  expect(seen.classified[0]).toMatch(/Request:\nyes please$/)
})

test('a turn the person did not start keeps the advice and is not judged', async ($, on) => {
  const { seen, clock } = world(on, { model: 'haiku', label: 'complex' })
  await start($)
  await ask($, DESIGN, 't1')
  await clock.settle()

  await $.prompt.submit({ text: '<task-notification>agent finished</task-notification>', origin: { kind: 'task-notification' }, wait: false })
  await $.turn.start({ text: '<task-notification>agent finished</task-notification>', turnId: 't2' })
  await $.turn.start({ text: '', turnId: 't3' })
  await clock.settle()

  expect(seen.classified).toHaveLength(1)
  expect(await (await band($)).find({ text: /looks complex and runs on Haiku/ })).toBeDefined()
})

test("a reload does not draw the last turn's advice again", async ($, on) => {
  const { clock } = world(on, { model: 'haiku', label: 'complex' })
  await start($)
  await ask($, DESIGN, 't1')
  await clock.settle()

  expect(await (await band($)).find({ text: /looks complex/ })).toBeDefined()

  await start($)

  expect(await (await band($)).find({ text: /looks complex/ })).toBeUndefined()
})
