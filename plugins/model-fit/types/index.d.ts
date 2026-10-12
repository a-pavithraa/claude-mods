export type Need = 'trivial' | 'normal' | 'complex'
export type Tier = 'small' | 'mid' | 'large' | 'top'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Cost = { tokens: number; usd: number }

/** How long the main conversation's cache lives; it also sets the write price, 1.25x input for 5m, 2x for 1h. */
export type CacheTtl = '5m' | '1h'

/** How this session is billed, as far as it moves the advice: `isEffortCacheSafe` when an effort change can keep the cache. */
export type Billing = { ttl: CacheTtl; isEffortCacheSafe: boolean }

/**
 * The environment variables behind Billing: `providers` the CLAUDE_CODE_USE_* switches for Bedrock, Mantle, Agent
 * Platform, Foundry and Claude Platform on AWS; `noBetas` CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS; `ttl`
 * CLAUDE_CODE_PROMPT_CACHE_TTL; `force5m` and `enable1h` FORCE_PROMPT_CACHING_5M and ENABLE_PROMPT_CACHING_1H.
 */
export type BillingEnv = {
  providers: (string | undefined)[]
  apiKey?: string
  baseUrl?: string
  noBetas?: string
  ttl?: string
  force5m?: string
  enable1h?: string
}

/** Whether an ask needed the conversation it was asked in, or could have been asked in a new session. */
export type Scope = 'standalone' | 'conversation'

/**
 * What to use next time. `command` is what the user types to switch; `usd` what the turn would have cost on it
 * with its cache warm; `switchUsd` the one-time cost of caching this conversation on it, since caches are per model.
 */
export type Target = { label: string; command?: string; usd?: number; switchUsd?: number }

/**
 * `bigger` warns while an ask runs on a smaller model than its label needs, `harder` while a complex one runs at low
 * effort. After a simple or routine ask ran on too much, for the next ask like it: `smaller` when switching pays
 * back within `breakEven` asks, `stay` when it would not, `fresh` when the ask did not need the conversation and a
 * new session is the cheaper place for it, `lighter` when only the effort was too high. `actual` is what the turn
 * cost; `context` the conversation's size. `lower` is an effort to offer beside `stay`; `keepsCache` whether an
 * effort change keeps this conversation's cache.
 */
export type Advice = {
  turnId: string
  need: Need
  kind: 'smaller' | 'stay' | 'fresh' | 'lighter' | 'bigger' | 'harder'
  on: string
  target: Target
  actual?: Cost
  context?: number
  breakEven?: number
  lower?: Effort
  keepsCache?: boolean
}

export type ContextAlert = { tokens: number; on: string; cachedUsd: number; coldUsd: number; isCold: boolean }

/** What the finished turn was judged to need and what it cost: shown even when there is no advice. */
export type TurnVerdict = { turnId: string; need: Need; scope?: Scope; on: string; actual: Cost; judgedBy: string }

/** Jev's label in shadow mode: no `label` when its top share is under the bar, so no call was made. */
export type ShadowJev =
  | { status: 'judged'; label?: Need; confidence: number; shares: number[]; tookMs: number }
  | { status: 'failed'; reason: string; tookMs: number }

export type ShadowRow = {
  at: number
  ask: string
  haiku: Need
  jev: ShadowJev
  model: string
  usd: number
  jevUsd: number
}

declare module 'claude-code' {
  interface PluginState {
    'model-fit': { advice: Advice | null; context: ContextAlert | null; verdict: TurnVerdict | null }
  }
}
