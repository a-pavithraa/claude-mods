import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, TurnCompleteInput } from 'claude-code'

import type { Advice, Effort, Need } from '../types'
import {
  CACHE_LIFETIME_MS,
  NEEDS,
  advise,
  classifyText,
  contextAlert,
  contextLevel,
  describeModel,
  dollars,
  emptyHistory,
  record,
  tokens,
  typicalTurn,
  warn,
} from './fit'
import type { History } from './fit'

const advice = atom({ plugin: 'model-fit', key: 'advice' } as const, null)
const context = atom({ plugin: 'model-fit', key: 'context' } as const, null)

const HISTORY_KEY = 'history'
const PROMPT_CHARS = 4000
/** The person's own prompts: typed at the terminal, or sent by Remote Control. */
const HUMAN = new Set(['composer', 'bridge'])
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

const asEffort = (value: unknown): Effort | undefined =>
  typeof value === 'string' && EFFORTS.includes(value) ? (value as Effort) : undefined

const asNeed = (value: unknown): Need | undefined => NEEDS.find(need => need === value)

function asHistory(value: unknown): History {
  const history = emptyHistory()

  if (typeof value !== 'object' || value === null) return history

  for (const need of NEEDS) {
    const kept = (value as Record<string, unknown>)[need]

    if (typeof kept === 'object' && kept !== null) {
      const { turns, steps, output, misses } = kept as Record<string, unknown>

      if (typeof turns === 'number' && typeof steps === 'number' && typeof output === 'number') {
        history[need] = { turns, steps, output, misses: typeof misses === 'number' ? misses : 0 }
      }
    }
  }

  return history
}

type Usage = NonNullable<TurnCompleteInput['usage']>
type Ended = { usage: Usage; context: number; steps: number; effort: Effort | undefined }

type Session = {
  model: string | undefined
  effort: Effort | undefined
  history: History
  needs: Map<string, Need>
  steps: Map<string, number>
  running: Set<string>
  /** Turns that ended before their label came back: concluded when it does. */
  ended: Map<string, Ended>
  typed: string | undefined
  level: number
  isCold: boolean
  cooling: Timer | undefined
}

const setCold = ($: EngineInterface, isCold: boolean) =>
  update($, context, alert => (alert === null || alert.isCold === isCold ? alert : { ...alert, isCold }))

/** The text of the assistant's last reply, so a short go-ahead is judged by the plan it approves. */
async function lastReply($: EngineInterface) {
  const rows = await $.session.messages().catch(() => [])

  for (let at = rows.length - 1; at >= 0; at -= 1) {
    const row = rows[at]

    if (row?.role === 'assistant' && row.text.trim() !== '') return row.text
  }

  return ''
}

/** Learns the finished turn and, when it ran on more than it needed, leaves advice for the next ask like it. */
async function conclude($: EngineInterface, session: Session, turnId: string, need: Need, ended: Ended) {
  const found = advise({ turnId, need, model: ended.usage.model, ...ended, history: session.history })
  session.history = record(session.history, need, ended.steps, ended.usage.output_tokens)
  await $.store.set(HISTORY_KEY, session.history)

  if (found !== undefined) await update($, advice, () => found)
}

async function judge($: EngineInterface, session: Session, turnId: string, text: string) {
  const label = await $.model
    .classify(classifyText(text.slice(0, PROMPT_CHARS), await lastReply($)), NEEDS, { model: 'haiku' })
    .catch(() => undefined)
  const need = asNeed(label)
  const ended = session.ended.get(turnId)
  session.ended.delete(turnId)

  if (need === undefined) return
  if (ended !== undefined) return conclude($, session, turnId, need, ended)
  if (!session.running.has(turnId) || session.model === undefined) return

  session.needs.set(turnId, need)
  const warning = warn(turnId, need, session.model, session.effort)

  if (warning !== undefined) await update($, advice, () => warning)
}

const WORDS: Record<Advice['kind'], (shown: Advice) => [string, string]> = {
  smaller: shown => [
    `That ask looked simple and ran on ${shown.on}: ≈ ${dollars(shown.actual?.usd ?? 0)}. On ${shown.target.label} ≈ ${dollars(shown.target.usd ?? 0)}, if it took the same steps.`,
    `For asks like it, start on ${shown.target.label}. List-price estimates; /cost has the real figure.`,
  ],
  lighter: shown => [
    `That ask looked simple and ran on ${shown.on}: ≈ ${dollars(shown.actual?.usd ?? 0)} at list prices.`,
    'For asks like it, lower the effort in /model.',
  ],
  bigger: shown => [
    `This ask looks complex and runs on ${shown.on}.`,
    `If the answer looks thin, run it again on ${shown.target.label}.`,
  ],
  harder: shown => [
    `This ask looks complex and runs on ${shown.on}.`,
    'If the answer looks thin, raise the effort in /model and run it again.',
  ],
}

async function putCommand($: EngineInterface, command: string) {
  if ((await $.prompt.read()).text.trim() !== '') {
    $.ui.toast(`model-fit: clear the prompt box first; ${command} goes there`)

    return
  }

  await $.prompt.fill({ text: command, mode: 'replace' })
}

export const register: Register = on => {
  const session: Session = {
    model: undefined,
    effort: undefined,
    history: emptyHistory(),
    needs: new Map(),
    steps: new Map(),
    running: new Set(),
    ended: new Map(),
    typed: undefined,
    level: 0,
    isCold: true,
    cooling: undefined,
  }

  on('session.start', async ($, e, next) => {
    const settings: Record<string, unknown> = await $.settings.read()
    session.model = typeof settings.model === 'string' ? settings.model : undefined
    session.effort = asEffort(settings.effortLevel)
    session.history = asHistory(await $.store.get(HISTORY_KEY))
    // Advice belongs to the turn just run; a reload or resume must not draw the last one again.
    await update($, advice, () => null)
    await $.command.register({ name: 'fit', description: 'Model fit: what tasks cost so far; "/fit reset" forgets it' })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    const text = entered.text?.trim() ?? ''

    if (HUMAN.has(e.origin.kind) && text !== '' && !text.startsWith('/')) session.typed = text

    return entered
  })

  // Only a turn the person started is judged: a task notification, a continuation or a plugin's prompt keeps the advice.
  on('turn.start', async ($, e, next) => {
    session.isCold = false
    session.cooling?.cancel()
    session.cooling = undefined
    await setCold($, false)
    const started = await next(e)
    const text = session.typed
    session.typed = undefined

    if (text !== undefined) {
      await update($, advice, () => null)
      session.running.add(e.turnId)
      $.clock.after(0, () => void judge($, session, e.turnId, text))
    }

    return started
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      session.model = e.model
      session.effort = asEffort(e.effort) ?? session.effort
      session.steps.set(e.turnId, (session.steps.get(e.turnId) ?? 0) + 1)
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId !== undefined) return done

    session.cooling?.cancel()
    session.cooling = $.clock.after(CACHE_LIFETIME_MS, () => {
      session.isCold = true
      void setCold($, true)
    })
    const wasTyped = session.running.delete(e.turnId)
    const need = session.needs.get(e.turnId)
    const steps = session.steps.get(e.turnId) ?? 0
    session.needs.delete(e.turnId)
    session.steps.delete(e.turnId)

    if (!wasTyped || e.usage === undefined || e.isAborted) return done

    const usage = await $.session.usage()
    const ended: Ended = { usage: e.usage, context: usage.context.tokens ?? 0, steps, effort: session.effort }

    if (need === undefined) session.ended.set(e.turnId, ended)
    else await conclude($, session, e.turnId, need, ended)

    return done
  })

  on('session.measure', async ($, e, next) => {
    const count = e.context.tokens

    if (count === undefined) return next(e)

    const level = contextLevel(count)

    if (level > session.level && session.model !== undefined) {
      const alert = contextAlert(count, session.model, session.effort)
      await update($, context, () => alert)
    } else if (level < session.level) {
      await update($, context, () => null)
    }

    session.level = level

    return next(e)
  })

  on('command.run', { command: 'fit' }, async ($, e) => {
    if (e.args.trim() === 'reset') {
      session.history = emptyHistory()
      await $.store.delete(HISTORY_KEY)

      return { text: 'Forgot the cost history.' }
    }

    const current = session.model === undefined ? 'unknown' : describeModel(session.model, session.effort)
    const rows = NEEDS.map(need => {
      const typical = typicalTurn(session.history, need)
      const { turns, misses } = session.history[need]
      const learned = turns === 0 ? 'a guess so far' : `from ${turns} turns`
      const missed = misses === 0 ? '' : `; ${misses} more ran over 3x that, so their label was wrong`

      return `${need}: ~${typical.steps} steps, ~${tokens(typical.output)} output tok (${learned}${missed})`
    })

    return { text: [`On ${current}.`, ...rows].join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, advice)
    const heavy = await read($, context)

    const below = await next(e)

    if (e.props.hasSurvey || (shown === null && heavy === null)) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const isWarning = shown?.kind === 'bigger' || shown?.kind === 'harder'
    const command = shown?.target.command

    return (
      <Box flexDirection="column">
        {shown === null ? null : (
          <Box key="advice" flexDirection="column">
            <Box>
              <Text color={isWarning ? 'warning' : 'suggestion'}>{isWarning ? '▲ ' : '◆ '}</Text>
              <Text wrap="wrap">{WORDS[shown.kind](shown)[0]}</Text>
            </Box>
            <Box>
              <Text wrap="wrap">
                {'  '}
                {WORDS[shown.kind](shown)[1]}{' '}
              </Text>
              {command === undefined ? null : (
                <Button key="use" label={`Put ${command} in prompt`} onPress={() => putCommand($, command)} />
              )}
              <Button key="dismiss-advice" label="Dismiss" onPress={() => update($, advice, () => null)} />
            </Box>
          </Box>
        )}
        {heavy === null ? null : (
          <Box key="context" flexDirection="column">
            <Box>
              <Text color="warning">▲ </Text>
              <Text wrap="wrap">
                Long conversation ({tokens(heavy.tokens)} tokens): each step Claude takes rereads it, ≈{' '}
                {dollars(heavy.cachedUsd)} a step at list prices.{' '}
              </Text>
            </Box>
            <Box>
              <Text>{'  '}When you move on to a new task, /clear first. </Text>
              <Button key="dismiss-context" label="Dismiss" onPress={() => update($, context, () => null)} />
            </Box>
            {heavy.isCold ? (
              <Text key="cold" dimColor wrap="wrap">
                {'  '}After this pause the next action costs ≈ {dollars(heavy.coldUsd)} while the reread is re-cached.
              </Text>
            ) : null}
          </Box>
        )}
        {below.type === 'engine' ? null : below}
      </Box>
    )
  })
}
