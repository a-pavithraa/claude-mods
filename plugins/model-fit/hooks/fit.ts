import type { Advice, Billing, BillingEnv, CacheTtl, ContextAlert, Cost, Effort, Need, Scope, Tier } from '../types'

type Price = { input: number; output: number; cacheRead: number }
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** `misses`: turns given this label that ran far past it, so the label was wrong. */
export type Totals = { turns: number; steps: number; output: number; misses: number }
export type History = Record<Need, Totals>

// List prices in USD per million tokens for the current models (Haiku 5.5, Sonnet 5.5, Opus 5.5,
// Fable 5.1), from platform.claude.com/docs/en/about-claude/pricing on 2026-10-12; /cost stays the authority on
// what was actually spent.
const PRICE: Record<Tier, Price> = {
  small: { input: 0.1, output: 0.5, cacheRead: 0.01 },
  mid: { input: 2, output: 10, cacheRead: 0.1 },
  large: { input: 4, output: 20, cacheRead: 0.2 },
  top: { input: 10, output: 50, cacheRead: 0.25 },
}
const SMALL_LONG_PROMPT = 100_000
const SMALL_LONG_PRICE: Price = { input: 0.5, output: 2.5, cacheRead: 0.05 }
/** Cache writes cost this many times the input price, by how long the entry lives. */
const CACHE_WRITE: Record<CacheTtl, number> = { '5m': 1.25, '1h': 2 }
export const CACHE_LIFETIME_MS: Record<CacheTtl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
const MILLION = 1_000_000

const priceOf = (tier: Tier, context: number) =>
  tier === 'small' && context > SMALL_LONG_PROMPT ? SMALL_LONG_PRICE : PRICE[tier]

const LABEL: Record<Tier, string> = { small: 'Haiku', mid: 'Sonnet', large: 'Opus', top: 'Fable' }
const ALIAS: Record<Tier, string> = { small: 'haiku', mid: 'sonnet', large: 'opus', top: 'fable' }
const TIERS: readonly Tier[] = ['small', 'mid', 'large', 'top']
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** The model and effort each label needs, from Claude Code's guidance on choosing an effort level. */
const FIT: Record<Need, { tier: Tier; effort: Effort }> = {
  trivial: { tier: 'small', effort: 'low' },
  normal: { tier: 'mid', effort: 'medium' },
  complex: { tier: 'large', effort: 'high' },
}

/**
 * The models on which an effort change keeps the cache (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1), and those of
 * them whose default effort is medium; a bare alias names the current model.
 */
const CURRENT = /^(opus|sonnet|haiku)(\[1m\])?$|(opus|sonnet|haiku)-5-5|fable-5-1/i
const MEDIUM_DEFAULT = /^(opus|sonnet|haiku)(\[1m\])?$|(opus|sonnet|haiku)-5-5/i

const defaultEffort = (model: string): Effort => (MEDIUM_DEFAULT.test(model) ? 'medium' : 'high')
const above = (effort: Effort, than: Effort) => EFFORTS.indexOf(effort) > EFFORTS.indexOf(than)

/** Whether changing effort keeps this conversation's cache on `model`, rather than rebuilding it. */
export const keepsCacheOnEffort = (model: string, billing: Billing) => billing.isEffortCacheSafe && CURRENT.test(model)

const isOn = (value: string | undefined) => value !== undefined && value !== '' && value !== '0'
const asTtl = (value: unknown): CacheTtl | undefined => (value === '5m' || value === '1h' ? value : undefined)

/**
 * The main conversation's cache lifetime, in Claude Code's own order: FORCE_PROMPT_CACHING_5M, the TTL variable,
 * the promptCacheTtl setting, ENABLE_PROMPT_CACHING_1H, then the default, which is an hour only on a subscription.
 * A subscription that has run into usage credits drops to five minutes, which a mod cannot see: `override` fixes it.
 * An effort change keeps the cache only with an API key or a subscription straight to Anthropic.
 */
export function billingOf(env: BillingEnv, setting: unknown, override: unknown): Billing {
  const viaProvider = env.providers.some(isOn)
  const isEffortCacheSafe = !viaProvider && !isOn(env.noBetas) && !isOn(env.baseUrl)
  const detected = isOn(env.force5m)
    ? '5m'
    : (asTtl(env.ttl) ?? asTtl(setting) ?? (isOn(env.enable1h) ? '1h' : viaProvider || isOn(env.apiKey) ? '5m' : '1h'))

  return { ttl: asTtl(override) ?? detected, isEffortCacheSafe }
}

const SEED: Record<Need, Omit<Totals, 'misses'>> = {
  trivial: { turns: 1, steps: 2, output: 800 },
  normal: { turns: 1, steps: 8, output: 5_000 },
  complex: { turns: 1, steps: 25, output: 20_000 },
}

const WORTH_SWITCHING = 0.75
/** Switching models pays back on the next ask like this one: recommend it. */
const PAYS_NOW = 1
/** Pays back only if a run of this many simple asks follows; past it, staying is the right call. */
const PAYS_SOON = 4
/** A standalone ask that reread at least this many tokens of conversation it did not need belongs in a new session. */
const UNNEEDED_CONTEXT = 30_000
/** Below this, re-caching on a change of effort costs too little to weigh, where the change does not keep the cache. */
const SMALL_CONTEXT = 50_000
/** A turn this many times its label's typical steps was labelled wrong: counted as a miss, not learned from. */
const MISLABEL_FACTOR = 3
export const REPLY_CHARS = 1_200
export const CONTEXT_LEVELS = [100_000, 200_000, 400_000, 700_000]

export const NEEDS: readonly Need[] = ['trivial', 'normal', 'complex']

export const CLASSIFY_BRIEF = [
  'A request to a coding agent working in a repository. Label how much model it needs.',
  'trivial: a lookup, a one-line or one-file edit, a rename within one file, a git or shell chore, a question one file answers, a general concept or arithmetic question that needs no code read ("what is a hashmap", "2 plus 2").',
  'complex: designing something, a feature across several modules, debugging a cause nobody knows yet, a wide refactor, a security or concurrency question.',
  'normal: everything else, including a rename or find-and-replace across many files ("rename X everywhere").',
  'A short go-ahead ("yes", "do it", "go on") approves the plan in the previous reply: label the work that plan needs.',
].join('\n')

export const classifyText = (request: string, previousReply: string) =>
  [CLASSIFY_BRIEF, '', 'Previous assistant reply (context only):', previousReply.slice(-REPLY_CHARS), '', 'Request:', request].join('\n')

export const SCOPES: readonly Scope[] = ['standalone', 'conversation']

export const SCOPE_BRIEF = [
  'A request to a coding agent, in the middle of a conversation. Does answering it need that conversation?',
  'conversation: it refers to or depends on earlier turns: files or changes discussed, a plan, "it", "that", "the changes", a go-ahead.',
  'standalone: a brand-new session with no history would answer it just as well: a general question, arithmetic, a self-contained lookup.',
].join('\n')

export const scopeText = (request: string, previousReply: string) =>
  [SCOPE_BRIEF, '', 'Previous assistant reply (context only):', previousReply.slice(-REPLY_CHARS), '', 'Request:', request].join('\n')

/**
 * The one-time cost of moving this conversation onto `tier`: caches are per model, so its first request writes the
 * whole context instead of reading it.
 */
export function switchCost(tier: Tier, context: number, ttl: CacheTtl) {
  const price = priceOf(tier, context)

  return (context * (CACHE_WRITE[ttl] * price.input - price.cacheRead)) / MILLION
}

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
export function usageCost(usage: Usage, model: string, context: number, ttl: CacheTtl): Cost {
  const price = priceOf(tierOf(model) ?? 'large', context)
  const input =
    (usage.input_tokens + usage.cache_creation_input_tokens * CACHE_WRITE[ttl]) * price.input +
    usage.cache_read_input_tokens * price.cacheRead
  const tokens =
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens + usage.output_tokens

  return { tokens, usd: (input + usage.output_tokens * price.output) / MILLION }
}

/**
 * Before the work: an ask on a smaller model than its label needs, or a complex ask at low effort, may give a thin
 * answer.
 */
export function warn(
  turnId: string,
  need: Need,
  model: string,
  effort: Effort | undefined,
  context: number,
  billing: Billing,
): Advice | undefined {
  const on = describeModel(model, effort)
  const fit = FIT[need]

  if (need !== 'trivial' && tierOf(model) === 'small') {
    return {
      turnId,
      need,
      kind: 'bigger',
      on,
      context,
      target: {
        label: LABEL[fit.tier],
        command: `/model ${ALIAS[fit.tier]}`,
        switchUsd: switchCost(fit.tier, context, billing.ttl),
      },
    }
  }

  if (need === 'complex' && effort === 'low') {
    return {
      turnId,
      need,
      kind: 'harder',
      on,
      keepsCache: keepsCacheOnEffort(model, billing),
      target: { label: `${fit.effort} effort`, command: `/effort ${fit.effort}` },
    }
  }

  return undefined
}

type Finished = {
  turnId: string
  need: Need
  /** Whether the ask needed this conversation; undefined when that could not be judged. */
  scope?: Scope
  model: string
  effort: Effort | undefined
  usage: Usage
  context: number
  /** The smallest context seen this session: what a new session starts from. */
  baseline?: number
  steps: number
  history: History
  billing: Billing
}

/** What the turn would have cost on `tier` in a new session: the baseline written once and reread per step. */
function freshCost(turn: Finished, baseline: number, tier: Tier) {
  const fresh: Usage = {
    input_tokens: turn.usage.input_tokens,
    output_tokens: turn.usage.output_tokens,
    cache_creation_input_tokens: baseline,
    cache_read_input_tokens: baseline * Math.max(0, turn.steps - 1),
  }

  return usageCost(fresh, ALIAS[tier], baseline, turn.billing.ttl)
}

/**
 * The turn as the next ask like it would run on a warm cache. A turn that wrote at least half the context to the
 * cache rebuilt it, a one-time cost; the next ask rereads those tokens instead, so the write becomes a read.
 */
function warmed(usage: Usage, context: number): Usage {
  if (usage.cache_creation_input_tokens * 2 < context) return usage

  return {
    ...usage,
    cache_read_input_tokens: usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
    cache_creation_input_tokens: 0,
  }
}

/**
 * After the work, for the next ask like it, when a simple or routine ask ran on a bigger model or a higher effort
 * than its label needs. Caches are per model, so a model switch is weighed against the re-cache it costs: an ask
 * that did not need the conversation is pointed at a new session; one that did is told to switch only when the
 * saving per ask earns the re-cache back quickly, and to stay otherwise. A lower effort is offered where changing
 * effort keeps the cache, or where the context is too small for the re-cache to matter. Its saving is not priced:
 * the docs publish no output per effort level. The other model is priced as if it wrote the same output. A turn
 * that ran far past its label gets no advice.
 */
export function advise(turn: Finished): Advice | undefined {
  const tier = tierOf(turn.model)

  if (tier === undefined || turn.need === 'complex') return undefined
  if (isMislabelled(turn.history, turn.need, turn.steps)) return undefined

  const fit = FIT[turn.need]
  const { ttl } = turn.billing
  const actual = usageCost(turn.usage, turn.model, turn.context, ttl)
  const base = {
    turnId: turn.turnId,
    need: turn.need,
    on: describeModel(turn.model, turn.effort),
    actual,
    context: turn.context,
  }
  const keepsCache = keepsCacheOnEffort(turn.model, turn.billing)
  const isEffortHigh = above(turn.effort ?? defaultEffort(turn.model), fit.effort)
  const lower = isEffortHigh && (keepsCache || turn.context < SMALL_CONTEXT) ? fit.effort : undefined

  if (TIERS.indexOf(tier) > TIERS.indexOf(fit.tier)) {
    const unneeded = turn.context - (turn.baseline ?? 0)

    if (turn.scope === 'standalone' && turn.baseline !== undefined && unneeded >= UNNEEDED_CONTEXT) {
      return { ...base, kind: 'fresh', target: { label: LABEL[fit.tier], usd: freshCost(turn, turn.baseline, fit.tier).usd } }
    }

    const recurring = warmed(turn.usage, turn.context)
    const onFit = usageCost(recurring, ALIAS[fit.tier], turn.context, ttl)
    const saving = usageCost(recurring, turn.model, turn.context, ttl).usd - onFit.usd
    const switchUsd = switchCost(fit.tier, turn.context, ttl)
    const target = { label: LABEL[fit.tier], command: `/model ${ALIAS[fit.tier]}`, usd: onFit.usd, switchUsd }

    if (onFit.usd <= (onFit.usd + saving) * WORTH_SWITCHING && saving > 0) {
      const breakEven = Math.max(1, Math.ceil(switchUsd / saving))

      if (breakEven <= PAYS_SOON) return { ...base, kind: 'smaller', breakEven, target }

      return { ...base, kind: 'stay', breakEven, target, ...(lower !== undefined && keepsCache ? { lower, keepsCache } : {}) }
    }
  }

  if (lower === undefined) return undefined

  return { ...base, kind: 'lighter', keepsCache, target: { label: `${lower} effort`, command: `/effort ${lower}` } }
}

export const paysNow = (shown: Advice) => (shown.breakEven ?? Infinity) <= PAYS_NOW

export const contextLevel = (count: number) => CONTEXT_LEVELS.filter(level => count >= level).length

export function contextAlert(count: number, model: string, effort: Effort | undefined, ttl: CacheTtl): ContextAlert {
  const price = priceOf(tierOf(model) ?? 'large', count)

  return {
    tokens: count,
    on: describeModel(model, effort),
    cachedUsd: (count * price.cacheRead) / MILLION,
    coldUsd: (count * CACHE_WRITE[ttl] * price.input) / MILLION,
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
  trivial: 'Looked simple',
  normal: 'Looked routine',
  complex: 'Looked complex',
}

const CHARS_PER_TOKEN = 4
const LABEL_TOKENS = 5

/** The Haiku labelling call's own cost, guessed from its text: the API does not report it to a mod. */
export const classifyCostOf = (text: string) =>
  ((text.length / CHARS_PER_TOKEN) * PRICE.small.input + LABEL_TOKENS * PRICE.small.output) / MILLION
