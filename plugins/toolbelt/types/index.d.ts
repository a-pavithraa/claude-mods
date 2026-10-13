export type Kind = 'skill' | 'mcp'
export type Scope = 'user' | 'project' | 'local' | 'plugin' | 'builtin' | 'unknown'

/** One skill or MCP server that adds text to every prompt. */
export type Item = {
  kind: Kind
  name: string
  scope: Scope
  /** The plugin that carries the skill, when it comes from one. */
  plugin?: string
  /** Characters it adds to each prompt: a skill's description, a server's listed tools. */
  cost: number
}

/** `byProject` holds the last call in each repo: project and local servers are unused per repo. */
export type Use = { count: number; lastAt: number; byProject?: Record<string, number> }
export type Uses = Record<string, Use>

export type UnitKind = 'duplicate' | 'plugin' | 'skill' | 'mcp'

/** One thing the person can switch off in one step: a plugin with all its skills, a user skill, a server, or the spare copy of something loaded twice. */
export type Unit = {
  kind: UnitKind
  name: string
  /** The `name@marketplace` the CLI acts on: a plugin's, absent when two installs share the name; a duplicate's, the copy to drop. */
  id?: string
  scope: Scope
  /** Characters added to each prompt; for a plugin, the sum over its skills. */
  cost: number
  /** For a plugin: its skills, dearest first. */
  skills: string[]
  uses: number
  lastAt?: number
  /** For a duplicate: which copy this is and where the other one lives. */
  detail?: string
  /** For a server: the config names it but it gave this session no tools. */
  isDown?: boolean
}

/** What Toolbelt itself switched off, so the pane can offer the way back. */
export type Disabled = {
  key: string
  name: string
  how: 'plugin' | 'folder'
  plugin?: string
  from?: string
  to?: string
}

/** What the pane last reported; a failure draws in the error colour. */
export type Notice = { text: string; isError: boolean }

/** A pending second click: which unit, and whether it is a disable or a removal. */
export type Confirm = { key: string; step: 'disable' | 'remove' }

/** Whether Claude Code's usage counters could be read; without them skills are not judged. */
export type Health = { isCounted: boolean }

declare module 'claude-code' {
  interface PluginState {
    toolbelt: {
      units: Unit[]
      disabled: Disabled[]
      confirm: Confirm | null
      notice: Notice
      page: number
      health: Health
      /** Characters the whole inventory adds to each prompt, used or not. */
      total: number
    }
  }
}
