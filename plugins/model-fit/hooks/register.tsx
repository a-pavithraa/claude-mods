import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer, TurnCompleteInput } from 'claude-code'

import type { Advice, Billing, BillingEnv, Effort, Need, Scope, ShadowJev, ShadowRow } from '../types'
import {
  CACHE_LIFETIME_MS,
  CLASSIFY_BRIEF,
  NEEDS,
  SCOPES,
  NEED_WORDS,
  REPLY_CHARS,
  advise,
  billingOf,
  paysNow,
  classifyCostOf,
  classifyText,
  scopeText,
  contextAlert,
  contextLevel,
  describeModel,
  dollars,
  emptyHistory,
  record,
  tokens,
  typicalTurn,
  usageCost,
  warn,
} from './fit'
import type { History } from './fit'
import { JEV_TIMEOUT_MS, JEV_URL, jevCostOf, keep, parseJev, requestBody, shadowReport } from './jev'

const advice = atom({ plugin: 'model-fit', key: 'advice' } as const, null)
const context = atom({ plugin: 'model-fit', key: 'context' } as const, null)
const verdict = atom({ plugin: 'model-fit', key: 'verdict' } as const, null)

const HISTORY_KEY = 'history'
const SHADOW_KEY = 'shadow'
const JUDGED_BY = 'Haiku'
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

/** This session's judged turns: what they cost, the simple ones and those that did not need the conversation. */
type Tally = { turns: number; usd: number; simple: number; simpleUsd: number; standalone: number; labelUsd: number }

type Judged = { need: Need; scope?: Scope }

type Shadowed = { ask: string; jev: Promise<ShadowJev>; jevUsd: number }

type Session = {
  tally: Tally
  /** Jev's shadow labels, by turn, while the turn runs. */
  shadowed: Map<string, Shadowed>
  /** A failing Jev is reported once a session, not on every ask. */
  isJevReported: boolean
  model: string | undefined
  effort: Effort | undefined
  history: History
  needs: Map<string, Judged>
  /** The smallest context seen this session: roughly what a new session starts from. */
  baseline: number | undefined
  steps: Map<string, number>
  running: Set<string>
  /** Turns that ended before their label came back: concluded when it does. */
  ended: Map<string, Ended>
  typed: string | undefined
  level: number
  isCold: boolean
  cooling: Timer | undefined
  billing: Billing
  /** Routine-ask advice shows once a session: most asks are routine, and it would show after nearly every one. */
  isRoutineAdvised: boolean
}

const setCold = ($: EngineInterface, isCold: boolean) =>
  update($, context, alert => (alert === null || alert.isCold === isCold ? alert : { ...alert, isCold }))

/** The variables that decide the cache lifetime and whether an effort change keeps the cache. */
async function billingEnvOf($: EngineInterface): Promise<BillingEnv> {
  const [bedrock, mantle, vertex, foundry, anthropicAws, apiKey, baseUrl, noBetas, ttl, force5m, enable1h] = await Promise.all([
    $.env.get('CLAUDE_CODE_USE_BEDROCK'),
    $.env.get('CLAUDE_CODE_USE_MANTLE'),
    $.env.get('CLAUDE_CODE_USE_VERTEX'),
    $.env.get('CLAUDE_CODE_USE_FOUNDRY'),
    $.env.get('CLAUDE_CODE_USE_ANTHROPIC_AWS'),
    $.env.get('ANTHROPIC_API_KEY'),
    $.env.get('ANTHROPIC_BASE_URL'),
    $.env.get('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'),
    $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
    $.env.get('FORCE_PROMPT_CACHING_5M'),
    $.env.get('ENABLE_PROMPT_CACHING_1H'),
  ])

  return {
    providers: [bedrock, mantle, vertex, foundry, anthropicAws],
    apiKey,
    baseUrl,
    noBetas,
    ttl,
    force5m,
    enable1h,
  }
}

function isFirstOfItsKind(session: Session, found: Advice) {
  if (found.need !== 'normal') return true
  if (session.isRoutineAdvised) return false

  session.isRoutineAdvised = true

  return true
}

/** The text of the assistant's last reply, so a short go-ahead is judged by the plan it approves. */
async function lastReply($: EngineInterface) {
  const rows = await $.session.messages().catch(() => [])

  for (let at = rows.length - 1; at >= 0; at -= 1) {
    const row = rows[at]

    if (row?.role === 'assistant' && row.text.trim() !== '') return row.text
  }

  return ''
}

async function jevKeyOf($: EngineInterface, options: PluginOptions) {
  if (options.jevShadow !== 'on') return undefined

  const configured = options.typesafeApiKey
  const key = typeof configured === 'string' && configured !== '' ? configured : await $.env.get('TYPESAFE_API_KEY')

  return key === undefined || key === '' ? undefined : key
}

async function askJev($: EngineInterface, key: string, body: string): Promise<ShadowJev> {
  const startedAt = Date.now()
  const timedOut = $.clock.sleep(JEV_TIMEOUT_MS).then(
    () => undefined,
    () => new Promise<never>(() => undefined),
  )

  try {
    const answered = await Promise.race([
      $.http.fetch(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
      }),
      timedOut,
    ])

    if (answered === undefined) {
      return { status: 'failed', reason: `Jev took over ${JEV_TIMEOUT_MS / 1000}s`, tookMs: Date.now() - startedAt }
    }

    return parseJev(answered.status, answered.text, Date.now() - startedAt)
  } catch {
    return { status: 'failed', reason: 'Jev could not be reached', tookMs: Date.now() - startedAt }
  }
}

async function shadowRowsOf($: EngineInterface): Promise<ShadowRow[]> {
  const rows = await $.store.get(SHADOW_KEY).catch(() => undefined)

  return Array.isArray(rows) ? (rows as ShadowRow[]) : []
}

/** Puts Jev's label beside Haiku's for later review; it never changes the advice. */
async function logShadow($: EngineInterface, session: Session, turnId: string, need: Need, ended: Ended) {
  const shadowed = session.shadowed.get(turnId)
  session.shadowed.delete(turnId)

  if (shadowed === undefined) return

  const jev = await shadowed.jev
  const row: ShadowRow = {
    at: Date.now(),
    ask: shadowed.ask,
    haiku: need,
    jev,
    model: ended.usage.model,
    usd: usageCost(ended.usage, ended.usage.model, ended.context, session.billing.ttl).usd,
    jevUsd: shadowed.jevUsd,
  }
  await $.store.set(SHADOW_KEY, keep(await shadowRowsOf($), row))

  if (jev.status === 'failed' && !session.isJevReported) {
    session.isJevReported = true
    $.ui.toast(`model-fit: Jev shadow failed (${jev.reason}); Haiku labels carry on. /fit has the details.`)
  }
}

/** Learns the finished turn, shows what it was judged to need and cost, and leaves advice when it ran on more. */
async function conclude($: EngineInterface, session: Session, turnId: string, judged: Judged, ended: Ended) {
  const { need, scope } = judged
  const found = advise({
    turnId,
    need,
    ...(scope === undefined ? {} : { scope }),
    model: ended.usage.model,
    ...ended,
    ...(session.baseline === undefined ? {} : { baseline: session.baseline }),
    history: session.history,
    billing: session.billing,
  })
  const actual = usageCost(ended.usage, ended.usage.model, ended.context, session.billing.ttl)
  session.history = record(session.history, need, ended.steps, ended.usage.output_tokens)
  await $.store.set(HISTORY_KEY, session.history)
  const { tally } = session
  tally.turns += 1
  tally.usd += actual.usd

  if (need === 'trivial') {
    tally.simple += 1
    tally.simpleUsd += actual.usd
  }

  if (need === 'trivial' && scope === 'standalone') tally.standalone += 1

  await update($, verdict, () => ({
    turnId,
    need,
    ...(scope === undefined ? {} : { scope }),
    on: describeModel(ended.usage.model, ended.effort),
    actual,
    judgedBy: JUDGED_BY,
  }))

  if (found !== undefined && isFirstOfItsKind(session, found)) await update($, advice, () => found)

  $.clock.after(0, () => void logShadow($, session, turnId, need, ended))
}

async function judge($: EngineInterface, options: PluginOptions, session: Session, turnId: string, text: string) {
  const ask = text.slice(0, PROMPT_CHARS)
  const reply = await lastReply($)
  const asked = classifyText(ask, reply)
  const key = await jevKeyOf($, options)

  if (key !== undefined) {
    const body = requestBody(CLASSIFY_BRIEF, ask, reply.slice(-REPLY_CHARS))
    session.shadowed.set(turnId, { ask, jev: askJev($, key, body), jevUsd: jevCostOf(body) })
  }

  const scoped = scopeText(ask, reply)
  session.tally.labelUsd += classifyCostOf(asked) + classifyCostOf(scoped)
  const [label, scopeLabel] = await Promise.all([
    $.model.classify(asked, NEEDS, { model: 'haiku' }).catch(() => undefined),
    $.model.classify(scoped, SCOPES, { model: 'haiku' }).catch(() => undefined),
  ])
  const need = asNeed(label)
  const scope = SCOPES.find(one => one === scopeLabel)
  const ended = session.ended.get(turnId)
  session.ended.delete(turnId)

  if (need === undefined) {
    session.shadowed.delete(turnId)

    return
  }

  const judged: Judged = scope === undefined ? { need } : { need, scope }

  if (ended !== undefined) return conclude($, session, turnId, judged, ended)
  if (!session.running.has(turnId) || session.model === undefined) return

  session.needs.set(turnId, judged)
  const context = (await $.session.usage().catch(() => undefined))?.context.tokens ?? 0
  const warning = warn(turnId, need, session.model, session.effort, context, session.billing)

  if (warning !== undefined && isFirstOfItsKind(session, warning)) await update($, advice, () => warning)
}

const asks = (count: number) => `${count} ${count === 1 ? 'ask' : 'asks'}`

const ASK_WORDS: Record<Need, string> = { trivial: 'Simple', normal: 'Routine', complex: 'Complex' }
const LOOKS: Record<Need, string> = { trivial: 'simple', normal: 'routine', complex: 'complex' }

const keepsCacheNote = (shown: Advice) => (shown.keepsCache === true ? "; it keeps this conversation's cache" : '')

/**
 * The advice: the first line the finding, the second what to do. Caches are per model, so any change of model is
 * priced with the one-time re-cache it costs.
 */
const WORDS: Record<Advice['kind'], (shown: Advice) => [string, string]> = {
  smaller: shown => [
    `${ASK_WORDS[shown.need]} ask on ${shown.on}: ≈ ${dollars(shown.actual?.usd ?? 0)}. On ${shown.target.label} ≈ ${dollars(shown.target.usd ?? 0)} per ask like it.`,
    paysNow(shown)
      ? `Switching re-caches this conversation once (≈ ${dollars(shown.target.switchUsd ?? 0)}) and pays back on the next ask like it.`
      : `Switching re-caches this conversation once (≈ ${dollars(shown.target.switchUsd ?? 0)}); worth it only if ${asks(shown.breakEven ?? 0)} like this follow.`,
  ],
  stay: shown => [
    `${ASK_WORDS[shown.need]} ask on ${shown.on}: ≈ ${dollars(shown.actual?.usd ?? 0)}, mostly rereading ${tokens(shown.context ?? 0)} tokens of conversation.`,
    [
      `Stay on ${shown.on}: moving ${tokens(shown.context ?? 0)} tokens to ${shown.target.label} costs ≈ ${dollars(shown.target.switchUsd ?? 0)} once, ${asks(shown.breakEven ?? 0)} to earn back. Start your next new task on ${shown.target.label}.`,
      ...(shown.lower === undefined ? [] : [`Or /effort ${shown.lower} for asks like it: it keeps this conversation's cache.`]),
    ].join(' '),
  ],
  fresh: shown => [
    `That ask didn't need this conversation, but rereading its ${tokens(shown.context ?? 0)} tokens cost ≈ ${dollars(shown.actual?.usd ?? 0)}.`,
    `Ask ones like it in a new session on ${shown.target.label}: ≈ ${dollars(shown.target.usd ?? 0)}. Keep this one for the work it's about.`,
  ],
  lighter: shown => [
    `${ASK_WORDS[shown.need]} ask on ${shown.on}: ≈ ${dollars(shown.actual?.usd ?? 0)}.`,
    `For asks like it, ${shown.target.command ?? ''} would do and uses fewer tokens${keepsCacheNote(shown)}.`,
  ],
  bigger: shown => [
    `This ask looks ${LOOKS[shown.need]} and runs on ${shown.on}.`,
    `If the answer looks thin, run it again on ${shown.target.label}; moving this conversation there costs ≈ ${dollars(shown.target.switchUsd ?? 0)} once.`,
  ],
  harder: shown => [
    `This ask looks ${LOOKS[shown.need]} and runs on ${shown.on}.`,
    `If the answer looks thin, run ${shown.target.command ?? ''} and ask again${keepsCacheNote(shown)}.`,
  ],
}
const COMPACT = '/compact keep:'
/** The handoff skill this plugin ships; plugin skills are typed with the plugin's name in front. */
const BATON = '/model-fit:baton'

async function putCommand($: EngineInterface, command: string) {
  if ((await $.prompt.read()).text.trim() !== '') {
    $.ui.toast(`model-fit: clear the prompt box first; ${command} goes there`)

    return
  }

  await $.prompt.fill({ text: command, mode: 'replace' })
}

export const register: Register = (on, options) => {
  const session: Session = {
    tally: { turns: 0, usd: 0, simple: 0, simpleUsd: 0, standalone: 0, labelUsd: 0 },
    baseline: undefined,
    shadowed: new Map(),
    isJevReported: false,
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
    billing: { ttl: '1h', isEffortCacheSafe: false },
    isRoutineAdvised: false,
  }

  on('session.start', async ($, e, next) => {
    const settings: Record<string, unknown> = await $.settings.read()
    session.model = typeof settings.model === 'string' ? settings.model : undefined
    session.effort = asEffort(settings.effortLevel)
    session.history = asHistory(await $.store.get(HISTORY_KEY))
    session.billing = billingOf(await billingEnvOf($), settings.promptCacheTtl, options.cacheTtl)
    // Advice belongs to the turn just run; a reload or resume must not draw the last one again.
    await update($, advice, () => null)
    await update($, verdict, () => null)
    await $.command.register({
      name: 'fit',
      description: 'Model fit: what tasks cost so far, and the Jev shadow comparison; "/fit reset" forgets it',
    })

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
      await update($, verdict, () => null)
      session.running.add(e.turnId)
      $.clock.after(0, () => void judge($, options, session, e.turnId, text))
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
    session.cooling = $.clock.after(CACHE_LIFETIME_MS[session.billing.ttl], () => {
      session.isCold = true
      void setCold($, true)
    })
    const wasTyped = session.running.delete(e.turnId)
    const judged = session.needs.get(e.turnId)
    const steps = session.steps.get(e.turnId) ?? 0
    session.needs.delete(e.turnId)
    session.steps.delete(e.turnId)

    if (!wasTyped || e.usage === undefined || e.isAborted) {
      session.shadowed.delete(e.turnId)

      return done
    }

    const usage = await $.session.usage()
    const ended: Ended = { usage: e.usage, context: usage.context.tokens ?? 0, steps, effort: session.effort }

    if (judged === undefined) session.ended.set(e.turnId, ended)
    else await conclude($, session, e.turnId, judged, ended)

    return done
  })

  on('session.measure', async ($, e, next) => {
    const count = e.context.tokens

    if (count === undefined) return next(e)

    const level = contextLevel(count)

    if (level > session.level && session.model !== undefined) {
      const alert = contextAlert(count, session.model, session.effort, session.billing.ttl)
      await update($, context, () => alert)
    } else if (level < session.level) {
      await update($, context, () => null)
    }

    session.level = level

    if (count > 0) session.baseline = Math.min(session.baseline ?? count, count)

    return next(e)
  })

  on('command.run', { command: 'fit' }, async ($, e) => {
    if (e.args.trim() === 'reset') {
      session.history = emptyHistory()
      await $.store.delete(HISTORY_KEY)
      await $.store.delete(SHADOW_KEY)

      return { text: 'Forgot the cost history and the Jev shadow log.' }
    }

    const current = session.model === undefined ? 'unknown' : describeModel(session.model, session.effort)
    const rows = NEEDS.map(need => {
      const typical = typicalTurn(session.history, need)
      const { turns, misses } = session.history[need]
      const learned = turns === 0 ? 'a guess so far' : `from ${turns} turns`
      const missed = misses === 0 ? '' : `; ${misses} more ran over 3x that, so their label was wrong`

      return `${need}: ~${typical.steps} steps, ~${tokens(typical.output)} output tok (${learned}${missed})`
    })
    const { tally } = session
    const spent =
      tally.turns === 0
        ? 'This session: no ask judged yet.'
        : `This session: ${tally.turns} ${tally.turns === 1 ? 'ask' : 'asks'} judged, ≈ ${dollars(tally.usd)}. ${tally.simple} simple, ≈ ${dollars(tally.simpleUsd)}; ${tally.standalone} of those did not need the conversation. Labelling with Haiku ≈ ${dollars(tally.labelUsd)}.`
    const shadow =
      (await jevKeyOf($, options)) === undefined
        ? ['Jev shadow: off (opt in with the jevShadow option and a TypeSafe key).']
        : shadowReport(await shadowRowsOf($))

    return {
      text: [`On ${current}.`, ...rows, '', spent, 'List-price estimates; /cost has the real figure.', '', ...shadow].join('\n'),
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, advice)
    const heavy = await read($, context)
    const judged = await read($, verdict)

    const below = await next(e)

    if (e.props.hasSurvey || (shown === null && heavy === null && judged === null)) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const isWarning = shown?.kind === 'bigger' || shown?.kind === 'harder'
    const command = shown?.kind === 'stay' || shown?.kind === 'fresh' ? undefined : shown?.target.command
    const lower = shown?.kind === 'stay' ? shown.lower : undefined

    return (
      <Box flexDirection="column">
        {judged === null || shown !== null ? null : (
          <Box key="verdict">
            <Text dimColor wrap="wrap">
              ◇ {NEED_WORDS[judged.need]} · {judged.on} · ≈ {dollars(judged.actual.usd)} · judged by {judged.judgedBy}{' '}
            </Text>
            <Button key="dismiss-verdict" label="Dismiss" plain dimColor onPress={() => update($, verdict, () => null)} />
          </Box>
        )}
        {shown === null ? null : (
          <Box key="advice" flexDirection="column">
            <Box>
              <Text color={isWarning ? 'warning' : 'suggestion'}>{isWarning ? '▲ ' : '◆ '}</Text>
              <Text wrap="wrap">
                {WORDS[shown.kind](shown)[0]} <Text dimColor>Judged by {JUDGED_BY}.</Text>
              </Text>
            </Box>
            <Box>
              <Text wrap="wrap">
                {'  '}
                {WORDS[shown.kind](shown)[1]}{' '}
              </Text>
              {command === undefined ? null : (
                <Button key="use" label={`Put ${command} in prompt`} onPress={() => putCommand($, command)} />
              )}
              {lower === undefined ? null : (
                <Button key="effort" label={`Put /effort ${lower} in prompt`} onPress={() => putCommand($, `/effort ${lower}`)} />
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
            <Text wrap="wrap">
              {'  '}New task: /clear (this one stays in /resume). Same task: /compact what to keep, or {BATON} to pick it up later. Wrong turn: /rewind.
            </Text>
            {heavy.isCold ? (
              <Text key="cold" dimColor wrap="wrap">
                {'  '}After this pause the cache has expired: the next action rereads all of it for ≈ {dollars(heavy.coldUsd)} on {heavy.on}. Shrink it first: {BATON} to pick up later, /compact to carry on now. This is also the cheapest moment to change model.
              </Text>
            ) : null}
            <Box>
              <Text>{'  '}</Text>
              <Button key="compact" label="Put /compact in prompt" onPress={() => putCommand($, COMPACT)} />
              <Text> </Text>
              <Button key="baton" label={`Put ${BATON} in prompt`} onPress={() => putCommand($, BATON)} />
              <Text> </Text>
              <Button key="dismiss-context" label="Dismiss" onPress={() => update($, context, () => null)} />
            </Box>
          </Box>
        )}
        {below.type === 'engine' ? null : below}
      </Box>
    )
  })
}
