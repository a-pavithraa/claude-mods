export type Question = {
  ask: string
  answer: string
  isShown: boolean
  knew?: boolean
}

export type Quiz = {
  status: 'idle' | 'asking' | 'ready' | 'failed'
  note?: string
  questions: Question[]
}

declare module 'claude-code' {
  interface PluginState {
    'quiz-me': { quiz: Quiz }
  }
}
