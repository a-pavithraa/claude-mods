import type { Advice, ContextAlert, Cost, Effort, Need, Tier } from '../types'

type Price = { input: number; output: number; cacheRead: number }
type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** `misses`: turns given this label that ran far past it, so the label was wrong. */
export type Totals = { turns: number; steps: number; output: number; misses: number }
export type History = Record<Need, Totals>

// List prices in USD per million tokens for the current models (Haiku 5.5, Sonnet 5.5, Opus 5.5,
// Fable 5.1), checked 2026-10-10; /cost stays the authority on what was actually spent.
const PRICE: Record<Tier, Price> = {
  small: { input: 0.1, output: 0.5, cacheRead: 0.01 },
  mid: { input: 2, output: 10, cacheRead: 0.2 },
  large: { input: 4, output: 20, cacheRead: 0.2 },
  top: { input: 10, output: 50, cacheRead: 0.25 },
}
const SMALL_LONG_PROMPT = 100_000
const SMALL_LONG_PRICE: Price = { input: 0.5, output: 2.5, cacheRead: 0.05 }
const CACHE_WRITE = 2
const MILLION = 1_000_000

const priceOf = (tier: Tier, context: number) =>
  tier === 'small' && context > SMALL_LONG_PROMPT ? SMALL_LONG_PRICE : PRICE[tier]
export const CACHE_LIFETIME_MS = 60 * 60_000

const LABEL: Record<Tier, string> = { small: 'Haiku', mid: 'Sonnet', large: 'Opus', top: 'Fable' }
const ALIAS: Record<Tier, string> = { small: 'haiku', mid: 'sonnet', large: 'opus', top: 'fable' }

const SEED: Record<Need, Omit<Totals, 'misses'>> = {
  trivial: { turns: 1, steps: 2, output: 800 },
  normal: { turns: 1, steps: 8, output: 5_000 },
  complex: { turns: 1, steps: 25, output: 20_000 },
}

const WORTH_SWITCHING = 0.75
/** A turn this many times its label's typical steps was labelled wrong: counted as a miss, not learned from. */
const MISLABEL_FACTOR = 3
const REPLY_CHARS = 1_200
const HEAVY_EFFORT: readonly Effort[] = ['high', 'xhigh', 'max']
export const CONTEXT_LEVELS = [100_000, 200_000, 400_000, 700_000]

export const NEEDS: readonly Need[] = ['trivial', 'normal', 'complex']

export const CLASSIFY_BRIEF = [
  'A request to a coding agent working in a repository. Label how much model it needs.',
  'trivial: a lookup, a one-line or one-file edit, a rename, a git or shell chore, a question one file answers.',
  'complex: designing something, a feature across several modules, debugging a cause nobody knows yet, a wide refactor, a security or concurrency question.',
  'normal: everything else.',
  'A short go-ahead ("yes", "do it", "go on") approves the plan in the previous reply: label the work that plan needs.',
].join('\n')

export const classifyText = (request: string, previousReply: string) =>
  [CLASSIFY_BRIEF, '', 'Previous assistant reply (context only):', previousReply.slice(-REPLY_CHARS), '', 'Request:', request].join('\n')

export function tierOf(model: string | undefined): Tier | undefined {
  if (model === undefined) return undefined
  if (/haiku/i.test(model)) return 'small'
  if (/sonnet/i.test(model)) return 'mid'
  if (/opus/i.test(model)) return 'large'
  if (/fable/i.test(model)) return 'top'

  return undefined
}

export const describeModel = (model: string, effort: Effort | undefined) => {
  const tier = tierOf(model)
  const name = tier === undefined ? model : LABEL[tier]

  return effort === undefined ? name : `${name}/${effort}`
}

export const emptyHistory = (): History => ({
  trivial: { turns: 0, steps: 0, output: 0, misses: 0 },
  normal: { turns: 0, steps: 0, output: 0, misses: 0 },
  complex: { turns: 0, steps: 0, output: 0, misses: 0 },
})

/** Learns a finished turn, or counts it as a miss when it ran far past its label. */
export function record(history: History, need: Need, steps: number, output: number): History {
  const was = history[need]

  if (isMislabelled(history, need, steps)) return { ...history, [need]: { ...was, misses: was.misses + 1 } }

  return { ...history, [need]: { ...was, turns: was.turns + 1, steps: was.steps + steps, output: was.output + output } }
}

export function typicalTurn(history: History, need: Need) {
  const seen = history[need]
  const seed = SEED[need]
  const turns = seen.turns + seed.turns

  return {
    steps: Math.max(1, Math.round((seen.steps + seed.steps) / turns)),
    output: Math.round((seen.output + seed.output) / turns),
    isLearned: seen.turns > 0,
  }
}

export const isMislabelled = (history: History, need: Need, steps: number) =>
  steps > typicalTurn(history, need).steps * MISLABEL_FACTOR

/** `context` is the conversation's size, which sets Haiku's long-prompt price. */
export function usageCost(usage: Usage, model: string, context = 0): Cost {
  const price = priceOf(tierOf(model) ?? 'large', context)
  const input =
    (usage.input_tokens + usage.cache_creation_input_tokens * CACHE_WRITE) * price.input +
    usage.cache_read_input_tokens * price.cacheRead
  const tokens =
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens + usage.output_tokens

  return { tokens, usd: (input + usage.output_tokens * price.output) / MILLION }
}

/** Before the work: a complex ask on a model or effort that may give a thin answer. */
export function warn(turnId: string, need: Need, model: string, effort: Effort | undefined): Advice | undefined {
  if (need !== 'complex') return undefined

  const on = describeModel(model, effort)

  if (tierOf(model) === 'small') {
    return { turnId, need, kind: 'bigger', on, target: { label: 'Opus', command: '/model opus' } }
  }

  if (effort === 'low') return { turnId, need, kind: 'harder', on, target: { label: 'high effort' } }

  return undefined
}

type Finished = {
  turnId: string
  need: Need
  model: string
  effort: Effort | undefined
  usage: Usage
  context: number
  steps: number
  history: History
}

/**
 * After the work, for the next ask like it: a simple ask that ran on a bigger model than it needed, priced from
 * what the turn really used. A turn that ran far past its label was not simple, so it gets no advice.
 */
export function advise(turn: Finished): Advice | undefined {
  const tier = tierOf(turn.model)

  if (tier === undefined || tier === 'small' || turn.need !== 'trivial') return undefined
  if (isMislabelled(turn.history, turn.need, turn.steps)) return undefined

  const actual = usageCost(turn.usage, turn.model, turn.context)
  const onSmall = usageCost(turn.usage, ALIAS.small, turn.context)
  const base = { turnId: turn.turnId, need: turn.need, on: describeModel(turn.model, turn.effort), actual }

  if (onSmall.usd <= actual.usd * WORTH_SWITCHING) {
    return { ...base, kind: 'smaller', target: { label: 'Haiku', command: `/model ${ALIAS.small}`, usd: onSmall.usd } }
  }

  if (turn.effort !== undefined && HEAVY_EFFORT.includes(turn.effort)) {
    return { ...base, kind: 'lighter', target: { label: 'low effort' } }
  }

  return undefined
}

export const contextLevel = (count: number) => CONTEXT_LEVELS.filter(level => count >= level).length

export function contextAlert(count: number, model: string, effort: Effort | undefined): ContextAlert {
  const price = priceOf(tierOf(model) ?? 'large', count)

  return {
    tokens: count,
    on: describeModel(model, effort),
    cachedUsd: (count * price.cacheRead) / MILLION,
    coldUsd: (count * CACHE_WRITE * price.input) / MILLION,
    isCold: false,
  }
}

export function tokens(count: number) {
  if (count >= MILLION) return `${(count / MILLION).toFixed(1)}M`
  if (count >= 1000) return `${Math.round(count / 1000)}k`

  return String(count)
}

/** At list prices, an estimate: /cost and the bill are the authority. */
export const dollars = (usd: number) => (usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`)

export const NEED_WORDS: Record<Need, string> = {
  trivial: 'Looks simple',
  normal: 'Looks routine',
  complex: 'Looks complex',
}
