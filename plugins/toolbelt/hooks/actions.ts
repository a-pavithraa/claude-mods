import type { Disabled, Unit } from '../types'
import { isSynced, keyOf, pluralSkills } from './usage'

export type Step = {
  /** The pane's button. */
  label: string
  /** What the confirm line asks. */
  question: string
  argv?: string[]
  /** A user skill is switched off by moving its folder. */
  move?: { from: string; to: string }
  record?: Disabled
}

export const pluginKey = (plugin: string) => keyOf('plugin', plugin)

const skillsText = (unit: Unit) => pluralSkills(unit.skills.length)

/** Disable is the safe button. A server has no disable in the CLI, so it only offers removal. */
export function disableOf(unit: Unit, home: string): Step | undefined {
  if (unit.kind === 'plugin') {
    return {
      label: 'Disable',
      question: `Disable ${unit.name}? Its ${skillsText(unit)} go with it. It stays installed.`,
      argv: ['claude', 'plugin', 'disable', unit.id ?? unit.name],
      record: { key: pluginKey(unit.name), name: unit.name, how: 'plugin', plugin: unit.id ?? unit.name },
    }
  }

  if (unit.kind === 'duplicate' && unit.id !== undefined) {
    return {
      label: 'Disable',
      question: `Disable ${unit.id}? The other copy of ${unit.name} stays. This one stays installed.`,
      argv: ['claude', 'plugin', 'disable', unit.id],
      record: { key: keyOf('duplicate', unit.name), name: unit.id, how: 'plugin', plugin: unit.id },
    }
  }

  if ((unit.kind === 'skill' || unit.kind === 'duplicate') && unit.scope === 'user') {
    const from = `${home}/.claude/skills/${unit.name}`
    const to = `${home}/.claude/skills-disabled/${unit.name}`

    return {
      label: unit.kind === 'duplicate' ? 'Disable my copy' : 'Disable',
      question: `Move ${unit.name} to ~/.claude/skills-disabled? It comes back with Enable.`,
      move: { from, to },
      record: { key: keyOf('skill', unit.name), name: unit.name, how: 'folder', from, to },
    }
  }

  return undefined
}

/** Removal is the only button for a server, which cannot be disabled. */
export function removeOf(unit: Unit): Step | undefined {
  if (unit.kind === 'mcp' && (unit.scope === 'user' || unit.scope === 'project' || unit.scope === 'local')) {
    return {
      label: 'Remove',
      question: `Remove ${unit.name}? Its env and keys go too. No undo.`,
      argv: ['claude', 'mcp', 'remove', unit.name, '-s', unit.scope],
    }
  }

  if (unit.kind === 'duplicate' && unit.id !== undefined) {
    return {
      label: 'Uninstall…',
      question: `Uninstall ${unit.id}? The other copy of ${unit.name} stays. No undo.`,
      argv: ['claude', 'plugin', 'uninstall', unit.id],
    }
  }

  if (unit.kind === 'plugin' && !isSynced(unit.id)) {
    return {
      label: 'Uninstall…',
      question: `Uninstall ${unit.name}? Its ${skillsText(unit)} and settings go too. No undo.`,
      argv: ['claude', 'plugin', 'uninstall', unit.id ?? unit.name],
    }
  }

  return undefined
}

export function enableOf(held: Disabled): Step {
  if (held.how === 'plugin' && held.plugin !== undefined) {
    return { label: 'Enable', question: '', argv: ['claude', 'plugin', 'enable', held.plugin] }
  }

  return { label: 'Enable', question: '', move: { from: held.to ?? '', to: held.from ?? '' } }
}

/** Windows starts the CLI through the shell; a bare spawn fails with ENOENT. */
export const argvFor = (argv: string[], isWindows: boolean) => (isWindows ? ['cmd.exe', '/d', '/c', ...argv] : argv)

export const moveArgv = (move: { from: string; to: string }, isWindows: boolean) =>
  isWindows
    ? ['cmd.exe', '/d', '/c', 'move', '/Y', move.from.split('/').join('\\'), move.to.split('/').join('\\')]
    : ['mv', move.from, move.to]
