import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelForkResult, On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const

const ANSWERED: ModelForkResult = {
  isAnswered: true,
  text: 'Here you go:\n[{"ask":"What happens when a booked slot is booked again?","answer":"confirmBooking() in src/bookings.js refuses it."},{"ask":"Second?","answer":"Second answer."},{"ask":"Third?","answer":"Third answer."},{"ask":"Fourth?","answer":"Dropped."}]',
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
}

const PANE_PROPS = {
  title: 'Quiz',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

function world(on: On, reply: ModelForkResult) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('model.fork', () => ({ value: reply }))
}

const start = ($: Engine) =>
  $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

const quiz = ($: Engine) =>
  $.command.run({
    command: 'quiz',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

for (const surface of SURFACES) {
  test(`${surface}: three questions are answered and scored`, async ($, on) => {
    world(on, ANSWERED)
    await start($)

    expect((await quiz($)).text).toBe('3 questions are ready in the Quiz pane.')

    const pane = await $.ui.mount({
      plugin: 'quiz-me',
      surface,
      component: 'Pane',
      requestId: 'quiz-me',
      props: PANE_PROPS,
    })

    expect(await pane.find({ text: /refuses it/ })).toBeUndefined()
    expect(await pane.find({ text: /Fourth/ })).toBeUndefined()

    await pane.press({ key: 'show:0' })

    expect(await pane.find({ text: /refuses it/ })).toBeDefined()

    await pane.press({ key: 'knew:0' })
    await pane.press({ key: 'show:1' })
    await pane.press({ key: 'missed:1' })
    await pane.press({ key: 'show:2' })
    await pane.press({ key: 'knew:2' })

    expect(await pane.find({ text: /2 of 3. Reread what you missed/ })).toBeDefined()
  })
}

test('a session with no turns says so', async ($, on) => {
  world(on, { isAnswered: false, reason: 'nothing-to-fork' })
  await start($)

  expect((await quiz($)).text).toBe(
    'There is nothing to ask about yet: this session has no turns.',
  )
})
