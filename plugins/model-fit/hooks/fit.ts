import type { Advice, ContextAlert, Cost, Effort, Need, Tier } from '../types'

type Price = { input: number; output: number; cacheRead: number }
type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type Totals = { turns: number; steps: number; output: number }
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

const SEED: History = {
  trivial: { turns: 1, steps: 2, output: 800 },
  normal: { turns: 1, steps: 8, output: 5_000 },
  complex: { turns: 1, steps: 25, output: 20_000 },
}

export const FRESH_CONTEXT = 20_000
const WORTH_SWITCHING = 0.75
const HEAVY_EFFORT: readonly Effort[] = ['high', 'xhigh', 'max']
export const CONTEXT_LEVELS = [100_000, 200_000, 400_000, 700_000]
const BIG_CONTEXT = CONTEXT_LEVELS[0] ?? 100_000

export const NEEDS: readonly Need[] = ['trivial', 'normal', 'complex']

export const CLASSIFY_BRIEF = [
  'A request to a coding agent working in a repository. Label how much model it needs.',
  'trivial: a lookup, a one-line or one-file edit, a rename, a git or shell chore, a question one file answers.',
  'complex: designing something, a feature across several modules, debugging a cause nobody knows yet, a wide refactor, a security or concurrency question.',
  'normal: everything else.',
  '',
  'Request:',
].join('\n')

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
  trivial: { turns: 0, steps: 0, output: 0 },
  normal: { turns: 0, steps: 0, output: 0 },
  complex: { turns: 0, steps: 0, output: 0 },
})

export function record(history: History, need: Need, steps: number, output: number): History {
  const was = history[need]

  return { ...history, [need]: { turns: was.turns + 1, steps: was.steps + steps, output: was.output + output } }
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

function turnCost(tier: Tier, context: number, steps: number, output: number, isCold: boolean): Cost {
  const price = priceOf(tier, context)
  const firstStep = context * (isCold ? price.input * CACHE_WRITE : price.cacheRead)
  const laterSteps = (steps - 1) * context * price.cacheRead
  const usd = (firstStep + laterSteps + output * price.output) / MILLION

  return { tokens: steps * context + output, usd }
}

export function usageCost(usage: Usage, model: string): Cost {
  const price = PRICE[tierOf(model) ?? 'large']
  const input =
    (usage.input_tokens + usage.cache_creation_input_tokens * CACHE_WRITE) * price.input +
    usage.cache_read_input_tokens * price.cacheRead
  const tokens =
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens + usage.output_tokens

  return { tokens, usd: (input + usage.output_tokens * price.output) / MILLION }
}

type Situation = {
  turnId: string
  need: Need
  model: string
  effort: Effort | undefined
  context: number
  isCold: boolean
  history: History
}

export function advise(now: Situation): Advice | undefined {
  const tier = tierOf(now.model)

  if (tier === undefined || now.need === 'normal') return undefined

  const typical = typicalTurn(now.history, now.need)
  const estimate = turnCost(tier, now.context, typical.steps, typical.output, now.isCold)
  const base = { turnId: now.turnId, need: now.need, on: describeModel(now.model, now.effort), estimate, isApplied: false }

  if (now.need === 'trivial' && tier !== 'small') {
    const onSmall = turnCost('small', now.context, typical.steps, typical.output, true)

    if (onSmall.usd <= estimate.usd * WORTH_SWITCHING) {
      return { ...base, kind: 'smaller', target: { model: ALIAS.small, label: 'Haiku', cost: onSmall } }
    }

    if (now.effort !== undefined && HEAVY_EFFORT.includes(now.effort)) {
      const lighter = turnCost(tier, now.context, typical.steps, Math.round(typical.output / 2), false)

      return { ...base, kind: 'lighter', target: { effort: 'low', label: 'low effort', cost: lighter } }
    }

    const note =
      now.context >= BIG_CONTEXT
        ? `Haiku would do, but with ${tokens(now.context)} of context switching costs more than it saves. Small asks are cheaper in a fresh session.`
        : `Haiku would do, but this session's cache makes staying nearly as cheap (Haiku ≈ ${dollars(onSmall.usd)}). Next time, start small asks on Haiku.`

    return { ...base, kind: 'stay', note }
  }

  if (now.need === 'complex' && tier === 'small') {
    const onLarge = turnCost('large', now.context, typical.steps, typical.output, true)

    return { ...base, kind: 'bigger', target: { model: ALIAS.large, label: 'Opus', cost: onLarge } }
  }

  if (now.need === 'complex' && now.effort === 'low') {
    const harder = turnCost(tier, now.context, typical.steps, typical.output * 2, false)

    return { ...base, kind: 'harder', target: { effort: 'high', label: 'high effort', cost: harder } }
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

export const dollars = (usd: number) => (usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`)

export const NEED_WORDS: Record<Need, string> = {
  trivial: 'Looks simple',
  normal: 'Looks routine',
  complex: 'Looks complex',
}
