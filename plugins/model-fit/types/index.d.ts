export type Need = 'trivial' | 'normal' | 'complex'
export type Tier = 'small' | 'mid' | 'large' | 'top'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Cost = { tokens: number; usd: number }

/** What to use next time; `command` is what the user types to switch, `usd` what the turn would have cost on it. */
export type Target = { label: string; command?: string; usd?: number }

/**
 * `bigger` and `harder` warn while a complex ask runs on too little; `smaller` and `lighter` come after a simple
 * ask ran on too much, with `actual`, what it cost, for the next ask like it.
 */
export type Advice = {
  turnId: string
  need: Need
  kind: 'smaller' | 'lighter' | 'bigger' | 'harder'
  on: string
  target: Target
  actual?: Cost
}

export type ContextAlert = { tokens: number; on: string; cachedUsd: number; coldUsd: number; isCold: boolean }

declare module 'claude-code' {
  interface PluginState {
    'model-fit': { advice: Advice | null; context: ContextAlert | null }
  }
}
