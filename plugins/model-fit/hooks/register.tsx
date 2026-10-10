import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Advice, Effort, Need, Target } from '../types'
import {
  CACHE_LIFETIME_MS,
  CLASSIFY_BRIEF,
  FRESH_CONTEXT,
  NEEDS,
  NEED_WORDS,
  advise,
  contextAlert,
  contextLevel,
  describeModel,
  dollars,
  emptyHistory,
  record,
  tokens,
  typicalTurn,
  usageCost,
} from './fit'
import type { History } from './fit'

const advice = atom({ plugin: 'model-fit', key: 'advice' } as const, null)
const context = atom({ plugin: 'model-fit', key: 'context' } as const, null)

const HISTORY_KEY = 'history'
const PROMPT_CHARS = 4000
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
      const { turns, steps, output } = kept as Record<string, unknown>

      if (typeof turns === 'number' && typeof steps === 'number' && typeof output === 'number') {
        history[need] = { turns, steps, output }
      }
    }
  }

  return history
}

type Session = {
  model: string | undefined
  effort: Effort | undefined
  history: History
  needs: Map<string, Need>
  steps: Map<string, number>
  applied: Map<string, Target>
  level: number
  isCold: boolean
  cooling: Timer | undefined
}

const setCold = ($: EngineInterface, isCold: boolean) =>
  update($, context, alert => (alert === null || alert.isCold === isCold ? alert : { ...alert, isCold }))

async function judge($: EngineInterface, session: Session, turnId: string, text: string, isCold: boolean) {
  const label = await $.model
    .classify(`${CLASSIFY_BRIEF}\n${text.slice(0, PROMPT_CHARS)}`, NEEDS, { model: 'haiku' })
    .catch(() => undefined)
  const need = asNeed(label)

  if (need === undefined || session.model === undefined) return

  session.needs.set(turnId, need)
  const usage = await $.session.usage()
  const found = advise({
    turnId,
    need,
    model: session.model,
    effort: session.effort,
    context: usage.context.tokens ?? FRESH_CONTEXT,
    isCold,
    history: session.history,
  })

  if (found !== undefined) await update($, advice, () => found)
}

function adviceLine(shown: Advice) {
  const head = `${NEED_WORDS[shown.need]} · on ${shown.on}`

  if (shown.actual !== undefined) {
    return `${head} · that turn: ${tokens(shown.actual.tokens)} tok ≈ ${dollars(shown.actual.usd)} (est. ${dollars(shown.estimate.usd)})`
  }

  const estimate = `est. ~${tokens(shown.estimate.tokens)} tok ≈ ${dollars(shown.estimate.usd)}`

  if (shown.target === undefined) return `${head} · ${estimate}`

  return `${head} · ${estimate} · ${shown.target.label} ≈ ${dollars(shown.target.cost.usd)}`
}

const switchLabel = (target: Target) => (target.model !== undefined ? `Use ${target.label} for this turn` : `Use ${target.label}`)

export const register: Register = on => {
  const session: Session = {
    model: undefined,
    effort: undefined,
    history: emptyHistory(),
    needs: new Map(),
    steps: new Map(),
    applied: new Map(),
    level: 0,
    isCold: true,
    cooling: undefined,
  }

  on('session.start', async ($, e, next) => {
    const settings: Record<string, unknown> = await $.settings.read()
    session.model = typeof settings.model === 'string' ? settings.model : undefined
    session.effort = asEffort(settings.effortLevel)
    session.history = asHistory(await $.store.get(HISTORY_KEY))
    await $.command.register({ name: 'fit', description: 'Model fit: what tasks cost so far; "/fit reset" forgets it' })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const isCold = session.isCold
    session.isCold = false
    session.cooling?.cancel()
    session.cooling = undefined
    await setCold($, false)
    const started = await next(e)
    const text = e.text.trim()

    if (text !== '' && !text.startsWith('/')) {
      await update($, advice, () => null)
      $.clock.after(0, () => void judge($, session, e.turnId, text, isCold))
    }

    return started
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    session.model = e.model
    session.effort = asEffort(e.effort) ?? session.effort
    session.steps.set(e.turnId, (session.steps.get(e.turnId) ?? 0) + 1)
    const target = session.applied.get(e.turnId)

    if (target === undefined) return yield* next(e)

    return yield* next({
      ...e,
      ...(target.model === undefined ? {} : { model: target.model }),
      ...(target.effort === undefined ? {} : { effort: target.effort }),
    })
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId !== undefined) return done

    session.cooling?.cancel()
    session.cooling = $.clock.after(CACHE_LIFETIME_MS, () => {
      session.isCold = true
      void setCold($, true)
    })
    const need = session.needs.get(e.turnId)
    const steps = session.steps.get(e.turnId) ?? 0
    session.needs.delete(e.turnId)
    session.steps.delete(e.turnId)
    session.applied.delete(e.turnId)

    if (e.usage === undefined || e.isAborted) return done

    const actual = usageCost(e.usage, e.usage.model)

    if (need !== undefined) {
      session.history = record(session.history, need, steps, e.usage.output_tokens)
      await $.store.set(HISTORY_KEY, session.history)
    }

    await update($, advice, shown => (shown?.turnId === e.turnId ? { ...shown, actual } : shown))

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
      const seen = session.history[need].turns

      return `${need}: ~${typical.steps} steps, ~${tokens(typical.output)} output tok (${seen === 0 ? 'a guess so far' : `from ${seen} turns`})`
    })

    return { text: [`On ${current}.`, ...rows].join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, advice)
    const heavy = await read($, context)

    const below = await next(e)

    if (e.props.hasSurvey || (shown === null && heavy === null)) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const target = shown?.target
    const canSwitch = shown !== null && target !== undefined && shown.actual === undefined && !shown.isApplied

    return (
      <Box flexDirection="column">
        {shown === null ? null : (
          <Box key="advice">
            <Text color={shown.kind === 'bigger' || shown.kind === 'harder' ? 'warning' : 'suggestion'}>◆ </Text>
            <Text>{adviceLine(shown)} </Text>
            {shown.isApplied && shown.actual === undefined ? <Text dimColor>switched </Text> : null}
            {canSwitch ? (
              <Button
                key="switch"
                label={switchLabel(target)}
                onPress={async () => {
                  session.applied.set(shown.turnId, target)
                  await update($, advice, now => (now === null ? now : { ...now, isApplied: true }))
                }}
              />
            ) : null}
            <Button key="dismiss-advice" label="Dismiss" onPress={() => update($, advice, () => null)} />
          </Box>
        )}
        {shown?.note === undefined ? null : (
          <Text key="note" dimColor>
            {'  '}
            {shown.note}
          </Text>
        )}
        {heavy === null ? null : (
          <Box key="context" flexDirection="column">
            <Box>
              <Text color="warning">▲ </Text>
              <Text wrap="wrap">
                Long conversation ({tokens(heavy.tokens)} tokens): every action Claude takes costs ≈{' '}
                {dollars(heavy.cachedUsd)} just to reread it.{' '}
              </Text>
            </Box>
            <Box>
              <Text>{'  '}Starting something unrelated? /clear first. </Text>
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
