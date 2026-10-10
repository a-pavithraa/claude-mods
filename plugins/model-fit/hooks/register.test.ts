import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type World = { model: string; effort?: string; label: string; context?: number; otherBand?: string }

const USAGE = { input_tokens: 400, output_tokens: 900, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2_000 }

function world(on: On, w: World) {
  const seen = { models: [] as string[], efforts: [] as (string | number | undefined)[], toasts: [] as string[] }
  mock.store(on)
  const clock = mock.clock(on)

  on('settings.read', () => ({ value: { model: w.model, effortLevel: w.effort } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('model.classify', () => ({ value: w.label }))
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
    seen.models.push(e.model)
    seen.efforts.push(e.effort)

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  return { seen, clock }
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

async function step($: Engine, model: string, index: number, effort?: 'high' | 'low' | 'medium') {
  const stream = $.turn.step({ turnId: 't1', index, model, effort, messageCount: 2 + index })

  for await (const chunk of stream) void chunk

  return stream.result
}

async function warmUp($: Engine) {
  await $.turn.start({ text: '/fit', turnId: 't0' })
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't0', reason: 'answer' })
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

test('a simple ask on Opus/high offers Haiku, and the switch reaches the next request', async ($, on) => {
  const { seen, clock } = world(on, { model: 'opus', effort: 'high', label: 'trivial', context: 12_000 })
  await start($)
  await $.turn.start({ text: 'rename foo to bar in util.ts', turnId: 't1' })
  await step($, 'claude-opus-5-5', 0, 'high')
  await clock.settle()

  const shown = await band($)
  expect(await shown.find({ text: /Looks simple · on Opus\/high · est\. ~/ })).toBeDefined()
  expect(await shown.find({ text: /Haiku ≈ <?\$/ })).toBeDefined()

  await shown.press({ key: 'switch' })
  await step($, 'claude-opus-5-5', 1, 'high')

  expect(seen.models).toEqual(['claude-opus-5-5', 'haiku'])
  expect(await shown.find({ text: /switched/ })).toBeDefined()
})

test('a complex ask on Haiku offers Opus', async ($, on) => {
  const { clock } = world(on, { model: 'haiku', label: 'complex' })
  await start($)
  await $.turn.start({ text: 'design a plugin system for the exporter and migrate the three formats to it', turnId: 't1' })
  await clock.settle()

  const shown = await band($)
  expect(await shown.find({ text: /Looks complex · on Haiku/ })).toBeDefined()
  expect(await shown.find({ key: 'switch', text: 'Use Opus for this turn' })).toBeDefined()
})

test('the advice and another plugin\'s band are both shown', async ($, on) => {
  const { clock } = world(on, { model: 'haiku', label: 'complex', otherBand: '2 files to read' })
  await start($)
  await $.turn.start({ text: 'design a plugin system for the exporter and migrate the three formats to it', turnId: 't1' })
  await clock.settle()

  const shown = await band($)
  expect(await shown.find({ text: /Looks complex · on Haiku/ })).toBeDefined()
  expect(await shown.find({ text: '2 files to read' })).toBeDefined()
})

test('deep in a large context it advises staying put rather than switching', async ($, on) => {
  const { clock } = world(on, { model: 'opus', effort: 'medium', label: 'trivial', context: 180_000 })
  await start($)
  await warmUp($)
  await $.turn.start({ text: 'what does parseMap return?', turnId: 't1' })
  await clock.settle()

  const shown = await band($)
  expect(await shown.find({ text: /switching costs more than it saves/ })).toBeDefined()
  expect(await shown.find({ key: 'switch' })).toBeUndefined()
})

test('a simple ask mid-session offers Haiku even with a warm cache', async ($, on) => {
  const { clock } = world(on, { model: 'opus', effort: 'medium', label: 'trivial', context: 70_000 })
  await start($)
  await warmUp($)
  await $.turn.start({ text: 'what does parseMap return?', turnId: 't1' })
  await clock.settle()

  const shown = await band($)
  expect(await shown.find({ text: /Looks simple · on Opus\/medium/ })).toBeDefined()
  expect(await shown.find({ key: 'switch', text: 'Use Haiku for this turn' })).toBeDefined()
})

test('a routine ask stays quiet, and the finished turn is learned for next time', async ($, on) => {
  const { clock } = world(on, { model: 'opus', label: 'normal' })
  await start($)
  await $.turn.start({ text: 'add a test for groupByTask', turnId: 't1' })
  await clock.settle()
  await step($, 'claude-opus-5-5', 0)
  await step($, 'claude-opus-5-5', 1)
  await $.turn.complete({
    answer: 'done',
    durationMs: 9000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: { ...USAGE, model: 'claude-opus-5-5' },
  })

  expect(await (await band($)).find({ text: /Looks/ })).toBeUndefined()

  const fit = await $.command.run({
    command: 'fit',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  expect(fit.text).toContain('normal: ~5 steps, ~3k output tok (from 1 turns)')
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
  expect(await shown.find({ text: /Long conversation \(120k tokens\): every action Claude takes costs ≈ \$0\.02 just to reread it/ })).toBeDefined()
  expect(await shown.find({ text: /Starting something unrelated\? \/clear first/ })).toBeDefined()
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

  await $.turn.start({ text: 'carry on', turnId: 't2' })

  expect(await (await band($)).find({ text: /re-cached/ })).toBeUndefined()
})

test('the first ask of a session prices the cold cache, so a simple ask on Opus offers Haiku', async ($, on) => {
  const { clock } = world(on, { model: 'opus', effort: 'medium', label: 'trivial', context: 70_000 })
  await start($)
  await $.turn.start({ text: 'what does parseMap return?', turnId: 't1' })
  await clock.settle()

  const shown = await band($)
  expect(await shown.find({ text: /Looks simple · on Opus\/medium · est\. ~.* ≈ \$0\.5\d · Haiku ≈ \$0\.0\d/ })).toBeDefined()
  expect(await shown.find({ key: 'switch', text: 'Use Haiku for this turn' })).toBeDefined()
})
