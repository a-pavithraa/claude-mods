import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type World = {
  model: string
  effort?: string
  label: string
  context?: number
  otherBand?: string
  reply?: string
  draft?: string
  key?: string
  scope?: 'standalone' | 'conversation'
  jev?: { status: number; probabilities?: Record<string, number> }
  env?: Record<string, string>
  cacheTtl?: string
  jevHangs?: boolean
}

const USAGE = { input_tokens: 400, output_tokens: 900, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2_000 }

function world(on: On, w: World) {
  const seen = {
    toasts: [] as string[],
    classified: [] as string[],
    filled: [] as string[],
    fetched: [] as string[],
  }
  mock.store(on)
  const clock = mock.clock(on)

  on('env.get', ($, e) => ({ value: e.name === 'TYPESAFE_API_KEY' ? w.key : w.env?.[e.name] }))
  on('http.fetch', ($, e) => {
    seen.fetched.push(String(e.init?.body ?? ''))
    if (w.jevHangs === true) return new Promise<never>(() => undefined)
    const status = w.jev?.status ?? 200

    return { value: { status, ok: status < 300, headers: {}, text: JSON.stringify({ answers: { need: { type: 'score', probabilities: w.jev?.probabilities ?? {} } } }) } }
  })
  on('settings.read', () => ({ value: { model: w.model, effortLevel: w.effort, promptCacheTtl: w.cacheTtl } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('model.classify', ($, e) => {
    seen.classified.push(e.text)

    return { value: e.labels.includes('standalone') ? (w.scope ?? 'conversation') : w.label }
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

type Turn = {
  id: string
  text: string
  model: string
  steps: number
  effort?: 'high' | 'low' | 'medium'
  isLabelLate?: boolean
  usage?: typeof USAGE
}

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
    usage: { ...(turn.usage ?? USAGE), model: turn.model },
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
    (await shown.find({ text: /Simple ask on Opus\/high: ≈ \$0\.04\. On Haiku ≈ <\$0\.01 per ask like it\./ })) !== undefined,
    (await shown.find({ text: /Switching re-caches this conversation once \(≈ <\$0\.01\) and pays back on the next ask like it\./ })) !== undefined,
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
  expect(await (await band($)).find({ text: /Simple ask on Opus\/medium/ })).toBeDefined()
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

test('a routine ask gets a one-line verdict and no advice, and the finished turn is learned for next time', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'sonnet', label: 'normal' })
  await start($)

  // #when
  await runTurn($, clock, { id: 't1', text: 'add a test for groupByTask', model: 'claude-sonnet-5-5', steps: 2 })

  // #then
  const shown = await band($)
  expect([
    await shown.find({ text: /That ask/ }),
    (await shown.find({ text: /◇ Looked routine · Sonnet · ≈ \$0\.\d\d · judged by Haiku/ })) !== undefined,
    (await fitCommand($)).text,
  ]).toEqual([
    undefined,
    true,
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
  expect([await (await band($)).find({ text: /Simple ask/ }), (await fitCommand($)).text]).toEqual([
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
  expect(
    await shown.find({
      text: /New task: \/clear \(this one stays in \/resume\)\. Same task: \/compact what to keep, or \/model-fit:baton to pick it up later\. Wrong turn: \/rewind\./,
    }),
  ).toBeDefined()
  expect(await shown.find({ text: /cache has expired/ })).toBeUndefined()
  expect(seen.toasts).toEqual([])
})

test('the context alert puts /compact or the baton skill in the prompt box', async ($, on) => {
  // #given
  const { seen } = world(on, { model: 'opus', effort: 'medium', label: 'normal' })
  await start($)
  await measure($, 120_000)

  // #when
  const shown = await band($)
  await shown.press({ key: 'compact' })
  await shown.press({ key: 'baton' })

  // #then
  expect(seen.filled).toEqual(['/compact keep:', '/model-fit:baton'])
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

  expect(await (await band($)).find({ text: /cache has expired/ })).toBeUndefined()

  await clock.advance(60_000)

  expect(
    await (await band($)).find({
      text: /After this pause the cache has expired: the next action rereads all of it for ≈ \$0\.96 on Opus\/medium\. Shrink it first: \/model-fit:baton to pick up later, \/compact to carry on now\. This is also the cheapest moment to change model\./,
    }),
  ).toBeDefined()

  await ask($, 'carry on', 't2')

  expect(await (await band($)).find({ text: /cache has expired/ })).toBeUndefined()
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

  expect(seen.classified).toHaveLength(2)
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

const SURE_SIMPLE = { '0': 0.92, '1': 0.06, '2': 0.02 }
const TORN = { '0': 0.45, '1': 0.4, '2': 0.15 }
const HASHMAP: Turn = { id: 't1', text: 'what is a hashmap', model: 'claude-opus-5-5', steps: 1, effort: 'high' }

test('a concept question is described to Haiku as simple work', async ($, on) => {
  // #given
  const { seen, clock } = world(on, { model: 'opus', label: 'trivial' })
  await start($)

  // #when
  await ask($, HASHMAP.text, 't1')
  await clock.settle()

  // #then
  expect(seen.classified[0]).toContain('a general concept or arithmetic question that needs no code read')
})

test('a rename across many files is described to Haiku as routine work, not simple', async ($, on) => {
  // #given
  const { seen, clock } = world(on, { model: 'opus', label: 'normal' })
  await start($)

  // #when
  await ask($, 'Rename getSession to loadSession everywhere, then commit.', 't1')
  await clock.settle()

  // #then
  expect(seen.classified[0]).toContain('normal: everything else, including a rename or find-and-replace across many files')
})

test('Jev shadow is told the same about renames as Haiku', { options: { jevShadow: 'on' } }, async ($, on) => {
  // #given
  const { seen, clock } = world(on, { model: 'opus', label: 'normal', key: 'k', jev: { status: 200, probabilities: SURE_SIMPLE } })
  await start($)

  // #when
  await runTurn($, clock, HASHMAP)

  // #then
  expect(JSON.parse(seen.fetched[0] ?? '{}').questions.need.criteria).toEqual([
    expect.stringContaining('a rename within one file'),
    expect.stringContaining('a rename or find-and-replace across many files'),
    expect.any(String),
  ])
})

test('Jev shadow is off by default: nothing is sent to TypeSafe and /fit says how to opt in', async ($, on) => {
  // #given
  const { seen, clock } = world(on, { model: 'opus', effort: 'high', label: 'trivial', key: 'k' })
  await start($)

  // #when
  await runTurn($, clock, HASHMAP)

  // #then
  expect([seen.fetched.length, (await fitCommand($)).text]).toEqual([
    0,
    expect.stringContaining('Jev shadow: off (opt in with the jevShadow option and a TypeSafe key).'),
  ])
})

test('with Jev shadow on, Haiku still drives the advice and /fit lists the disagreement', { options: { jevShadow: 'on' } }, async ($, on) => {
  // #given
  const { seen, clock } = world(on, { model: 'opus', effort: 'high', label: 'normal', key: 'k', jev: { status: 200, probabilities: SURE_SIMPLE } })
  await start($)

  // #when
  await runTurn($, clock, HASHMAP)
  const shown = await band($)
  const report = (await fitCommand($)).text ?? ''

  // #then
  expect([
    seen.fetched.length,
    await shown.find({ text: /Simple ask/ }),
    report.includes('1 ask compared, agree on 0 of 1 sure answers'),
    report.includes('"what is a hashmap": Haiku normal, Jev trivial (92%)'),
  ]).toEqual([1, undefined, true, true])
})

test('Jev shadow gets the same end of the last reply as Haiku, never the whole reply', { options: { jevShadow: 'on' } }, async ($, on) => {
  // #given
  const reply = `${'a'.repeat(800)}${'b'.repeat(1_200)}`
  const { seen, clock } = world(on, { model: 'opus', label: 'normal', key: 'k', reply, jev: { status: 200, probabilities: SURE_SIMPLE } })
  await start($)

  // #when
  await runTurn($, clock, HASHMAP)

  // #then
  expect(JSON.parse(seen.fetched[0] ?? '{}').state.previous_assistant_reply).toBe('b'.repeat(1_200))
})

test('an unsure Jev answer is no call, not a disagreement', { options: { jevShadow: 'on' } }, async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'opus', label: 'normal', key: 'k', jev: { status: 200, probabilities: TORN } })
  await start($)

  // #when
  await runTurn($, clock, HASHMAP)

  // #then
  expect((await fitCommand($)).text).toContain('no sure answers yet.\n  Jev unsure on 1, failed on 0')
})

test('a failing Jev is reported once, and Haiku labels carry on', { options: { jevShadow: 'on' } }, async ($, on) => {
  // #given
  const { seen, clock } = world(on, { model: 'opus', effort: 'high', label: 'trivial', key: 'bad', jev: { status: 401 } })
  await start($)

  // #when
  await runTurn($, clock, HASHMAP)
  await runTurn($, clock, { ...HASHMAP, id: 't2' })

  // #then
  expect([
    seen.toasts,
    (await (await band($)).find({ text: /Simple ask on Opus\/high/ })) !== undefined,
  ]).toEqual([['model-fit: Jev shadow failed (Jev refused the API key (401)); Haiku labels carry on. /fit has the details.'], true])
})

test('/fit totals the session: spent, what the simple asks would have cost on Haiku, and the labelling', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'opus', effort: 'high', label: 'trivial', context: 12_000 })
  await start($)

  // #when
  await runTurn($, clock, RENAME)

  // #then
  expect((await fitCommand($)).text).toMatch(
    /This session: 1 ask judged, ≈ \$0\.04\. 1 simple, ≈ \$0\.04; 0 of those did not need the conversation\. Labelling with Haiku ≈ <\$0\.01\./,
  )
})
test('in a long conversation a simple follow-up advises staying, since the re-cache would not pay back', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'opus', effort: 'high', label: 'trivial', context: 400_000 })
  await start($)

  // #when
  await runTurn($, clock, { ...RENAME, text: 'are the changes reflected?' })
  const shown = await band($)

  // #then
  expect([
    (await shown.find({ text: /Stay on Opus\/high: moving 400k tokens to Haiku costs ≈ \$0\.38 once, 11 asks to earn back\. Start your next new task on Haiku\./ })) !== undefined,
    await shown.find({ key: 'use' }),
  ]).toEqual([true, undefined])
})

test('a switch that pays back only over a few asks says how many', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'opus', effort: 'high', label: 'trivial', context: 120_000 })
  await start($)

  // #when
  await runTurn($, clock, RENAME)

  // #then
  expect(await (await band($)).find({ text: /worth it only if 4 asks like this follow/ })).toBeDefined()
})

test('a standalone question in a long conversation is pointed at a new session, not a model switch', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'opus', effort: 'high', label: 'trivial', scope: 'standalone', context: 120_000 })
  await start($)
  await measure($, 20_000)

  // #when
  await runTurn($, clock, { ...RENAME, text: 'what is 2 plus 2' })
  const shown = await band($)

  // #then
  expect([
    (await shown.find({ text: /That ask didn't need this conversation, but rereading its 120k tokens cost ≈ \$0\.04\./ })) !== undefined,
    (await shown.find({ text: /Ask ones like it in a new session on Haiku: ≈ <\$0\.01\. Keep this one for the work it's about\./ })) !== undefined,
    await shown.find({ key: 'use' }),
  ]).toEqual([true, true, undefined])
})

test('a complex ask on Haiku in a long conversation prices the move to Opus', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'haiku', label: 'complex', context: 200_000 })
  await start($)

  // #when
  await ask($, DESIGN, 't1')
  await clock.settle()

  // #then
  expect(await (await band($)).find({ text: /moving this conversation there costs ≈ \$1\.56 once/ })).toBeDefined()
})

test('a related follow-up is labelled as needing the conversation', async ($, on) => {
  // #given
  const { seen, clock } = world(on, { model: 'opus', label: 'trivial' })
  await start($)

  // #when
  await ask($, 'are the changes reflected?', 't1')
  await clock.settle()

  // #then
  expect(seen.classified[1]).toContain('conversation: it refers to or depends on earlier turns')
})

const ROUTINE: Turn = { id: 't1', text: 'add a test for groupByTask', model: 'claude-opus-5-5', steps: 8, effort: 'medium' }

test('a routine ask on Opus prices Sonnet for the next one, once a session', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'opus', effort: 'medium', label: 'normal', context: 120_000 })
  await start($)

  // #when
  await runTurn($, clock, ROUTINE)
  const first = await band($)
  const firstSaid = [
    (await first.find({ text: /Routine ask on Opus\/medium: ≈ \$0\.04, mostly rereading 120k tokens of conversation\./ })) !== undefined,
    (await first.find({ text: /Stay on Opus\/medium: moving 120k tokens to Sonnet costs ≈ \$0\.47 once, 23 asks to earn back\. Start your next new task on Sonnet\./ })) !== undefined,
  ]
  await runTurn($, clock, { ...ROUTINE, id: 't2' })

  // #then
  expect([...firstSaid, await (await band($)).find({ text: /Sonnet/ })]).toEqual([true, true, undefined])
})

test('a routine ask on Haiku suggests Sonnet while it runs', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'haiku', label: 'normal' })
  await start($)

  // #when
  await ask($, 'add a test for groupByTask', 't1')
  await clock.settle()
  const shown = await band($)

  // #then
  expect([
    (await shown.find({ text: /This ask looks routine and runs on Haiku\./ })) !== undefined,
    (await shown.find({ key: 'use', text: 'Put /model sonnet in prompt' })) !== undefined,
  ]).toEqual([true, true])
})

test('a complex ask at low effort offers /effort high, which keeps the cache', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'claude-opus-5-5', effort: 'low', label: 'complex' })
  await start($)

  // #when
  await ask($, DESIGN, 't1')
  await clock.settle()
  const shown = await band($)

  // #then
  expect([
    (await shown.find({ text: /If the answer looks thin, run \/effort high and ask again; it keeps this conversation's cache\./ })) !== undefined,
    (await shown.find({ key: 'use', text: 'Put /effort high in prompt' })) !== undefined,
  ]).toEqual([true, true])
})

test('in a long conversation a simple ask is offered a lower effort, since that keeps the cache', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'opus', effort: 'high', label: 'trivial', context: 400_000 })
  await start($)

  // #when
  await runTurn($, clock, { ...RENAME, text: 'are the changes reflected?' })
  const shown = await band($)

  // #then
  expect([
    (await shown.find({ text: /Or \/effort low for asks like it: it keeps this conversation's cache\./ })) !== undefined,
    (await shown.find({ key: 'effort', text: 'Put /effort low in prompt' })) !== undefined,
  ]).toEqual([true, true])
})

test('on Bedrock a lower effort is not offered as free', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'opus', effort: 'high', label: 'trivial', context: 400_000, env: { CLAUDE_CODE_USE_BEDROCK: '1' } })
  await start($)

  // #when
  await runTurn($, clock, { ...RENAME, text: 'are the changes reflected?' })

  // #then
  expect(await (await band($)).find({ key: 'effort' })).toBeUndefined()
})

async function coldAfter($: Engine, clock: { advance: (ms: number) => Promise<unknown> }, minutes: number) {
  await start($)
  await measure($, 120_000)
  await finishTurn($)
  await clock.advance(minutes * 60_000)

  return (await band($)).find({ text: /cache has expired/ })
}

test('with an API key the cache lives five minutes and rebuilds at 1.25x the input price', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'opus', effort: 'medium', label: 'normal', env: { ANTHROPIC_API_KEY: 'k' } })

  // #when
  const early = await coldAfter($, clock, 4)
  await clock.advance(60_000)

  // #then
  expect([
    early,
    (await (await band($)).find({ text: /rereads all of it for ≈ \$0\.60 on Opus\/medium/ })) !== undefined,
  ]).toEqual([undefined, true])
})

test('promptCacheTtl 1h keeps the hour with an API key', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'opus', label: 'normal', env: { ANTHROPIC_API_KEY: 'k' }, cacheTtl: '1h' })

  // #when
  const shown = await coldAfter($, clock, 30)

  // #then
  expect(shown).toBeUndefined()
})

test('FORCE_PROMPT_CACHING_5M wins over the setting', async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'opus', label: 'normal', cacheTtl: '1h', env: { FORCE_PROMPT_CACHING_5M: '1' } })

  // #when
  const shown = await coldAfter($, clock, 5)

  // #then
  expect(shown).toBeDefined()
})

test('the cacheTtl option overrides what model-fit detects', { options: { cacheTtl: '5m' } }, async ($, on) => {
  // #given
  const { clock } = world(on, { model: 'opus', label: 'normal' })

  // #when
  const shown = await coldAfter($, clock, 5)

  // #then
  expect(shown).toBeDefined()
})

test('a turn that rebuilt the cache is priced for payback as if warm, so the one-time write is not a saving', async ($, on) => {
  // #given an Opus turn that wrote the whole 100k context to the cache
  const { clock } = world(on, { model: 'opus', effort: 'medium', label: 'normal', context: 100_000 })
  await start($)

  // #when
  await runTurn($, clock, {
    ...ROUTINE,
    steps: 1,
    usage: { input_tokens: 400, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 100_000 },
  })

  // #then
  expect(await (await band($)).find({ text: /Stay on Opus\/medium: moving 100k tokens to Sonnet costs ≈ \$0\.39 once, 34 asks to earn back\./ })).toBeDefined()
})

test('a slow Jev shadow does not hold up the end of a turn', { options: { jevShadow: 'on' } }, async ($, on) => {
  // #given Jev never answers
  const { clock } = world(on, { model: 'opus', label: 'normal', key: 'k', jevHangs: true })
  await start($)
  await ask($, HASHMAP.text, HASHMAP.id)
  await clock.settle()

  // #when
  const completed = await Promise.race([
    $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: HASHMAP.id, reason: 'answer', usage: { ...USAGE, model: 'claude-opus-5-5' } }).then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 1000)),
  ])

  // #then
  expect(completed).toBe(true)
})
