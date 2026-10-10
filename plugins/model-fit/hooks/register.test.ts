import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type World = { model: string; effort?: string; label: string; context?: number; otherBand?: string; reply?: string }

const USAGE = { input_tokens: 400, output_tokens: 900, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2_000 }

function world(on: On, w: World) {
  const seen = {
    models: [] as string[],
    efforts: [] as (string | number | undefined)[],
    toasts: [] as string[],
    classified: [] as string[],
    aborted: [] as string[],
    submitted: [] as string[],
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
  on('turn.abort', ($, e) => {
    seen.aborted.push(e.turnId)

    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    seen.submitted.push(e.text)

    return { text: e.text }
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
    seen.models.push(e.model)
    seen.efforts.push(e.effort)

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

async function warmUp($: Engine) {
  await ask($, '/fit', 't0')
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
  await warmUp($)
  await ask($, 'rename foo to bar in util.ts', 't1')
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
  await ask($, 'design a plugin system for the exporter and migrate the three formats to it', 't1')
  await clock.settle()

  const shown = await band($)
  expect(await shown.find({ text: /Looks complex · on Haiku/ })).toBeDefined()
  expect(await shown.find({ key: 'switch', text: 'Use Opus for this turn' })).toBeDefined()
})

test('the advice and another plugin\'s band are both shown', async ($, on) => {
  const { clock } = world(on, { model: 'haiku', label: 'complex', otherBand: '2 files to read' })
  await start($)
  await ask($, 'design a plugin system for the exporter and migrate the three formats to it', 't1')
  await clock.settle()

  const shown = await band($)
  expect(await shown.find({ text: /Looks complex · on Haiku/ })).toBeDefined()
  expect(await shown.find({ text: '2 files to read' })).toBeDefined()
})

test('deep in a large context it advises staying put rather than switching', async ($, on) => {
  const { clock } = world(on, { model: 'opus', effort: 'medium', label: 'trivial', context: 180_000 })
  await start($)
  await warmUp($)
  await ask($, 'what does parseMap return?', 't1')
  await clock.settle()

  const shown = await band($)
  expect(await shown.find({ text: /switching costs more than it saves/ })).toBeDefined()
  expect(await shown.find({ key: 'switch' })).toBeUndefined()
})

test('a simple ask mid-session offers Haiku even with a warm cache', async ($, on) => {
  const { clock } = world(on, { model: 'opus', effort: 'medium', label: 'trivial', context: 70_000 })
  await start($)
  await warmUp($)
  await ask($, 'what does parseMap return?', 't1')
  await clock.settle()

  const shown = await band($)
  expect(await shown.find({ text: /Looks simple · on Opus\/medium/ })).toBeDefined()
  expect(await shown.find({ key: 'switch', text: 'Use Haiku for this turn' })).toBeDefined()
})

test('a routine ask stays quiet, and the finished turn is learned for next time', async ($, on) => {
  const { clock } = world(on, { model: 'opus', label: 'normal' })
  await start($)
  await ask($, 'add a test for groupByTask', 't1')
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
  expect(await shown.find({ text: /Long conversation \(120k tokens\): each step Claude takes rereads it, ≈ \$0\.02 a step/ })).toBeDefined()
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

test('the first ask of a session already cached the conversation on Opus, so it does not offer Haiku', async ($, on) => {
  const { clock } = world(on, { model: 'opus', effort: 'medium', label: 'trivial', context: 70_000 })
  await start($)
  await ask($, 'what does parseMap return?', 't1')
  await clock.settle()

  const shown = await band($)
  expect(await shown.find({ text: /the first request already paid to cache this conversation on Opus/ })).toBeDefined()
  expect(await shown.find({ key: 'switch' })).toBeUndefined()
})

async function trivialTurn($: Engine, clock: { settle: () => Promise<unknown> }, turnId: string, steps: number) {
  await ask($, 'bump the version', turnId)
  await clock.settle()

  for (let index = 0; index < steps; index += 1) await step($, 'claude-opus-5-5', index, 'medium', turnId)

  await $.turn.complete({
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    turnId,
    reason: 'answer',
    usage: { ...USAGE, model: 'claude-opus-5-5' },
  })
}

test('a many-step simple ask deep in a session offers a Haiku subagent, and the press hands it off', async ($, on) => {
  const { seen, clock } = world(on, { model: 'opus', effort: 'medium', label: 'trivial', context: 300_000 })
  await start($)

  for (const turnId of ['t0', 't1', 't2']) await trivialTurn($, clock, turnId, 6)

  await ask($, 'bump the version in all four plugins', 't3')
  await clock.settle()

  const shown = await band($)
  expect(await shown.find({ key: 'switch', text: 'Hand to a Haiku subagent' })).toBeDefined()

  await shown.press({ key: 'switch' })

  expect(seen.aborted).toEqual(['t3'])
  expect(seen.submitted.at(-1)).toMatch(/^Hand this task to a subagent on Haiku[\s\S]*Task:\nbump the version in all four plugins$/)
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

test('a simple-labelled turn that ran far longer is not learned, and its advice goes when it ends', async ($, on) => {
  const { clock } = world(on, { model: 'opus', effort: 'medium', label: 'trivial', context: 70_000 })
  await start($)
  await trivialTurn($, clock, 't1', 40)

  expect(await (await band($)).find({ text: /Looks simple/ })).toBeUndefined()

  const fit = await $.command.run({
    command: 'fit',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  expect(fit.text).toContain('trivial: ~2 steps, ~800 output tok (a guess so far)')
})

test('a turn the person did not start keeps the advice and is not judged', async ($, on) => {
  const { seen, clock } = world(on, { model: 'haiku', label: 'complex' })
  await start($)
  await ask($, 'design a plugin system for the exporter and migrate the three formats to it', 't1')
  await clock.settle()

  await $.prompt.submit({ text: '<task-notification>agent finished</task-notification>', origin: { kind: 'task-notification' }, wait: false })
  await $.turn.start({ text: '<task-notification>agent finished</task-notification>', turnId: 't2' })
  await $.turn.start({ text: '', turnId: 't3' })
  await clock.settle()

  expect(seen.classified).toHaveLength(1)
  expect(await (await band($)).find({ text: /Looks complex · on Haiku/ })).toBeDefined()
})
