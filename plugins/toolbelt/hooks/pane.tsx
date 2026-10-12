import type { Elements, RenderInput } from 'claude-code'

import type { Confirm, Disabled, Notice, Unit, UnitKind } from '../types'
import { disableOf, removeOf } from './actions'
import { agoText, barText, countParts, dayText, keyOf, pluralSkills, skillsText, tierOf, tokenText, tokensOf, totalText } from './usage'
import type { Tier } from './usage'

export type PaneView = {
  units: Unit[]
  disabled: Disabled[]
  confirm: Confirm | null
  notice: Notice
  page: number
  days: number
  isCounted: boolean
  /** Characters the whole inventory adds to each prompt. */
  total: number
  /** When tracking of server calls began. */
  since: number
  now: number
  home: string
}

export type PaneActions = {
  ask: (key: string, step: 'disable' | 'remove') => Promise<unknown>
  cancel: () => Promise<unknown>
  run: (unit: Unit, step: 'disable' | 'remove') => Promise<unknown>
  keep: (unit: Unit) => Promise<unknown>
  enable: (held: Disabled) => Promise<unknown>
  turn: (page: number) => Promise<unknown>
  forget: (held: Disabled) => Promise<unknown>
}

export const PAGE_UNITS = 8
const SHARE_CELLS = 12
const UNIT_CELLS = 8
const SKILLS_SHOWN = 5

const HEADINGS: Record<UnitKind, string> = { plugin: 'PLUGINS', skill: 'SKILLS', mcp: 'MCP SERVERS' }

const GLYPHS: Record<Tier, string> = { high: '✦', mid: '✦', low: '·' }

/** The priority signal: dear units draw in `warning`, middling ones in `claude`, cheap ones dim. */
const tintOf = (tier: Tier) => (tier === 'high' ? { color: 'warning' as const } : tier === 'mid' ? { color: 'claude' as const } : { dimColor: true })

function detailOf(unit: Unit, view: PaneView) {
  const lastUsed = unit.lastAt === undefined ? 'never used' : `last used ${agoText(unit.lastAt, view.now)}`

  if (unit.kind === 'plugin') return `${pluralSkills(unit.skills.length)} · ${lastUsed}`
  if (unit.kind === 'skill') return lastUsed

  return `${unit.scope} · ${unit.lastAt === undefined ? `no calls since ${dayText(view.since)}` : `last called ${agoText(unit.lastAt, view.now)}`}`
}

const bareSkills = (unit: Unit) => unit.skills.map(skill => (skill.startsWith(`${unit.name}:`) ? skill.slice(unit.name.length + 1) : skill))

export function paneOf(ui: Elements[RenderInput<'Pane'>['surface']], view: PaneView, act: PaneActions) {
  const { Box, Button, Text } = ui
  const { confirm } = view
  const pages = Math.max(1, Math.ceil(view.units.length / PAGE_UNITS))
  const page = Math.min(view.page, pages - 1)
  const shown = view.units.slice(page * PAGE_UNITS, (page + 1) * PAGE_UNITS)
  const dearest = Math.max(1, ...view.units.map(unit => unit.cost))
  const unusedCost = view.units.reduce((sum, unit) => sum + unit.cost, 0)
  const share = view.total === 0 ? 0 : unusedCost / view.total
  const bar = barText(share, SHARE_CELLS)

  return (
    <Box flexDirection="column">
      {view.units.length === 0 ? (
        <Box flexDirection="column">
          <Text color="success">✓ Nothing unused.</Text>
          <Text dimColor wrap="wrap">{`Every plugin, skill and server was used in the last ${view.days} days.`}</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Box gap={1}>
              <Text color="claude">✦</Text>
              <Text bold>Toolbelt</Text>
            </Box>
            <Text dimColor>{`unused ${view.days} days`}</Text>
          </Box>
          <Text wrap="wrap">{`~${totalText(view.units)} tokens ride in every prompt for things you don't use`}</Text>
          <Box>
            <Text color="claude">{bar.filled}</Text>
            <Text dimColor>{bar.empty}</Text>
            <Text dimColor wrap="truncate-end">{`  ${Math.round(share * 100)}% of your listing · ${countParts(view.units).join(' · ')}`}</Text>
          </Box>
        </Box>
      )}
      {!view.isCounted && <Text color="warning" wrap="wrap">Can't read Claude Code's usage counters, so skills are not judged.</Text>}
      {view.notice.text !== '' && <Text color={view.notice.isError ? 'error' : 'success'} wrap="wrap">{view.notice.text}</Text>}
      {shown.map((unit, at) => {
        const key = keyOf(unit.kind, unit.name)
        const tier = tierOf(tokensOf(unit.cost))
        const tint = tintOf(tier)
        const bars = barText(unit.cost / dearest, UNIT_CELLS)
        const disable = disableOf(unit, view.home)
        const remove = removeOf(unit)
        const pending = confirm?.key === key ? confirm : null
        const step = pending === null ? undefined : pending.step === 'disable' ? disable : remove
        const isSectionStart = at === 0 || shown[at - 1]?.kind !== unit.kind
        const count = view.units.filter(one => one.kind === unit.kind).length

        return (
          <Box key={key} flexDirection="column">
            {isSectionStart && (
              <Box marginTop={1} justifyContent="space-between">
                <Text bold dimColor>{`${HEADINGS[unit.kind]} · ${count}`}</Text>
                {at === 0 && pages > 1 && (
                  <Box gap={1}>
                    <Button key="prev" plain label="◀" onPress={() => act.turn(Math.max(0, page - 1))} />
                    <Text dimColor>{`${page + 1} of ${pages}`}</Text>
                    <Button key="next" plain label="▶" onPress={() => act.turn(Math.min(pages - 1, page + 1))} />
                  </Box>
                )}
              </Box>
            )}
            <Box marginTop={1} justifyContent="space-between">
              <Box gap={1}>
                <Text {...tint}>{GLYPHS[tier]}</Text>
                <Text bold wrap="truncate-end">{unit.name}</Text>
              </Box>
              <Box flexShrink={0}>
                <Text dimColor>{`~${tokenText(tokensOf(unit.cost))} tok`}</Text>
              </Box>
            </Box>
            <Box paddingLeft={2}>
              <Text {...tint}>{bars.filled}</Text>
              <Text dimColor>{bars.empty}</Text>
              <Text dimColor wrap="truncate-end">{`  ${detailOf(unit, view)}`}</Text>
            </Box>
            {unit.kind === 'plugin' && (
              <Box paddingLeft={2}>
                <Text dimColor wrap="truncate-end">{skillsText(bareSkills(unit), SKILLS_SHOWN)}</Text>
              </Box>
            )}
            {pending !== null && step !== undefined ? (
              <Box flexDirection="column" borderStyle="round" borderColor={pending.step === 'remove' ? 'error' : 'warning'} paddingX={1}>
                <Text wrap="wrap">{step.question}</Text>
                <Box gap={1}>
                  <Button key={`yes:${key}`} variant="primary" label="Yes" onPress={() => act.run(unit, pending.step)} />
                  <Button key={`no:${key}`} plain label="Cancel" onPress={() => act.cancel()} />
                </Box>
              </Box>
            ) : (
              <Box paddingLeft={2} gap={1} flexWrap="wrap">
                {disable !== undefined && <Button key={`disable:${key}`} variant="secondary" label={disable.label} onPress={() => act.ask(key, 'disable')} />}
                {remove !== undefined && (
                  <Button
                    key={`remove:${key}`}
                    {...(disable === undefined ? { variant: 'secondary' as const } : { plain: true, dimColor: true })}
                    label={remove.label}
                    onPress={() => act.ask(key, 'remove')}
                  />
                )}
                <Button key={`keep:${key}`} plain dimColor label="Keep" onPress={() => act.keep(unit)} />
              </Box>
            )}
          </Box>
        )
      })}
      {view.disabled.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>SWITCHED OFF BY TOOLBELT</Text>
          {view.disabled.map(held => (
            <Box key={held.key} gap={1}>
              <Text>{held.name}</Text>
              <Button key={`enable:${held.key}`} plain label="Enable" onPress={() => act.enable(held)} />
              <Button key={`forget:${held.key}`} plain dimColor label="Forget" onPress={() => act.forget(held)} />
            </Box>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor wrap="wrap">Changes apply in the next session.</Text>
      </Box>
    </Box>
  )
}
