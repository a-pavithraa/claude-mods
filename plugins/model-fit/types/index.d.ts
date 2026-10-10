export type Need = 'trivial' | 'normal' | 'complex'
export type Tier = 'small' | 'mid' | 'large' | 'top'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Cost = { tokens: number; usd: number }

export type Target = { model?: string; effort?: Effort; label: string; cost: Cost }

export type Advice = {
  turnId: string
  need: Need
  kind: 'smaller' | 'lighter' | 'bigger' | 'harder' | 'stay'
  on: string
  estimate: Cost
  target?: Target
  note?: string
  isApplied: boolean
  actual?: Cost
}

export type ContextAlert = { tokens: number; on: string; cachedUsd: number; coldUsd: number; isCold: boolean }

declare module 'claude-code' {
  interface PluginState {
    'model-fit': { advice: Advice | null; context: ContextAlert | null }
  }
}
